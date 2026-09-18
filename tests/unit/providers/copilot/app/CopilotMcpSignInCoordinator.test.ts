import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution/ProviderExecutionLifecycleRegistry';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { CopilotMcpSignInCoordinator } from '@/providers/copilot/app/CopilotMcpSignInCoordinator';
import { updateCopilotHostResources } from '@/providers/copilot/resources/CopilotHostResources';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';
import { getHostnameKey } from '@/utils/env';

import { createDeferred, FakeCopilotSdkClient, FakeCopilotSdkRuntime } from '../sdk/FakeCopilotSdkRuntime';

let root = '';

beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'claudian-mcp-signin-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function host(configPath: string): ProviderHost {
  const settings: Record<string, unknown> = {};
  const registry = new ProviderExecutionLifecycleRegistry();
  updateCopilotProviderSettings(settings, {
    enabled: true,
    discoveredModels: [{
      rawId: 'gpt-5-mini', displayName: 'GPT-5 mini',
      reasoningEfforts: [], supportsReasoning: false, supportsVision: false,
    }],
    visibleModels: ['gpt-5-mini'],
    resourcesByHost: {
      [getHostnameKey()]: {
        additionalMcpConfigPaths: [], additionalSkillRoots: [], selectedSkillPaths: [],
        rememberMcpSignIns: true,
        selectedMcpServers: [{ configPath, name: 'notes' }, { configPath, name: 'unselected-for-login' }],
      },
    },
  });
  return {
    app: { vault: { adapter: { basePath: root } } },
    executionLifecycleRegistry: registry,
    getResolvedProviderCliPath: async () => '/usr/bin/copilot',
    runProviderExecutionTransition: registry.runTransition.bind(registry),
    settings,
  } as unknown as ProviderHost;
}

it('authenticates only the chosen server using native credential caching and no tools', async () => {
  await mkdir(path.join(root, '.git'));
  const repositorySkill = path.join(root, '.github', 'skills', 'repo-review', 'SKILL.md');
  await mkdir(path.dirname(repositorySkill), { recursive: true });
  await writeFile(repositorySkill, '---\nname: repo-review\n---\n');
  const configPath = path.join(root, 'mcp.json');
  await writeFile(configPath, JSON.stringify({ mcpServers: {
    notes: { type: 'http', url: 'https://example.test/mcp' },
    'unselected-for-login': { type: 'http', url: 'https://other.example.test/mcp' },
  } }));
  const client = new FakeCopilotSdkClient({
    onSessionCreated: session => {
      Object.assign(session, { signInMcpServer: async () => ({}) });
    },
  });
  const service = new CopilotMcpSignInCoordinator(host(configPath), {
    runtime: new FakeCopilotSdkRuntime(() => client),
  });
  const reference = { configPath, name: 'notes' };
  await service.signIn(reference);

  expect(service.getState(reference)).toEqual({ phase: 'connected' });
  expect(client.lastSession?.config.availableTools).toEqual([]);
  expect(client.lastSession?.config.resources).toEqual({
    mcpOAuthTokenStorage: 'persistent',
    mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp' } },
    skillDirectories: [],
  });
  expect(client.deletedSessions).toEqual([client.lastSession?.sessionId]);
  expect(client.stopped).toBe(1);
  await service.dispose();
});

it('waits for the chosen server to connect rather than treating an OAuth URL as success', async () => {
  const configPath = path.join(root, 'mcp.json');
  await writeFile(configPath, JSON.stringify({ mcpServers: {
    notes: { type: 'http', url: 'https://example.test/mcp' },
  } }));
  const client = new FakeCopilotSdkClient({
    onSessionCreated: session => {
      Object.assign(session, { signInMcpServer: async () => ({
        authorizationUrl: 'https://login.example.test/authorize?state=synthetic',
      }) });
    },
  });
  const service = new CopilotMcpSignInCoordinator(host(configPath), {
    runtime: new FakeCopilotSdkRuntime(() => client),
  });
  const reference = { configPath, name: 'notes' };
  const waiting = createDeferred();
  service.subscribe(() => { if (service.getState(reference).phase === 'waiting') waiting.resolve(); });
  const signingIn = service.signIn(reference);
  await waiting.promise;

  expect(service.getState(reference).phase).toBe('waiting');
  client.lastSession?.emit({
    id: 'connected-event', parentId: null, timestamp: new Date().toISOString(),
    type: 'session.mcp_server_status_changed', ephemeral: true,
    data: { serverName: 'notes', status: 'connected' },
  });
  await signingIn;

  expect(service.getState(reference)).toEqual({ phase: 'connected' });
  expect(client.stopped).toBe(1);
  await service.dispose();
});

it.each([
  { stopFails: false, phase: 'idle' },
  { stopFails: true, phase: 'error' },
])('cancels browser waiting without hiding cleanup failure=$stopFails', async ({ stopFails, phase }) => {
  const configPath = path.join(root, 'mcp.json');
  await writeFile(configPath, JSON.stringify({ mcpServers: {
    notes: { type: 'http', url: 'https://example.test/mcp' },
  } }));
  const client = new FakeCopilotSdkClient({
    stopBehavior: async () => { if (stopFails) throw new Error('The MCP runtime could not be stopped.'); },
    onSessionCreated: session => {
      Object.assign(session, { signInMcpServer: async () => ({
        authorizationUrl: 'https://login.example.test/authorize',
      }) });
    },
  });
  const service = new CopilotMcpSignInCoordinator(host(configPath), {
    runtime: new FakeCopilotSdkRuntime(() => client),
  });
  const reference = { configPath, name: 'notes' };
  const waiting = createDeferred();
  service.subscribe(() => { if (service.getState(reference).phase === 'waiting') waiting.resolve(); });
  const signingIn = service.signIn(reference);
  await waiting.promise;
  const results = await Promise.allSettled([service.cancel(reference), signingIn]);

  expect(service.getState(reference)).toMatchObject({ phase });
  expect(client.deletedSessions).toEqual([client.lastSession?.sessionId]);
  expect(client.stopped).toBe(1);
  const failure = expect.objectContaining({ message: expect.stringContaining('could not be stopped') });
  const expected = stopFails
    ? { status: 'rejected', reason: failure }
    : { status: 'fulfilled', value: undefined };
  expect(results[0]).toEqual(expected);
  expect(results[1].status).toBe('fulfilled');
  expect(await Promise.allSettled([service.dispose(), service.dispose()])).toEqual([expected, expected]);
});

it('refuses authentication for a source that was not selected', async () => {
  const configPath = path.join(root, 'mcp.json');
  const runtime = new FakeCopilotSdkRuntime();
  const service = new CopilotMcpSignInCoordinator(host(configPath), { runtime });
  const reference = { configPath, name: 'not-selected' };
  await service.signIn(reference);

  expect(service.getState(reference)).toEqual({
    phase: 'error', message: 'Select this MCP server before signing in.',
  });
  expect(runtime.clients).toEqual([]);
  await service.dispose();
});

it.each(['identity', 'client', 'session'] as const)(
  'does not authorize persistent sign-in after opt-out during %s acquisition',
  async acquisition => {
    const configPath = path.join(root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp' } },
    }));
    const entered = createDeferred();
    const release = createDeferred();
    const gate = async () => { entered.resolve(); await release.promise; };
    const client = new FakeCopilotSdkClient({
      sessionGate: acquisition === 'session' ? gate : undefined,
    });
    const providerHost = host(configPath);
    if (acquisition === 'identity') {
      providerHost.getResolvedProviderCliPath = async () => { await gate(); return '/usr/bin/copilot'; };
    }
    const transitioning = createDeferred();
    providerHost.executionLifecycleRegistry.registerTransitionHook('copilot', {
      beforeTransition: () => { transitioning.resolve(); },
    });
    const runtime = new FakeCopilotSdkRuntime(async () => {
      if (acquisition === 'client') await gate();
      return client;
    });
    const service = new CopilotMcpSignInCoordinator(providerHost, { runtime });
    const reference = { configPath, name: 'notes' };
    const signingIn = service.signIn(reference);
    try {
      await entered.promise;
      const optOut = providerHost.runProviderExecutionTransition(['copilot'], async () => {
        updateCopilotProviderSettings(providerHost.settings, {
          resourcesByHost: updateCopilotHostResources(providerHost.settings, { rememberMcpSignIns: false }),
        });
      });
      await transitioning.promise;
      release.resolve();
      await Promise.all([signingIn, optOut]);

      expect(runtime.clients.flatMap(current => current.createdSessions.flatMap(session => session.mcpSignIns)))
        .toEqual([]);
      expect(client.createdSessions).toHaveLength(acquisition === 'session' ? 1 : 0);
      expect(service.getState(reference).phase).not.toBe('connected');
    } finally {
      release.resolve();
      await service.dispose();
    }
  },
);

it.each(['reopen', 'cancel', 'dispose', 'transition'] as const)(
  'serializes immediate reopen behind cancelled cleanup, then honors %s',
  async next => {
    const configPath = path.join(root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp' } },
    }));
    const waiting = createDeferred();
    const stopping = createDeferred();
    const release = createDeferred();
    const first = new FakeCopilotSdkClient({
      onSessionCreated: session => {
        session.mcpSignInBehavior = async () => ({ authorizationUrl: 'https://login.example.test/authorize' });
      },
      stopBehavior: async () => { stopping.resolve(); await release.promise; },
    });
    const second = new FakeCopilotSdkClient();
    const runtime: FakeCopilotSdkRuntime = new FakeCopilotSdkRuntime(() => runtime.clients.length === 0 ? first : second);
    const providerHost = host(configPath);
    const service = new CopilotMcpSignInCoordinator(providerHost, { runtime });
    const reference = { configPath, name: 'notes' };
    service.subscribe(() => { if (service.getState(reference).phase === 'waiting') waiting.resolve(); });
    const signingIn = service.signIn(reference);
    try {
      await waiting.promise;
      const closing = service.cancel(reference);
      await stopping.promise;
      const reopened = service.signIn(reference);
      const closedAgain = next === 'reopen' ? Promise.resolve()
        : next === 'transition' ? providerHost.runProviderExecutionTransition(['copilot'], async () => {})
        : service[next]();
      expect(runtime.clients).toEqual([first]);
      release.resolve();
      await Promise.all([signingIn, closing, reopened, closedAgain]);

      expect(service.getState(reference)).toEqual({ phase: next === 'reopen' ? 'connected' : 'idle' });
      expect(runtime.clients.flatMap(client => client.createdSessions.flatMap(session => session.mcpSignIns)))
        .toEqual(next === 'reopen' ? ['notes', 'notes'] : ['notes']);
    } finally {
      release.resolve();
      await service.dispose();
    }
  },
);

it('preserves a native OAuth failure alongside cleanup failure when cancellation races its response', async () => {
  const configPath = path.join(root, 'mcp.json');
  await writeFile(configPath, JSON.stringify({
    mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp' } },
  }));
  const entered = createDeferred();
  const login = createDeferred<{ authorizationUrl?: string }>();
  const client = new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpSignInBehavior = () => { entered.resolve(); return login.promise; };
    },
    stopBehavior: async () => { throw new Error('Native sign-in shutdown failed.'); },
  });
  const service = new CopilotMcpSignInCoordinator(host(configPath), {
    runtime: new FakeCopilotSdkRuntime(() => client),
  });
  const reference = { configPath, name: 'notes' };
  const signingIn = service.signIn(reference);
  await entered.promise;
  const closing = service.cancel(reference);
  login.reject(new Error('Native OAuth initiation failed.'));
  const [result] = await Promise.allSettled([closing, signingIn]);

  expect(service.getState(reference)).toEqual({
    phase: 'error',
    message: expect.stringContaining('Native OAuth initiation failed.'),
  });
  expect(result).toMatchObject({
    status: 'rejected',
    reason: expect.objectContaining({ message: expect.stringContaining('Native sign-in shutdown failed.') }),
  });
  await expect(service.dispose()).rejects.toThrow('Native OAuth initiation failed.');
});

it.each(['refresh-failure', 'cancel-during-refresh', 'cancel-during-cleanup'] as const)(
  'preserves confirmed native authentication through %s',
  async outcome => {
    const configPath = path.join(root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp' } },
    }));
    const entered = createDeferred();
    const release = createDeferred();
    const client = new FakeCopilotSdkClient({
      stopBehavior: outcome === 'cancel-during-cleanup'
        ? async () => { entered.resolve(); await release.promise; }
        : undefined,
    });
    const providerHost = host(configPath);
    if (outcome !== 'cancel-during-cleanup') {
      providerHost.executionLifecycleRegistry.registerTransitionHook('copilot', {
        beforeTransition: async () => {
          entered.resolve();
          await release.promise;
          if (outcome === 'refresh-failure') throw new Error('Existing chat runtime could not be refreshed.');
        },
      });
    }
    const service = new CopilotMcpSignInCoordinator(providerHost, {
      runtime: new FakeCopilotSdkRuntime(() => client),
    });
    const reference = { configPath, name: 'notes' };
    const signingIn = service.signIn(reference);
    await entered.promise;
    const cancelling = outcome === 'refresh-failure' ? Promise.resolve() : service.cancel(reference);
    release.resolve();
    await Promise.all([signingIn, cancelling]);

    expect(client.lastSession?.mcpSignIns).toEqual(['notes']);
    const warning = expect.stringContaining('Existing chat runtime could not be refreshed.');
    expect(service.getState(reference)).toEqual(outcome === 'refresh-failure'
      ? { phase: 'connected', warning }
      : { phase: 'connected' });
    const failure = expect.objectContaining({ message: warning });
    expect(await Promise.allSettled([service.dispose()])).toEqual(outcome === 'refresh-failure'
      ? [{ status: 'rejected', reason: failure }]
      : [{ status: 'fulfilled', value: undefined }]);
  },
);

it('cancels browser authorization before a selection-removal transition commits', async () => {
  const configPath = path.join(root, 'mcp.json');
  await writeFile(configPath, JSON.stringify({
    mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp' } },
  }));
  const waiting = createDeferred();
  const client = new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpSignInBehavior = async () => ({ authorizationUrl: 'https://login.example.test/authorize' });
    },
  });
  const providerHost = host(configPath);
  const service = new CopilotMcpSignInCoordinator(providerHost, {
    runtime: new FakeCopilotSdkRuntime(() => client),
  });
  const reference = { configPath, name: 'notes' };
  service.subscribe(() => { if (service.getState(reference).phase === 'waiting') waiting.resolve(); });
  const signingIn = service.signIn(reference);
  await waiting.promise;
  await providerHost.runProviderExecutionTransition(['copilot'], async () => {
    expect(client.stopped).toBe(1);
    updateCopilotProviderSettings(providerHost.settings, {
      resourcesByHost: updateCopilotHostResources(providerHost.settings, { selectedMcpServers: [] }),
    });
  });
  await signingIn;

  expect(service.getState(reference)).toMatchObject({
    phase: 'error', message: expect.stringContaining('settings changed'),
  });
  expect(client.deletedSessions).toEqual([client.lastSession?.sessionId]);
  await service.dispose();
});

it('refuses new authorization while runtime settings are committing', async () => {
  const configPath = path.join(root, 'mcp.json');
  const providerHost = host(configPath);
  const runtime = new FakeCopilotSdkRuntime();
  const service = new CopilotMcpSignInCoordinator(providerHost, { runtime });
  const entered = createDeferred();
  const release = createDeferred();
  const transition = providerHost.runProviderExecutionTransition(['copilot'], async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const reference = { configPath, name: 'notes' };
  await service.signIn(reference);
  release.resolve();
  await transition;

  expect(runtime.clients).toEqual([]);
  expect(service.getState(reference)).toMatchObject({
    phase: 'error', message: expect.stringContaining('settings are changing'),
  });
  await service.dispose();
});

it.each(['https://user:secret@login.example.test/authorize', 'http://login.example.test/authorize', 'file:///tmp/authorize'])(
  'refuses unsafe native OAuth URL %s',
  async authorizationUrl => {
    const configPath = path.join(root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp' } },
    }));
    const client = new FakeCopilotSdkClient({
      onSessionCreated: session => { session.mcpSignInBehavior = async () => ({ authorizationUrl }); },
    });
    const service = new CopilotMcpSignInCoordinator(host(configPath), {
      runtime: new FakeCopilotSdkRuntime(() => client),
    });
    const reference = { configPath, name: 'notes' };
    await service.signIn(reference);

    expect(service.getState(reference)).toEqual({
      phase: 'error', message: 'The MCP server returned an unsupported sign-in URL.',
    });
    expect(client.stopped).toBe(1);
    await service.dispose();
  },
);

it('times out browser waiting without treating the authorization URL as authenticated', async () => {
  const configPath = path.join(root, 'mcp.json');
  await writeFile(configPath, JSON.stringify({
    mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp' } },
  }));
  const waiting = createDeferred();
  const client = new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpSignInBehavior = async () => ({ authorizationUrl: 'http://127.0.0.1:1234/authorize' });
    },
  });
  const service = new CopilotMcpSignInCoordinator(host(configPath), {
    runtime: new FakeCopilotSdkRuntime(() => client),
  });
  const reference = { configPath, name: 'notes' };
  service.subscribe(() => { if (service.getState(reference).phase === 'waiting') waiting.resolve(); });
  jest.useFakeTimers();
  try {
    const signingIn = service.signIn(reference);
    await waiting.promise;
    await jest.advanceTimersByTimeAsync(300_000);
    await signingIn;

    expect(service.getState(reference)).toEqual({
      phase: 'error', message: 'MCP sign-in timed out. Try again when you are ready.',
    });
    expect(client.deletedSessions).toEqual([client.lastSession?.sessionId]);
    expect(client.stopped).toBe(1);
  } finally {
    await service.dispose();
    jest.useRealTimers();
  }
});
