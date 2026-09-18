import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution/ProviderExecutionLifecycleRegistry';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { CopilotMcpReadinessCoordinator } from '@/providers/copilot/app/CopilotMcpReadinessCoordinator';
import { updateCopilotHostResources } from '@/providers/copilot/resources/CopilotHostResources';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';

import { createDeferred, FakeCopilotSdkClient, FakeCopilotSdkRuntime } from '../sdk/FakeCopilotSdkRuntime';

let root = '';
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'claudian-mcp-ready-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function setup(runtime: FakeCopilotSdkRuntime) {
  const configPath = path.join(root, 'mcp.json');
  const servers = {
    first: { type: 'http', url: 'https://first.example.test/mcp' },
    second: { type: 'http', url: 'https://second.example.test/mcp' },
    disabled: { type: 'http', url: 'https://disabled.example.test/mcp' },
  };
  await writeFile(configPath, JSON.stringify({ mcpServers: servers }));
  const references = ['first', 'second'].map(name => ({ configPath, name }));
  const settings: Record<string, unknown> = {};
  updateCopilotProviderSettings(settings, {
    enabled: true,
    discoveredModels: [{
      rawId: 'gpt-5-mini', displayName: 'GPT-5 mini',
      reasoningEfforts: [], supportsReasoning: false, supportsVision: false,
    }],
    visibleModels: ['gpt-5-mini'],
    resourcesByHost: updateCopilotHostResources(settings, {
      selectedMcpServers: references, rememberMcpSignIns: true,
    }),
  });
  const registry = new ProviderExecutionLifecycleRegistry();
  let cliPath = '/usr/bin/copilot';
  const host = {
    app: { vault: { adapter: { basePath: root } } },
    executionLifecycleRegistry: registry,
    getResolvedProviderCliPath: async () => cliPath,
    settings,
  } as unknown as ProviderHost;
  const service = new CopilotMcpReadinessCoordinator(host, { runtime });
  return { configPath, references, registry, service, settings, setCliPath: (value: string) => { cliPath = value; } };
}

it('reports each isolated server, including empty tools, without starting disabled servers or granting tools', async () => {
  const entered = createDeferred();
  const listing = createDeferred();
  const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpReadinessBehavior = async name => {
        if (name === 'first') {
          entered.resolve();
          await listing.promise;
          throw new Error('tools/list refused');
        }
        return { phase: 'connected', toolCount: 0 };
      };
    },
  }));
  const { references, service } = await setup(runtime);
  const checking = service.check();
  await entered.promise;
  expect(service.getState(references[0])).toEqual({ phase: 'checking' });
  expect(service.getState(references[1])).toEqual({ phase: 'queued' });
  expect(service.check()).toBe(checking);
  listing.resolve();
  await checking;

  expect(service.getState(references[0])).toMatchObject({ phase: 'error', message: expect.stringContaining('tools/list refused') });
  expect(service.getState(references[1])).toEqual({ phase: 'connected', toolCount: 0 });
  expect(runtime.clients.flatMap(client => client.createdSessions.map(session => ({
    servers: Object.keys(session.config.resources?.mcpServers ?? {}),
    tools: session.config.availableTools,
    skills: session.config.resources?.skillDirectories,
    cache: session.config.resources?.mcpOAuthTokenStorage,
    permission: session.config.permissionMode,
    prompts: session.prompts,
    signIns: session.mcpSignIns,
  })))).toEqual(['first', 'second'].map(name => ({
    servers: [name], tools: [], skills: [], cache: 'persistent', permission: 'ask', prompts: [], signIns: [],
  })));
  for (const client of runtime.clients) {
    expect(client.deletedSessions).toEqual([client.lastSession?.sessionId]);
    expect(client.stopped).toBe(1);
  }
  await service.dispose();
});

it.each(['unselect', 'config', 'config-failure', 'runtime', 'cancel', 'dispose', 'transition'] as const)(
  'fences readiness after %s while tools/list is pending',
  async change => {
    const entered = createDeferred();
    const listing = createDeferred();
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      onSessionCreated: session => {
        session.mcpReadinessBehavior = async () => {
          entered.resolve();
          await listing.promise;
          if (change === 'config-failure') throw new Error('stale failure');
          return { phase: 'connected', toolCount: 3 };
        };
      },
    }));
    const { configPath, references, registry, service, settings, setCliPath } = await setup(runtime);
    const checking = service.check(references[0]);
    await entered.promise;
    let releasing: Promise<void> | undefined;
    if (change === 'unselect') {
      updateCopilotProviderSettings(settings, {
        resourcesByHost: updateCopilotHostResources(settings, { selectedMcpServers: [] }),
      });
    } else if (change === 'config' || change === 'config-failure') {
      await writeFile(configPath, '{"mcpServers":{}}');
    } else if (change === 'runtime') {
      setCliPath('/opt/copilot');
    } else if (change === 'transition') {
      releasing = registry.runTransition(['copilot'], async () => {});
    } else {
      releasing = service[change]();
    }
    listing.resolve();
    await checking;
    await releasing;

    expect(service.getState(references[0])).toEqual({ phase: 'unchecked' });
    expect(runtime.clients[0]?.stopped).toBe(1);
    await service.dispose();
  },
);

it('reports needs-auth without using cached-token presence as readiness, and permits explicit recheck', async () => {
  let ready = false;
  const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpReadinessBehavior = async () => ready
        ? { phase: 'connected', toolCount: 2 }
        : { phase: 'needs-auth' };
    },
  }));
  const { references, service } = await setup(runtime);
  await service.check(references[0]);
  expect(service.getState(references[0])).toEqual({ phase: 'needs-auth' });
  ready = true;
  await service.check(references[0]);
  expect(service.getState(references[0])).toEqual({ phase: 'connected', toolCount: 2 });
  await service.dispose();
});

it('surfaces cleanup failure instead of publishing ready', async () => {
  const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
    stopBehavior: async () => { throw new Error('runtime stop failed'); },
  }));
  const { references, service } = await setup(runtime);
  await service.check(references[0]);
  expect(service.getState(references[0])).toMatchObject({
    phase: 'error', message: expect.stringContaining('runtime stop failed'),
  });
  await service.dispose();
});

it('does not restart a deferred recheck after its settings view closes', async () => {
  const entered = createDeferred();
  const listing = createDeferred();
  const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpReadinessBehavior = async () => {
        entered.resolve();
        await listing.promise;
        return { phase: 'connected', toolCount: 1 };
      };
    },
  }));
  const { references, service } = await setup(runtime);
  const checking = service.check(references[0]);
  await entered.promise;
  const closing = service.cancel();
  const reopened = service.check(references[0]);
  const closedAgain = service.cancel();
  listing.resolve();
  await Promise.all([checking, closing, reopened, closedAgain]);

  expect(service.getState(references[0])).toEqual({ phase: 'unchecked' });
  expect(runtime.clients.every(client => client.stopped === 1)).toBe(true);
  await service.dispose();
});

it('surfaces cleanup failure during cancellation without publishing stale readiness', async () => {
  const entered = createDeferred();
  const listing = createDeferred();
  const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpReadinessBehavior = async () => {
        entered.resolve();
        await listing.promise;
        return { phase: 'connected', toolCount: 1 };
      };
    },
    stopBehavior: async () => { throw new Error('runtime stop failed'); },
  }));
  const { references, service } = await setup(runtime);
  const checking = service.check(references[0]);
  await entered.promise;
  const closing = service.cancel();
  listing.resolve();
  await Promise.all([
    expect(checking).rejects.toThrow('runtime stop failed'),
    expect(closing).rejects.toThrow('runtime stop failed'),
  ]);

  expect(service.getState(references[0])).toEqual({ phase: 'unchecked' });
  await service.dispose();
});
