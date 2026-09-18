import { ChatModelSelectionCoordinator } from '@/app/settings/ChatModelSelectionCoordinator';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { resolveNewConversationModel } from '@/core/providers/conversationModel';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ClaudianSettings } from '@/core/types';
import { registerBuiltInProviders } from '@/providers';
import {
  CopilotConnectionCoordinator,
  type CopilotConnectionState,
} from '@/providers/copilot/app/CopilotConnectionCoordinator';
import { getCopilotProviderSettings, updateCopilotProviderSettings } from '@/providers/copilot/settings';

import { createDeferred, FakeCopilotSdkClient, FakeCopilotSdkRuntime } from '../sdk/FakeCopilotSdkRuntime';

const MODEL = {
  capabilities: {
    limits: { max_context_window_tokens: 128_000 },
    supports: { reasoningEffort: false, vision: false },
  },
  id: 'gpt-5-mini',
  name: 'GPT-5 mini',
};

function createHost(onSave: (settings: ClaudianSettings) => void = () => {}): ProviderHost {
  const settings: Record<string, unknown> = { settingsProvider: 'copilot' };
  const registry = new ProviderExecutionLifecycleRegistry();
  const coordinator = new SettingsCoordinator(
    settings as unknown as ClaudianSettings, async snapshot => { onSave(snapshot); },
  );
  return {
    app: { vault: { adapter: { basePath: '/vault' } } },
    chatModelSelection: new ChatModelSelectionCoordinator(coordinator),
    mutateSettings: (mutation: (settings: ClaudianSettings) => void) => coordinator.mutate(mutation),
    executionLifecycleRegistry: registry,
    getResolvedProviderCliPath: async () => '/usr/local/bin/copilot',
    notifyProviderChatOptionsChanged: () => {},
    settings,
  } as unknown as ProviderHost;
}

beforeAll(() => { registerBuiltInProviders(); });

describe('CopilotConnectionCoordinator', () => {
  it('uses existing sign-in, discovers models, and waits for model confirmation', async () => {
    const host = createHost();
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      models: [
        MODEL,
        {
          ...MODEL, id: 'blocked-model', name: 'Blocked',
          policy: { state: 'disabled', terms: '' },
        },
      ],
    }));
    const connection = new CopilotConnectionCoordinator(host, {
      login: { signIn: async () => { throw new Error('Existing sign-in must not launch OAuth.'); } },
      runtime,
    });
    try {
      await connection.connect();

      expect(connection.state).toMatchObject({
        phase: 'choose-model',
        models: [{ rawId: 'gpt-5-mini', displayName: 'GPT-5 mini' }],
        recommendedModel: 'gpt-5-mini',
      });
      expect(getCopilotProviderSettings(host.settings).enabled).toBe(false);
      expect(getCopilotProviderSettings(host.settings).visibleModels).toEqual([]);

      await connection.confirmModel('gpt-5-mini');

      expect(connection.state).toMatchObject({ phase: 'connected', model: 'gpt-5-mini' });
      expect(getCopilotProviderSettings(host.settings)).toMatchObject({
        enabled: true,
        visibleModels: ['gpt-5-mini'],
      });
      expect(runtime.clients.every(client => client.stopped === 1)).toBe(true);
    } finally {
      await connection.dispose();
    }
  });

  it('makes the confirmed model the durable new-chat choice without replacing Claude settings', async () => {
    let saved = '';
    const host = createHost(settings => { saved = JSON.stringify(settings); });
    host.settings.settingsProvider = 'claude';
    host.settings.model = 'opus';
    const connection = new CopilotConnectionCoordinator(host, {
      login: { signIn: async () => {} },
      runtime: new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({ models: [MODEL] })),
    });
    await connection.connect();
    await connection.confirmModel('gpt-5-mini');

    expect(connection.state.phase).toBe('connected');
    expect(resolveNewConversationModel(host.settings)).toEqual({
      model: 'copilot/gpt-5-mini', providerId: 'copilot', source: 'last-selected',
    });
    expect(resolveNewConversationModel(JSON.parse(saved))).toEqual({
      model: 'copilot/gpt-5-mini', providerId: 'copilot', source: 'last-selected',
    });
    expect(host.settings.settingsProvider).toBe('claude');
    expect(host.settings.model).toBe('opus');
    await connection.dispose();
  });

  it('signs in only when needed and verifies the resulting authentication before discovery', async () => {
    const host = createHost();
    let authenticated = false;
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      authStatus: { isAuthenticated: authenticated },
      models: [MODEL],
    }));
    let signedInHome: string | undefined;
    const connection = new CopilotConnectionCoordinator(host, {
      login: {
        signIn: async identity => {
          signedInHome = identity.baseDirectory;
          authenticated = true;
        },
      },
      runtime,
    });
    await connection.connect();

    expect(connection.state.phase).toBe('choose-model');
    expect(signedInHome).toBe(runtime.clientOptions[0].environment.COPILOT_HOME);
    expect(runtime.clientOptions.every(options => options.baseDirectory === signedInHome)).toBe(true);
    expect(getCopilotProviderSettings(host.settings).enabled).toBe(false);
    await connection.dispose();
  });

  it('does not treat login process success as authenticated without a fresh SDK check', async () => {
    const connection = new CopilotConnectionCoordinator(createHost(), {
      login: { signIn: async () => {} },
      runtime: new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
        authStatus: { isAuthenticated: false },
        models: [MODEL],
      })),
    });
    await connection.connect();

    expect(connection.state).toMatchObject({ phase: 'error' });
    await connection.dispose();
  });

  it('cancels browser sign-in and permits a later retry without losing existing settings', async () => {
    const host = createHost();
    const loginStarted = createDeferred();
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      authStatus: { isAuthenticated: false }, models: [MODEL],
    }));
    const connection = new CopilotConnectionCoordinator(host, {
      login: {
        signIn: async (_identity, signal) => {
          loginStarted.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      },
      runtime,
    });
    const connecting = connection.connect();
    await loginStarted.promise;
    await connection.cancel();
    await connecting;

    expect(connection.state.phase).toBe('idle');
    expect(getCopilotProviderSettings(host.settings).visibleModels).toEqual([]);
    expect(runtime.clients.every(client => client.stopped === 1)).toBe(true);
    await connection.dispose();
  });

  it('rejects catalog confirmation after the CLI settings change', async () => {
    const host = createHost();
    const connection = new CopilotConnectionCoordinator(host, {
      login: { signIn: async () => {} },
      runtime: new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({ models: [MODEL] })),
    });
    await connection.connect();
    updateCopilotProviderSettings(host.settings, { cliPath: '/another/copilot' });
    await connection.confirmModel(MODEL.id);

    expect(connection.state).toMatchObject({
      message: expect.stringContaining('settings changed'),
      phase: 'error',
    });
    expect(getCopilotProviderSettings(host.settings).visibleModels).toEqual([]);
    await connection.dispose();
  });

  it('starts a new connection when reopened while cancellation is draining', async () => {
    const entered = createDeferred();
    const release = createDeferred();
    let authenticated = false;
    const connection = new CopilotConnectionCoordinator(createHost(), {
      login: {
        signIn: async () => {
          entered.resolve();
          await release.promise;
        },
      },
      runtime: new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
        authStatus: { isAuthenticated: authenticated }, models: [MODEL],
      })),
    });
    const first = connection.connect();
    await entered.promise;
    const cancelled = connection.cancel();
    authenticated = true;
    const second = connection.connect();
    release.resolve();
    await Promise.all([first, cancelled, second]);

    expect(connection.state.phase).toBe('choose-model');
    await connection.dispose();
  });

  it('cancels a queued reconnect when its new window is dismissed as well', async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const prompts: string[] = [];
    const connection = new CopilotConnectionCoordinator(createHost(), {
      login: {
        signIn: async () => {
          prompts.push('browser sign-in');
          entered.resolve();
          await release.promise;
        },
      },
      runtime: new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
        authStatus: { isAuthenticated: false }, models: [MODEL],
      })),
    });
    const first = connection.connect();
    await entered.promise;
    const firstCancellation = connection.cancel();
    const reopened = connection.connect();
    const secondCancellation = connection.cancel();
    release.resolve();
    await Promise.all([first, firstCancellation, reopened, secondCancellation]);

    expect(prompts).toEqual(['browser sign-in']);
    expect(connection.state.phase).toBe('idle');
    await connection.dispose();
  });

  it('reopens during catalog cleanup without exposing the completed browser login URL', async () => {
    const entered = createDeferred();
    const release = createDeferred();
    let authenticated = false;
    let heldCatalog = false;
    const runtime = new FakeCopilotSdkRuntime(() => {
      const client = new FakeCopilotSdkClient({
        authStatus: { isAuthenticated: authenticated }, models: [MODEL],
      });
      client.listModels = async () => {
        if (!heldCatalog) {
          heldCatalog = true;
          entered.resolve();
          await release.promise;
        }
        return [MODEL];
      };
      return client;
    });
    const connection = new CopilotConnectionCoordinator(createHost(), {
      login: {
        signIn: async (_identity, _signal, onAuthorizationUrl) => {
          onAuthorizationUrl?.('https://github.com/login/oauth/authorize?state=synthetic');
          authenticated = true;
        },
      },
      runtime,
    });
    const first = connection.connect();
    await entered.promise;
    const cancelling = connection.cancel();
    const reopened = connection.connect();
    const states: CopilotConnectionState[] = [];
    const unsubscribe = connection.subscribe(state => { states.push(state); });
    try {
      expect(states).toEqual([{ phase: 'discovering' }]);
      release.resolve();
      await Promise.all([first, cancelling, reopened]);

      expect(states.map(state => state.phase))
        .toEqual(['discovering', 'idle', 'checking', 'discovering', 'choose-model']);
      expect(states.some(state => 'authorizationUrl' in state)).toBe(false);
      expect(connection.state).toMatchObject({ phase: 'choose-model' });
      expect(runtime.clients.every(client => client.stopped === 1)).toBe(true);
    } finally {
      release.resolve();
      unsubscribe();
      await connection.dispose();
    }
  });
});
