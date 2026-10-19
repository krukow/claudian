/**
 * @jest-environment jsdom
 */

jest.mock('obsidian', () => ({
  ...jest.requireActual('obsidian'),
  Notice: jest.fn(),
}));

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deserialize, serialize } from 'node:v8';

import { waitFor } from '@testing-library/dom';
import { Notice } from 'obsidian';

import { ChatModelSelectionCoordinator } from '@/app/settings/ChatModelSelectionCoordinator';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution/ProviderExecutionLifecycleRegistry';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ClaudianSettings } from '@/core/types';
import { registerBuiltInProviders } from '@/providers';
import { type CopilotWorkspaceServices, createCopilotWorkspaceServices } from '@/providers/copilot/app/CopilotWorkspaceServices';
import { updateCopilotHostResources } from '@/providers/copilot/resources/CopilotHostResources';
import type { CopilotMcpReadiness } from '@/providers/copilot/sdk/CopilotSdkPort';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';

import { createDeferred, FakeCopilotSdkClient, FakeCopilotSdkRuntime } from '../sdk/FakeCopilotSdkRuntime';

let root = '';
const services: CopilotWorkspaceServices[] = [];

beforeAll(() => {
  registerBuiltInProviders();
  global.structuredClone = <T>(value: T): T => deserialize(serialize(value)) as T;
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'claudian-mcp-background-'));
  jest.mocked(Notice).mockClear();
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose?.();
  document.body.replaceChildren();
  jest.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function setup(runtime: FakeCopilotSdkRuntime, openWindows: readonly Window[] = []) {
  const configPath = path.join(root, 'mcp.json');
  await writeFile(configPath, JSON.stringify({
    mcpServers: { notes: { type: 'http', url: 'https://notes.example.test/mcp' } },
  }));
  const reference = { configPath, name: 'notes' };
  const settings: Record<string, unknown> = {};
  updateCopilotProviderSettings(settings, {
    enabled: true,
    discoveredModels: [{
      rawId: 'gpt-5-mini', displayName: 'GPT-5 mini',
      reasoningEfforts: [], supportsReasoning: false, supportsVision: false,
    }],
    visibleModels: ['gpt-5-mini'],
    resourcesByHost: updateCopilotHostResources(settings, { selectedMcpServers: [reference] }),
  });
  const registry = new ProviderExecutionLifecycleRegistry();
  const settingsCoordinator = new SettingsCoordinator(settings as unknown as ClaudianSettings, async () => {});
  type WindowEventName = 'window-open' | 'window-close';
  type WindowListener = (container: unknown, win: Window) => void;
  const listeners = new Map<WindowEventName, Set<WindowListener>>();
  const workspaceEvents = {
    iterateAllLeaves: (visit: (leaf: { view: { containerEl: HTMLElement } }) => void) => {
      for (const win of openWindows) visit({ view: { containerEl: win.document.body } });
    },
    on: (name: WindowEventName, callback: WindowListener) => {
      const handlers = listeners.get(name) ?? new Set<WindowListener>();
      handlers.add(callback);
      listeners.set(name, handlers);
      return { name, callback };
    },
    offref: ({ name, callback }: { name: WindowEventName; callback: WindowListener }) => {
      listeners.get(name)?.delete(callback);
    },
  };
  const host = {
    app: { vault: { adapter: { basePath: root } }, workspace: workspaceEvents },
    chatModelSelection: new ChatModelSelectionCoordinator(settingsCoordinator),
    executionLifecycleRegistry: registry,
    getResolvedProviderCliPath: async () => '/usr/bin/copilot',
    mutateSettings: settingsCoordinator.mutate.bind(settingsCoordinator),
    mutateSettingsConditionally: settingsCoordinator.mutateConditionally.bind(settingsCoordinator),
    notifyProviderChatOptionsChanged: () => {},
    runProviderExecutionTransition: registry.runTransition.bind(registry),
    settings,
  } as unknown as ProviderHost;
  const workspace = createCopilotWorkspaceServices(host, { runtime });
  services.push(workspace);
  return {
    configPath, reference, registry, service: workspace.mcpReadiness, settings, workspace,
    windowEvent: (name: WindowEventName, win: Window) => {
      for (const listener of listeners.get(name) ?? []) listener({}, win);
    },
  };
}

it('checks on startup without a settings view and notifies when MCP sign-in is needed', async () => {
  const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpReadinessBehavior = async () => ({ phase: 'needs-auth' });
    },
  }));
  const { reference, service } = await setup(runtime);
  service.start();

  await waitFor(() => expect(service.getState(reference)).toEqual({ phase: 'needs-auth' }));
  expect(jest.mocked(Notice).mock.calls.map(([message]) => message)).toEqual([
    'Copilot MCP sign-in required: notes. Open Settings > Claudian > Providers > Copilot > Resources and choose Sign in beside each server.',
  ]);
  expect(runtime.clients.flatMap(client => client.createdSessions.map(session => ({
    tools: session.config.availableTools,
    skills: session.config.resources?.skillDirectories,
    prompts: session.prompts,
    signIns: session.mcpSignIns,
  })))).toEqual([{ tools: [], skills: [], prompts: [], signIns: [] }]);
});

it.each(['individual', 'batch'] as const)('fills idle slots when %s checks join an active run', async mode => {
  const names = ['first', 'second', 'third'];
  const entered = new Set<string>();
  const release = createDeferred();
  let hold = false;
  const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpReadinessBehavior = async name => {
        if (hold) {
          entered.add(name);
          await release.promise;
        }
        return { phase: 'connected', toolCount: 0 };
      };
    },
  }));
  const { configPath, service, settings } = await setup(runtime);
  await writeFile(configPath, JSON.stringify({
    mcpServers: Object.fromEntries(names.map(name => [
      name, { type: 'http', url: `https://${name}.example.test/mcp` },
    ])),
  }));
  const references = names.map(name => ({ configPath, name }));
  updateCopilotProviderSettings(settings, {
    resourcesByHost: updateCopilotHostResources(settings, { selectedMcpServers: references }),
  });
  await service.check();
  hold = true;
  const checking = service.check(references[0]);
  try {
    await waitFor(() => expect([...entered]).toEqual(['first']));
    if (mode === 'batch') {
      service.check();
    } else {
      for (const reference of references.slice(1)) service.check(reference);
    }
    await waitFor(() => expect([...entered].sort()).toEqual(names));
    expect(references.map(reference => service.getState(reference).phase)).toEqual([
      'checking', 'checking', 'checking',
    ]);
  } finally {
    release.resolve();
    await checking;
  }
});

it('rechecks on return to Obsidian only after fifteen minutes and never while hidden', async () => {
  let now = 0;
  let toolCount = 1;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpReadinessBehavior = async () => ({ phase: 'connected', toolCount });
    },
  }));
  const { reference, service } = await setup(runtime);
  service.start();
  await service.ensureChecked();
  expect(service.getState(reference)).toEqual({ phase: 'connected', toolCount: 1 });

  toolCount = 2;
  now = 15 * 60_000 - 1;
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  await service.ensureChecked();
  expect(service.getState(reference)).toEqual({ phase: 'connected', toolCount: 1 });

  now += 1;
  visibility.mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
  await service.ensureChecked();
  expect(service.getState(reference)).toEqual({ phase: 'connected', toolCount: 1 });

  visibility.mockReturnValue('visible');
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  await service.ensureChecked();
  expect(service.getState(reference)).toEqual({ phase: 'connected', toolCount: 2 });
  expect(jest.mocked(Notice).mock.calls).toEqual([]);
});

it('checks changed MCP settings automatically, preserves skill-only results, and stops while disabled', async () => {
  let toolCount = 1;
  const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpReadinessBehavior = async () => ({ phase: 'connected', toolCount });
    },
  }));
  const { reference, registry, service, settings } = await setup(runtime);
  service.start();
  await service.ensureChecked();

  toolCount = 2;
  await registry.runTransition(['copilot'], async () => {
    updateCopilotProviderSettings(settings, {
      resourcesByHost: updateCopilotHostResources(settings, { rememberMcpSignIns: false }),
    });
  });
  await waitFor(() => expect(service.getState(reference)).toEqual({ phase: 'connected', toolCount: 2 }));

  toolCount = 3;
  await registry.runTransition(['copilot'], async () => {
    updateCopilotProviderSettings(settings, {
      resourcesByHost: updateCopilotHostResources(settings, { selectedSkillPaths: [path.join(root, 'SKILL.md')] }),
    });
  });
  await service.ensureChecked();
  expect(service.getState(reference)).toEqual({ phase: 'connected', toolCount: 2 });

  await registry.runTransition(['copilot'], async () => {
    updateCopilotProviderSettings(settings, { enabled: false });
  });
  const clientsBeforeFocus = [...runtime.clients];
  window.dispatchEvent(new Event('focus'));
  await service.ensureChecked();
  expect(service.getState(reference)).toEqual({ phase: 'unchecked' });
  expect(runtime.clients).toEqual(clientsBeforeFocus);

  await registry.runTransition(['copilot'], async () => {
    updateCopilotProviderSettings(settings, { enabled: true });
  });
  await waitFor(() => expect(service.getState(reference)).toEqual({ phase: 'connected', toolCount: 3 }));
});

it.each(['connection', 'model-refresh'] as const)('starts pending checks after Copilot %s makes a model available', async source => {
  const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
    models: [{
      id: 'gpt-5-mini',
      name: 'GPT-5 mini',
      capabilities: {
        limits: { max_context_window_tokens: 128_000 },
        supports: { reasoningEffort: false, vision: false },
      },
    }],
  }));
  const { reference, service, settings, workspace } = await setup(runtime);
  updateCopilotProviderSettings(settings, { enabled: source === 'model-refresh', discoveredModels: [] });
  service.start();
  expect(runtime.clients).toEqual([]);

  let completed: boolean;
  if (source === 'connection') {
    await workspace.connection.connect();
    completed = await workspace.connection.confirmModel('gpt-5-mini');
  } else {
    completed = (await workspace.refreshModelCatalog()).changed;
  }

  expect(completed).toBe(true);
  await waitFor(() => expect(service.getState(reference)).toEqual({ phase: 'connected', toolCount: 0 }));
});

it('notifies once per authentication failure until a successful connection rearms it', async () => {
  let readiness: CopilotMcpReadiness = { phase: 'needs-auth' };
  const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
    onSessionCreated: session => { session.mcpReadinessBehavior = async () => readiness; },
  }));
  const { service } = await setup(runtime);
  service.start();
  await service.ensureChecked();
  const message = 'Copilot MCP sign-in required: notes. Open Settings > Claudian > Providers > Copilot > Resources and choose Sign in beside each server.';
  expect(jest.mocked(Notice).mock.calls.map(([text]) => text)).toEqual([message]);

  for (const state of [
    { phase: 'needs-auth' },
    { phase: 'error', message: 'Network unavailable.' },
    { phase: 'needs-auth' },
    { phase: 'connected', toolCount: 0 },
  ] satisfies CopilotMcpReadiness[]) {
    readiness = state;
    await service.check();
    expect(jest.mocked(Notice).mock.calls.map(([text]) => text)).toEqual([message]);
  }
  readiness = { phase: 'needs-auth' };
  await service.check();
  expect(jest.mocked(Notice).mock.calls.map(([text]) => text)).toEqual([message, message]);
});

it.each([
  {
    server: { type: 'http', url: 'https://notes.example.test/mcp' },
    expected: 'Copilot MCP sign-in required: notes. Open Settings > Claudian > Providers > Copilot > Resources and turn on Remember MCP sign-ins, then choose Sign in beside each server.',
  },
  {
    server: { command: 'notes-mcp' },
    expected: 'Copilot MCP authentication required: notes. Check each server\'s source configuration; local servers do not support browser sign-in.',
  },
])('uses authentication guidance appropriate to $server', async ({ server, expected }) => {
  const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
    onSessionCreated: session => { session.mcpReadinessBehavior = async () => ({ phase: 'needs-auth' }); },
  }));
  const { configPath, service, settings } = await setup(runtime);
  await writeFile(configPath, JSON.stringify({ mcpServers: { notes: server } }));
  updateCopilotProviderSettings(settings, {
    resourcesByHost: updateCopilotHostResources(settings, { rememberMcpSignIns: false }),
  });
  service.start();
  await service.ensureChecked();
  expect(jest.mocked(Notice).mock.calls.map(([message]) => message)).toEqual([expected]);
});

it('drains every parallel probe before reporting a failed transition and never starts cancelled queued work', async () => {
  const names = ['first', 'second', 'third', 'fourth'];
  const listing = createDeferred();
  const releases = new Map(names.slice(0, 3).map(name => [name, createDeferred()]));
  const started = new Set<string>();
  const stopping = new Set<string>();
  const released = new Set<string>();
  const runtime = new FakeCopilotSdkRuntime(() => {
    let serverName = '';
    return new FakeCopilotSdkClient({
      onSessionCreated: session => {
        session.mcpReadinessBehavior = async name => {
          serverName = name;
          started.add(name);
          await listing.promise;
          return { phase: 'needs-auth' };
        };
      },
      stopBehavior: async () => {
        stopping.add(serverName);
        if (serverName === 'first') throw new Error('Could not stop first.');
        await releases.get(serverName)!.promise;
        released.add(serverName);
      },
    });
  });
  const { configPath, registry, service, settings } = await setup(runtime);
  await writeFile(configPath, JSON.stringify({
    mcpServers: Object.fromEntries(names.map(name => [
      name, { type: 'http', url: `https://${name}.example.test/mcp` },
    ])),
  }));
  const references = names.map(name => ({ configPath, name }));
  updateCopilotProviderSettings(settings, {
    resourcesByHost: updateCopilotHostResources(settings, { selectedMcpServers: references }),
  });
  service.start();
  const checking = service.ensureChecked();
  let committed = false;
  let settled = false;
  try {
    await waitFor(() => expect([...started].sort()).toEqual(['first', 'second', 'third']));
    const changing = registry.runTransition(['copilot'], async () => { committed = true; });
    const result = Promise.allSettled([checking, changing]).then(outcomes => { settled = true; return outcomes; });
    listing.resolve();
    await waitFor(() => expect([...stopping].sort()).toEqual(['first', 'second', 'third']));
    expect(settled).toBe(false);
    releases.get('second')!.resolve();
    await waitFor(() => expect([...released]).toEqual(['second']));
    expect(settled).toBe(false);
    releases.get('third')!.resolve();

    expect(await result).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: 'Could not stop first.' }) },
      { status: 'rejected', reason: expect.objectContaining({ message: 'Could not stop first.' }) },
    ]);
    expect(committed).toBe(false);
    expect([...started].sort()).toEqual(['first', 'second', 'third']);
    expect(references.map(reference => service.getState(reference).phase)).toEqual([
      'unchecked', 'unchecked', 'unchecked', 'unchecked',
    ]);
  } finally {
    listing.resolve();
    for (const release of releases.values()) release.resolve();
    await Promise.allSettled([checking]);
  }
});

it('disposes active probes without notifying or restarting on later focus events', async () => {
  const entered = createDeferred();
  const listing = createDeferred();
  const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpReadinessBehavior = async () => {
        entered.resolve();
        await listing.promise;
        return { phase: 'needs-auth' };
      };
    },
  }));
  const { reference, service } = await setup(runtime);
  service.start();
  await entered.promise;
  const disposal = service.dispose();
  listing.resolve();
  await disposal;
  const clients = [...runtime.clients];
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  service.start();
  await Promise.resolve();

  expect(service.getState(reference)).toEqual({ phase: 'unchecked' });
  expect(runtime.clients).toEqual(clients);
  expect(runtime.clients.every(client => client.stopped === 1)).toBe(true);
  expect(jest.mocked(Notice).mock.calls).toEqual([]);
});

it.each(['existing', 'new'] as const)('checks on return to a popout (%s) and stops observing it when closed', async kind => {
  const frame = document.body.appendChild(document.createElement('iframe'));
  const popout = frame.contentWindow!;
  jest.spyOn(popout.document, 'visibilityState', 'get').mockReturnValue('visible');
  let now = 0;
  let toolCount = 1;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpReadinessBehavior = async () => ({ phase: 'connected', toolCount });
    },
  }));
  const { reference, service, windowEvent } = await setup(runtime, kind === 'existing' ? [popout] : []);
  service.start();
  await service.ensureChecked();
  if (kind === 'new') windowEvent('window-open', popout);
  toolCount = 2;
  now = 15 * 60_000;
  popout.dispatchEvent(new Event('focus'));
  await service.ensureChecked();
  expect(service.getState(reference)).toEqual({ phase: 'connected', toolCount: 2 });

  windowEvent('window-close', popout);
  toolCount = 3;
  now = 30 * 60_000;
  popout.dispatchEvent(new Event('focus'));
  await service.ensureChecked();
  expect(service.getState(reference)).toEqual({ phase: 'connected', toolCount: 2 });
});
