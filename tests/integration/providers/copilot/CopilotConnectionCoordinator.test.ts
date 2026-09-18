import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { App, PluginManifest } from 'obsidian';

import { CLAUDIAN_SETTINGS_PATH } from '@/app/settings/ClaudianSettingsStorage';
import type { ProviderExecutionEvent, ProviderInteractionPort } from '@/core/execution';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import ClaudianPlugin from '@/main';
import { registerBuiltInProviders } from '@/providers';
import { CopilotConnectionCoordinator } from '@/providers/copilot/app/CopilotConnectionCoordinator';
import { computeCopilotEnvironmentHash } from '@/providers/copilot/env/CopilotSettingsReconciler';
import { CopilotExecutionBackend } from '@/providers/copilot/execution/CopilotExecutionBackend';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';

import {
  createDeferred,
  FakeCopilotSdkClient,
  FakeCopilotSdkRuntime,
} from '../../../unit/providers/copilot/sdk/FakeCopilotSdkRuntime';

const manifest: PluginManifest = {
  author: 'Claudian',
  description: 'Copilot connection integration test',
  id: 'claudian',
  minAppVersion: '1.0.0',
  name: 'Claudian',
  version: '0.0.0',
};

const interactionPort: ProviderInteractionPort = {
  askUserQuestion: async () => { throw new Error('Unexpected question.'); },
  dismissInteraction: () => {},
  requestApproval: async () => { throw new Error('Unexpected approval.'); },
  requestPlanDecision: async () => { throw new Error('Unexpected plan decision.'); },
};

function createApp(basePath: string, settings: Record<string, unknown>): App {
  const files = new Map([[CLAUDIAN_SETTINGS_PATH, JSON.stringify(settings)]]);
  const folders = new Set(['.claudian']);
  return {
    vault: {
      adapter: {
        basePath,
        exists: async (file: string) => files.has(file) || folders.has(file),
        list: async (folder: string) => ({
          files: [...files.keys()].filter(file => path.posix.dirname(file) === folder),
          folders: [...folders].filter(file => path.posix.dirname(file) === folder),
        }),
        mkdir: async (folder: string) => { folders.add(folder); },
        read: async (file: string) => {
          const content = files.get(file);
          if (content === undefined) throw new Error(`Missing test file: ${file}`);
          return content;
        },
        remove: async (file: string) => { files.delete(file); },
        write: async (file: string, content: string) => { files.set(file, content); },
      },
    },
    workspace: { getLeavesOfType: () => [], layoutReady: true },
  } as unknown as App;
}

async function collect(events: AsyncIterable<ProviderExecutionEvent>): Promise<ProviderExecutionEvent[]> {
  const result: ProviderExecutionEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('Copilot connection through the application lifecycle boundary', () => {
  it.each([
    ['same', 'gpt-5-mini', 'copilot/gpt-5-mini'],
    ['different', 'gpt-5', 'copilot/gpt-5'],
  ])('keeps an active chat running when confirming a %s model', async (_label, model, selection) => {
    registerBuiltInProviders();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'claudian-connect-lifecycle-'));
    const cliPath = path.join(directory, 'copilot.js');
    await writeFile(cliPath, 'throw new Error("The fake SDK must not launch a CLI.");\n', { mode: 0o700 });
    const settings: Record<string, unknown> = {
      model: 'copilot/gpt-5-mini',
      settingsProvider: 'copilot',
    };
    updateCopilotProviderSettings(settings, {
      cliPath,
      discoveredModels: [{
        contextWindow: 128_000,
        displayName: 'GPT-5 mini',
        rawId: 'gpt-5-mini',
        reasoningEfforts: [],
        supportsReasoning: false,
        supportsVision: false,
      }],
      enabled: true,
      visibleModels: ['gpt-5-mini'],
    });
    updateCopilotProviderSettings(settings, {
      environmentHash: computeCopilotEnvironmentHash(settings),
    });
    const app = createApp(path.join(directory, 'vault'), settings);
    const plugin = new ClaudianPlugin(app, manifest);
    const started = createDeferred();
    const finish = createDeferred();
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      models: [
        {
          capabilities: {
            limits: { max_context_window_tokens: 128_000 },
            supports: { reasoningEffort: false, vision: false },
          },
          id: 'gpt-5-mini',
          name: 'GPT-5 mini',
        },
        {
          capabilities: {
            limits: { max_context_window_tokens: 200_000 },
            supports: { reasoningEffort: false, vision: false },
          },
          id: 'gpt-5',
          name: 'GPT-5',
        },
      ],
      onSessionCreated: session => {
        session.sendBehavior = async () => {
          started.resolve();
          await finish.promise;
        };
        session.abortBehavior = async () => { finish.resolve(); };
      },
    }));
    const connection = new CopilotConnectionCoordinator(plugin.providerHost, {
      login: { signIn: async () => { throw new Error('Already authenticated.'); } },
      runtime,
    });
    try {
      await plugin.loadSettings();
      await ProviderWorkspaceRegistry.ensureInitialized(plugin.providerHost, 'copilot', 'connection-test');
      const registry = plugin.executionLifecycleRegistry;
      const lease = registry.acquire(
        new CopilotExecutionBackend(plugin.providerHost, { runtime }),
        {
          interactionPort,
          lifecycle: 'persistent',
          nativePersistence: 'provider-default',
          vaultWorkingDirectory: path.join(directory, 'vault'),
        },
        'chat',
      );
      const turn = collect(lease.session.execute({
        configuration: {
          model: 'copilot/gpt-5-mini',
          systemInstructions: { instructions: 'Reply concisely.', kind: 'explicit' },
        },
        input: [{ text: 'Keep working.', type: 'text' }],
        signal: new AbortController().signal,
        toolPolicy: { kind: 'passive' },
      }).events);
      expect(await Promise.race([started.promise.then(() => null), turn])).toBeNull();
      const generation = registry.getProviderGeneration('copilot');
      const environment = computeCopilotEnvironmentHash(plugin.settings);
      expect(lease.isCurrent()).toBe(true);
      expect(lease.session.getStatus()).toBe('executing');

      await connection.connect();
      await connection.confirmModel(model);

      expect(connection.state).toEqual({ model, phase: 'connected' });
      expect(computeCopilotEnvironmentHash(plugin.settings)).toBe(environment);
      expect({
        current: lease.isCurrent(),
        generation: registry.getProviderGeneration('copilot'),
        status: lease.session.getStatus(),
      }).toEqual({ current: true, generation, status: 'executing' });
      expect(plugin.settings.lastSelectedChatModel)
        .toEqual({ model: selection, providerId: 'copilot' });
      finish.resolve();
      expect((await turn).at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
    } finally {
      finish.resolve();
      await connection.dispose();
      await plugin.executionLifecycleRegistry.dispose();
      await ProviderWorkspaceRegistry.disposeInitialized();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
