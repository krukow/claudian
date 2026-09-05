import type { ProviderHost } from '@/core/providers/ProviderHost';
import { CopilotModelDiscoveryService } from '@/providers/copilot/runtime/CopilotModelDiscoveryService';
import type { CopilotSdkModel } from '@/providers/copilot/sdk/CopilotSdkPort';
import { copilotSdkRuntime } from '@/providers/copilot/sdk/CopilotSdkRuntime';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';

import {
  FakeCopilotSdkClient,
  FakeCopilotSdkRuntime,
} from '../sdk/FakeCopilotSdkRuntime';

/**
 * The real `@github/copilot-sdk` client, restated with only the surface the probe drives.
 * Used by the shutdown-budget case below, which needs the runtime's own client rather
 * than a fake that already settles.
 */
class WedgedSdkCopilotClient {
  static readonly instances: WedgedSdkCopilotClient[] = [];

  forceStopped = 0;
  stopped = 0;

  constructor(readonly options: unknown) {
    WedgedSdkCopilotClient.instances.push(this);
  }

  async start(): Promise<void> {}

  async getAuthStatus(): Promise<{ isAuthenticated: boolean }> {
    return { isAuthenticated: true };
  }

  async listModels(): Promise<readonly CopilotSdkModel[]> {
    return [sdkModel()];
  }

  stop(): Promise<Error[]> {
    this.stopped += 1;
    return new Promise<Error[]>(() => {});
  }

  forceStop(): Promise<void> {
    this.forceStopped += 1;
    return new Promise<void>(() => {});
  }
}

jest.mock('@/providers/copilot/sdk/copilotSdkModule', () => ({
  CopilotClient: WedgedSdkCopilotClient,
  RuntimeConnection: { forStdio: (options: unknown) => options },
}));

function createHost(cliPath: string | null = '/usr/local/bin/copilot'): ProviderHost {
  const settings: Record<string, unknown> = {};
  updateCopilotProviderSettings(settings, { enabled: true });
  return {
    app: { vault: { adapter: { basePath: '/vault' } } },
    getResolvedProviderCliPath: async () => cliPath,
    settings,
  } as unknown as ProviderHost;
}

function sdkModel(overrides: Record<string, unknown> = {}): CopilotSdkModel {
  return {
    capabilities: {
      limits: { max_context_window_tokens: 272_000 },
      supports: { reasoningEffort: true, vision: true },
    },
    defaultReasoningEffort: 'medium',
    id: 'gpt-5',
    name: 'GPT-5',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    ...overrides,
  } as unknown as CopilotSdkModel;
}

function createRuntime(models: readonly CopilotSdkModel[]): FakeCopilotSdkRuntime {
  return new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({ models }));
}

describe('CopilotModelDiscoveryService', () => {
  it('normalizes the SDK catalog into persisted models', async () => {
    const runtime = createRuntime([sdkModel()]);

    const result = await new CopilotModelDiscoveryService(createHost(), { runtime })
      .discoverModels();

    expect(result).toEqual({
      kind: 'loaded',
      models: [{
        contextWindow: 272_000,
        defaultReasoningEffort: 'medium',
        displayName: 'GPT-5',
        rawId: 'gpt-5',
        reasoningEfforts: ['low', 'medium', 'high'],
        supportsReasoning: true,
        supportsVision: true,
      }],
    });
  });

  it('drops models the account policy disables', async () => {
    const runtime = createRuntime([
      sdkModel(),
      sdkModel({ id: 'blocked', policy: { state: 'disabled' } }),
    ]);

    const result = await new CopilotModelDiscoveryService(createHost(), { runtime })
      .discoverModels();

    expect(result.kind === 'loaded' && result.models.map(model => model.rawId))
      .toEqual(['gpt-5']);
  });

  it('reports no reasoning efforts for a model that does not support them', async () => {
    const runtime = createRuntime([sdkModel({
      capabilities: {
        limits: { max_context_window_tokens: 200_000 },
        supports: { reasoningEffort: false, vision: false },
      },
      id: 'claude-sonnet-4.5',
      supportedReasoningEfforts: ['low', 'high'],
    })]);

    const result = await new CopilotModelDiscoveryService(createHost(), { runtime })
      .discoverModels();

    expect(result.kind === 'loaded' && result.models[0]).toMatchObject({
      reasoningEfforts: [],
      supportsReasoning: false,
      supportsVision: false,
    });
  });

  it('always stops the discovery client so it never outlives the probe', async () => {
    const runtime = createRuntime([sdkModel()]);

    await new CopilotModelDiscoveryService(createHost(), { runtime }).discoverModels();

    expect(runtime.lastClient?.stopped).toBe(1);
  });

  /**
   * The probe's client is Claudian's own and is thrown away either way. A catalog the
   * account already answered with is not lost because shutting that client down failed.
   */
  it('keeps the discovered catalog when the probe client will not stop', async () => {
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      models: [sdkModel()],
      stopBehavior: async () => {
        throw new Error('the CLI process would not shut down');
      },
    }));

    const result = await new CopilotModelDiscoveryService(createHost(), { runtime })
      .discoverModels();

    expect(result).toMatchObject({ kind: 'loaded' });
    expect(runtime.lastClient?.stopped).toBe(1);
  });

  it('fails with a diagnostic when the CLI cannot be resolved', async () => {
    const runtime = createRuntime([]);

    const result = await new CopilotModelDiscoveryService(createHost(null), { runtime })
      .discoverModels();

    expect(result).toMatchObject({ kind: 'failed' });
    expect(result.kind === 'failed' && result.message).toMatch(/Copilot CLI could not be launched/);
    expect(result.kind === 'failed' && result.message).toMatch(/lowercase `\.js`/);
    expect(runtime.clients).toHaveLength(0);
  });

  it('fails with a diagnostic when the CLI is not signed in', async () => {
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      authStatus: { isAuthenticated: false, statusMessage: 'Run `copilot` to sign in.' },
    }));

    const result = await new CopilotModelDiscoveryService(createHost(), { runtime })
      .discoverModels();

    expect(result).toEqual({ kind: 'failed', message: 'Run `copilot` to sign in.' });
    expect(runtime.lastClient?.stopped).toBe(1);
  });

  it('fails with a diagnostic when listing models throws', async () => {
    const client = new FakeCopilotSdkClient();
    client.listModels = async () => {
      throw new Error('read ECONNRESET');
    };
    const runtime = new FakeCopilotSdkRuntime(() => client);

    const result = await new CopilotModelDiscoveryService(createHost(), { runtime })
      .discoverModels();

    expect(result).toEqual({ kind: 'failed', message: 'read ECONNRESET' });
    expect(client.stopped).toBe(1);
  });

  /**
   * The catalog is an acquisition like any other: the account answers, or it does not.
   * A CLI that goes silent on it would otherwise hold the Discover button open for as
   * long as it stays silent, so the probe reports the silence and still shuts its own
   * client down rather than leaving a CLI running behind a failed discovery.
   */
  it('fails with a diagnostic when listing models never answers', async () => {
    jest.useFakeTimers();
    try {
      const client = new FakeCopilotSdkClient();
      client.listModels = () => new Promise<readonly CopilotSdkModel[]>(() => {});
      const runtime = new FakeCopilotSdkRuntime(() => client);

      const discovering = new CopilotModelDiscoveryService(createHost(), { runtime })
        .discoverModels();
      await jest.advanceTimersByTimeAsync(30_000);
      const result = await discovering;

      expect(result.kind).toBe('failed');
      expect(result.kind === 'failed' && result.message).toMatch(/did not answer within/);
      expect(client.stopped).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * The probe holds the Discover button open until it returns, so a CLI that stopped
 * answering the shutdown must not hold it open with it. This drives the provider's own
 * runtime rather than a fake client, because the budget that bounds the shutdown belongs
 * to the SDK boundary, where it covers the probe, the authentication gate, and every
 * turn alike.
 */
describe('CopilotModelDiscoveryService under a shutdown that never answers', () => {
  it('returns the catalog after terminating a probe client that will not stop', async () => {
    jest.useFakeTimers();
    try {
      WedgedSdkCopilotClient.instances.length = 0;
      const discovering = new CopilotModelDiscoveryService(createHost(), {
        runtime: copilotSdkRuntime,
      }).discoverModels();
      await jest.advanceTimersByTimeAsync(30_000);

      expect(await discovering).toMatchObject({ kind: 'loaded' });
      expect(WedgedSdkCopilotClient.instances[0]?.stopped).toBe(1);
      expect(WedgedSdkCopilotClient.instances[0]?.forceStopped).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
