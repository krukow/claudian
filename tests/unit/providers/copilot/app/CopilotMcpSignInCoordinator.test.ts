import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { CopilotMcpSignInCoordinator } from '@/providers/copilot/app/CopilotMcpSignInCoordinator';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';
import { getHostnameKey } from '@/utils/env';

import { createDeferred, FakeCopilotSdkClient, FakeCopilotSdkRuntime } from '../sdk/FakeCopilotSdkRuntime';

let root = '';

beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'claudian-mcp-signin-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function host(configPath: string): ProviderHost {
  const settings: Record<string, unknown> = {};
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
    getResolvedProviderCliPath: async () => '/usr/bin/copilot',
    runProviderExecutionTransition: async (_ids: unknown, mutate: () => Promise<void>) => mutate(),
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
  await service.cancel(reference);
  await signingIn;

  expect(service.getState(reference)).toMatchObject({ phase });
  expect(client.deletedSessions).toEqual([client.lastSession?.sessionId]);
  expect(client.stopped).toBe(1);
  await service.dispose();
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
