import type { ProviderHost } from '@/core/providers/ProviderHost';
import { createCopilotWorkspaceServices } from '@/providers/copilot/app/CopilotWorkspaceServices';
import { computeCopilotEnvironmentHash } from '@/providers/copilot/env/CopilotSettingsReconciler';
import type { CopilotDiscoveredModel } from '@/providers/copilot/models';
import type {
  CopilotModelDiscoveryResult,
} from '@/providers/copilot/runtime/CopilotModelDiscoveryService';
import {
  getCopilotProviderSettings,
  updateCopilotProviderSettings,
} from '@/providers/copilot/settings';
import { getHostnameKey } from '@/utils/env';

const GPT_5: CopilotDiscoveredModel = {
  contextWindow: 200_000,
  displayName: 'GPT-5',
  rawId: 'gpt-5',
  reasoningEfforts: ['low', 'high'],
  supportsReasoning: true,
  supportsVision: false,
};

/**
 * A host whose settings transactions are serialized the way the real coordinator
 * serializes them, so a change queued while discovery is running is applied before the
 * catalog write rather than beside it. Its provider generation moves the way the real
 * lifecycle registry moves it: once per runtime settings transition.
 */
function createHost(settings: Record<string, unknown> = {}): ProviderHost {
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (work: () => void | Promise<void>): Promise<void> => {
    const running = tail.then(work);
    tail = running.then(() => undefined, () => undefined);
    return running;
  };

  return {
    app: { vault: { adapter: { basePath: '/vault' } } },
    executionLifecycleRegistry: { getProviderGeneration: () => generations.get(settings) ?? 0 },
    mutateSettings: (mutate: (settings: Record<string, unknown>) => void | Promise<void>) => (
      enqueue(() => mutate(settings))
    ),
    mutateSettingsConditionally: (
      mutate: (settings: Record<string, unknown>) => boolean | Promise<boolean>,
    ) => enqueue(async () => { await mutate(settings); }),
    settings,
  } as unknown as ProviderHost;
}

/** Provider generations per settings bag, standing in for the lifecycle registry's. */
const generations = new WeakMap<Record<string, unknown>, number>();

/** Records one runtime settings transition against the bag the host reads. */
function advanceGeneration(settings: Record<string, unknown>): void {
  generations.set(settings, (generations.get(settings) ?? 0) + 1);
}

function createServices(host: ProviderHost, results: CopilotModelDiscoveryResult[]) {
  let call = 0;
  return createCopilotWorkspaceServices(host, {
    modelDiscoveryService: {
      discoverModels: async () => results[Math.min(call++, results.length - 1)],
    },
  });
}

describe('createCopilotWorkspaceServices.refreshModelCatalog', () => {
  it('persists the catalog together with the fingerprint it was discovered under', async () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { enabled: true });
    const host = createHost(settings);
    const services = createServices(host, [{ kind: 'loaded', models: [GPT_5] }]);

    const result = await services.refreshModelCatalog();

    expect(result).toMatchObject({ changed: true, persistedSettingsChanged: true });
    const persisted = getCopilotProviderSettings(settings);
    expect(persisted.discoveredModels).toEqual([GPT_5]);
    expect(persisted.environmentHash).toBe(computeCopilotEnvironmentHash(settings));
  });

  it('rewrites the catalog when only model metadata changed', async () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { enabled: true });
    const host = createHost(settings);
    const widened = { ...GPT_5, contextWindow: 400_000 };
    const services = createServices(host, [
      { kind: 'loaded', models: [GPT_5] },
      { kind: 'loaded', models: [widened] },
    ]);

    await services.refreshModelCatalog();
    const result = await services.refreshModelCatalog();

    expect(result.changed).toBe(true);
    expect(getCopilotProviderSettings(settings).discoveredModels).toEqual([widened]);
  });

  it.each<[string, Partial<CopilotDiscoveredModel>]>([
    ['display name', { displayName: 'GPT-5 Turbo' }],
    ['reasoning efforts', { reasoningEfforts: ['low', 'medium', 'high'] }],
    ['vision support', { supportsVision: true }],
    ['description', { description: 'Now with citations' }],
  ])('rewrites the catalog when the %s changed', async (_label, change) => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { enabled: true });
    const host = createHost(settings);
    const services = createServices(host, [
      { kind: 'loaded', models: [GPT_5] },
      { kind: 'loaded', models: [{ ...GPT_5, ...change }] },
    ]);

    await services.refreshModelCatalog();

    expect((await services.refreshModelCatalog()).changed).toBe(true);
  });

  it('writes nothing when the catalog and the fingerprint are unchanged', async () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { enabled: true });
    const host = createHost(settings);
    const services = createServices(host, [{ kind: 'loaded', models: [GPT_5] }]);

    await services.refreshModelCatalog();

    expect(await services.refreshModelCatalog()).toEqual({ changed: false });
  });

  it('re-attributes an unchanged catalog to a fingerprint that moved', async () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { enabled: true });
    const host = createHost(settings);
    const services = createServices(host, [{ kind: 'loaded', models: [GPT_5] }]);

    await services.refreshModelCatalog();
    updateCopilotProviderSettings(settings, { environmentVariables: 'LANG=en_US.UTF-8' });

    expect((await services.refreshModelCatalog()).changed).toBe(true);
    expect(getCopilotProviderSettings(settings).environmentHash)
      .toBe(computeCopilotEnvironmentHash(settings));
  });

  it('keeps the persisted catalog when discovery fails', async () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { discoveredModels: [GPT_5], enabled: true });
    const host = createHost(settings);
    const services = createServices(host, [{ kind: 'failed', message: 'CLI is not signed in' }]);

    expect(await services.refreshModelCatalog()).toEqual({
      changed: false,
      diagnostics: 'CLI is not signed in',
    });
    expect(getCopilotProviderSettings(settings).discoveredModels).toEqual([GPT_5]);
  });

  /**
   * Discovery runs against the environment, CLI path, and account the settings named when
   * it started. A catalog discovered under inputs the user has since changed describes a
   * runtime that is no longer configured, so it is dropped rather than persisted under the
   * new fingerprint.
   */
  it.each<[string, (settings: Record<string, unknown>) => void]>([
    ['the environment changed', (settings) => {
      updateCopilotProviderSettings(settings, {
        environmentVariables: 'LANG=en_US.UTF-8',
      });
    }],
    ['the CLI path changed', (settings) => {
      updateCopilotProviderSettings(settings, {
        cliPathsByHost: { [getHostnameKey()]: '/opt/homebrew/bin/copilot' },
      });
    }],
    ['the legacy CLI path changed', (settings) => {
      updateCopilotProviderSettings(settings, { cliPath: '/opt/homebrew/bin/copilot' });
    }],
  ])('discards a catalog discovered before %s', async (_label, mutate) => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { discoveredModels: [GPT_5], enabled: true });
    updateCopilotProviderSettings(settings, {
      environmentHash: computeCopilotEnvironmentHash(settings),
    });
    const host = createHost(settings);
    const stale = { ...GPT_5, displayName: 'GPT-5 from the old runtime' };
    const services = createCopilotWorkspaceServices(host, {
      modelDiscoveryService: {
        discoverModels: async () => {
          mutate(settings);
          return { kind: 'loaded', models: [stale] };
        },
      },
    });

    const result = await services.refreshModelCatalog();

    expect(result.changed).toBe(false);
    expect(getCopilotProviderSettings(settings).discoveredModels).toEqual([GPT_5]);
  });

  it('persists a catalog the settings did not outrun', async () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { enabled: true });
    const host = createHost(settings);
    const services = createCopilotWorkspaceServices(host, {
      modelDiscoveryService: {
        discoverModels: async () => {
          updateCopilotProviderSettings(settings, { visibleModels: [] });
          return { kind: 'loaded', models: [GPT_5] };
        },
      },
    });

    const result = await services.refreshModelCatalog();

    expect(result).toMatchObject({ changed: true, persistedSettingsChanged: true });
    expect(getCopilotProviderSettings(settings).discoveredModels).toEqual([GPT_5]);
  });

  it('restores the selection when rediscovery returns the same models', async () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, {
      discoveredModels: [GPT_5],
      enabled: true,
      modelAliases: { 'gpt-5': 'five' },
      preferredReasoningByModel: { 'gpt-5': 'high' },
      visibleModels: ['gpt-5'],
    });
    const host = createHost(settings);
    updateCopilotProviderSettings(settings, { discoveredModels: [], environmentHash: 'moved' });
    const services = createServices(host, [{ kind: 'loaded', models: [GPT_5] }]);

    await services.refreshModelCatalog();

    const restored = getCopilotProviderSettings(settings);
    expect(restored.visibleModels).toEqual(['gpt-5']);
    expect(restored.modelAliases).toEqual({ 'gpt-5': 'five' });
    expect(restored.preferredReasoningByModel).toEqual({ 'gpt-5': 'high' });
  });
});

/**
 * Settings transactions are serialized, so a change the user made while the CLI was
 * answering can be queued ahead of the catalog write and applied between the check and
 * the write. The fingerprint has to be revalidated where the write happens, or the
 * catalog overwrites a change it never saw.
 */
describe('createCopilotWorkspaceServices.refreshModelCatalog under a queued settings change', () => {
  it('discards a catalog a queued settings change outran', async () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { discoveredModels: [GPT_5], enabled: true });
    updateCopilotProviderSettings(settings, {
      environmentHash: computeCopilotEnvironmentHash(settings),
    });
    const host = createHost(settings);
    const applyQueuedChange = createDeferred();
    let queued: Promise<void> | undefined;
    const stale = { ...GPT_5, displayName: 'GPT-5 from the old runtime' };
    const services = createCopilotWorkspaceServices(host, {
      modelDiscoveryService: {
        discoverModels: async () => {
          queued = host.mutateSettings(async (pending) => {
            await applyQueuedChange.promise;
            updateCopilotProviderSettings(pending as unknown as Record<string, unknown>, {
              cliPathsByHost: { [getHostnameKey()]: '/opt/homebrew/bin/copilot' },
            });
          });
          return { kind: 'loaded', models: [stale] };
        },
      },
    });

    const refresh = services.refreshModelCatalog();
    applyQueuedChange.resolve();
    const result = await refresh;
    await queued;

    expect(result.changed).toBe(false);
    const persisted = getCopilotProviderSettings(settings);
    expect(persisted.discoveredModels).toEqual([GPT_5]);
    expect(persisted.cliPathsByHost).toEqual({
      [getHostnameKey()]: '/opt/homebrew/bin/copilot',
    });
  });

  it('publishes the catalog when the queued change left the runtime inputs alone', async () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { enabled: true });
    const host = createHost(settings);
    const applyQueuedChange = createDeferred();
    let queued: Promise<void> | undefined;
    const services = createCopilotWorkspaceServices(host, {
      modelDiscoveryService: {
        discoverModels: async () => {
          queued = host.mutateSettings(async (pending) => {
            await applyQueuedChange.promise;
            (pending as unknown as Record<string, unknown>).userName = 'Ada';
          });
          return { kind: 'loaded', models: [GPT_5] };
        },
      },
    });

    const refresh = services.refreshModelCatalog();
    applyQueuedChange.resolve();
    const result = await refresh;
    await queued;

    expect(result).toMatchObject({ changed: true, persistedSettingsChanged: true });
    expect(getCopilotProviderSettings(settings).discoveredModels).toEqual([GPT_5]);
    expect(settings.userName).toBe('Ada');
  });
});

/** Externally settled promise, used to order the queued settings change deterministically. */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Externally settled discovery answer, used to order two probes against each other. */
function createDeferredDiscovery(): {
  promise: Promise<CopilotModelDiscoveryResult>;
  resolve: (result: CopilotModelDiscoveryResult) => void;
} {
  let resolve!: (result: CopilotModelDiscoveryResult) => void;
  const promise = new Promise<CopilotModelDiscoveryResult>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * The fingerprint and the provider generation say which runtime a catalog belongs to, not
 * which request asked for it. Two refreshes started under settings that never moved
 * therefore give the same answer to both checks, so nothing there can tell an older probe
 * from a newer one, and an older answer arriving last writes itself over the catalog the
 * user was just shown.
 */
describe('createCopilotWorkspaceServices.refreshModelCatalog under concurrent refreshes', () => {
  it('publishes only the newest of two discoveries that answered out of order', async () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { enabled: true });
    const host = createHost(settings);
    const answers = [createDeferredDiscovery(), createDeferredDiscovery()];
    let probe = 0;
    const services = createCopilotWorkspaceServices(host, {
      modelDiscoveryService: { discoverModels: () => answers[probe++].promise },
    });
    const superseded = { ...GPT_5, displayName: 'GPT-5 from the older probe' };

    const older = services.refreshModelCatalog();
    const newer = services.refreshModelCatalog();
    answers[1].resolve({ kind: 'loaded', models: [GPT_5] });

    expect(await newer).toMatchObject({ changed: true, persistedSettingsChanged: true });

    answers[0].resolve({ kind: 'loaded', models: [superseded] });

    expect(await older).toEqual({ changed: false });
    expect(getCopilotProviderSettings(settings).discoveredModels).toEqual([GPT_5]);
  });

  /**
   * The newest request is still the one whose answer counts when it arrives last, which is
   * the ordinary case: the older probe's write is what it supersedes, not its own.
   */
  it('publishes the newest discovery when the older one answered first', async () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { enabled: true });
    const host = createHost(settings);
    const answers = [createDeferredDiscovery(), createDeferredDiscovery()];
    let probe = 0;
    const services = createCopilotWorkspaceServices(host, {
      modelDiscoveryService: { discoverModels: () => answers[probe++].promise },
    });
    const widened = { ...GPT_5, contextWindow: 400_000 };

    const older = services.refreshModelCatalog();
    const newer = services.refreshModelCatalog();
    answers[0].resolve({ kind: 'loaded', models: [GPT_5] });
    await older;
    answers[1].resolve({ kind: 'loaded', models: [widened] });

    expect(await newer).toMatchObject({ changed: true, persistedSettingsChanged: true });
    expect(getCopilotProviderSettings(settings).discoveredModels).toEqual([widened]);
  });
});

/**
 * A fingerprint says what the runtime inputs are, not whether they held still. Settings
 * that changed and changed back while the CLI was answering produce the fingerprint
 * discovery started under, so the fingerprint alone cannot tell a runtime that never
 * moved from one the user rebuilt underneath the probe — and the probe resolves its own
 * CLI path and environment after that fingerprint is taken, so the catalog can belong to
 * the runtime in between.
 *
 * The provider's runtime generation moves once per settings transition and never moves
 * back, which is what makes the difference visible.
 */
describe('createCopilotWorkspaceServices.refreshModelCatalog under a runtime that moved and moved back', () => {
  it('discards a catalog discovered across a change that was reverted', async () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { discoveredModels: [GPT_5], enabled: true });
    updateCopilotProviderSettings(settings, {
      environmentHash: computeCopilotEnvironmentHash(settings),
    });
    const host = createHost(settings);
    const stale = { ...GPT_5, displayName: 'GPT-5 from the runtime in between' };
    const services = createCopilotWorkspaceServices(host, {
      modelDiscoveryService: {
        discoverModels: async () => {
          updateCopilotProviderSettings(settings, {
            cliPathsByHost: { [getHostnameKey()]: '/opt/homebrew/bin/copilot' },
          });
          advanceGeneration(settings);
          updateCopilotProviderSettings(settings, { cliPathsByHost: {} });
          advanceGeneration(settings);
          return { kind: 'loaded', models: [stale] };
        },
      },
    });

    const result = await services.refreshModelCatalog();

    expect(result.changed).toBe(false);
    expect(getCopilotProviderSettings(settings).discoveredModels).toEqual([GPT_5]);
  });

  it('discards a catalog a transition queued ahead of the write outran', async () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { discoveredModels: [GPT_5], enabled: true });
    updateCopilotProviderSettings(settings, {
      environmentHash: computeCopilotEnvironmentHash(settings),
    });
    const host = createHost(settings);
    const applyQueuedChange = createDeferred();
    let queued: Promise<void> | undefined;
    const stale = { ...GPT_5, displayName: 'GPT-5 from the runtime in between' };
    const services = createCopilotWorkspaceServices(host, {
      modelDiscoveryService: {
        discoverModels: async () => {
          queued = host.mutateSettings(async () => {
            await applyQueuedChange.promise;
            advanceGeneration(settings);
          });
          return { kind: 'loaded', models: [stale] };
        },
      },
    });

    const refresh = services.refreshModelCatalog();
    applyQueuedChange.resolve();
    const result = await refresh;
    await queued;

    expect(result.changed).toBe(false);
    expect(getCopilotProviderSettings(settings).discoveredModels).toEqual([GPT_5]);
  });

  it('publishes the catalog when the runtime never moved', async () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { enabled: true });
    advanceGeneration(settings);
    const host = createHost(settings);
    const services = createServices(host, [{ kind: 'loaded', models: [GPT_5] }]);

    expect(await services.refreshModelCatalog())
      .toMatchObject({ changed: true, persistedSettingsChanged: true });
    expect(getCopilotProviderSettings(settings).discoveredModels).toEqual([GPT_5]);
  });
});
