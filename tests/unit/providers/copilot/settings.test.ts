import type { CopilotDiscoveredModel } from '@/providers/copilot/models';
import {
  DEFAULT_COPILOT_PROVIDER_SETTINGS,
  getCopilotProviderSettings,
  getEnabledCopilotModels,
  updateCopilotProviderSettings,
} from '@/providers/copilot/settings';

function settingsWithConfig(config: Record<string, unknown>): Record<string, unknown> {
  return { providerConfigs: { copilot: config } };
}

const discoveredModel: CopilotDiscoveredModel = {
  contextWindow: 200_000,
  defaultReasoningEffort: 'medium',
  displayName: 'Claude Sonnet 4.5',
  rawId: 'claude-sonnet-4.5',
  reasoningEfforts: ['low', 'medium', 'high'],
  supportsReasoning: true,
  supportsVision: true,
};

describe('getCopilotProviderSettings', () => {
  it('defaults to disabled with no models when nothing is persisted', () => {
    expect(getCopilotProviderSettings({})).toEqual(DEFAULT_COPILOT_PROVIDER_SETTINGS);
  });

  it('fails closed on every malformed persisted field', () => {
    const settings = settingsWithConfig({
      cliPath: 7,
      cliPathsByHost: 'not-a-map',
      discoveredModels: 'not-an-array',
      enabled: 'true',
      environmentHash: false,
      environmentVariables: ['SECRET=leaked'],
      modelAliases: ['nope'],
      preferredReasoningByModel: 42,
      visibleModels: { nope: true },
    });

    expect(getCopilotProviderSettings(settings)).toEqual(DEFAULT_COPILOT_PROVIDER_SETTINGS);
  });

  it('only treats a literal true as enabled', () => {
    expect(getCopilotProviderSettings(settingsWithConfig({ enabled: 1 })).enabled).toBe(false);
    expect(getCopilotProviderSettings(settingsWithConfig({ enabled: 'yes' })).enabled).toBe(false);
    expect(getCopilotProviderSettings(settingsWithConfig({ enabled: true })).enabled).toBe(true);
  });

  it('drops enabled models and aliases that no longer exist in the catalog', () => {
    const providerSettings = getCopilotProviderSettings(settingsWithConfig({
      discoveredModels: [discoveredModel],
      modelAliases: { 'claude-sonnet-4.5': 'Sonnet', 'retired-model': 'Ghost' },
      visibleModels: ['claude-sonnet-4.5', 'retired-model'],
    }));

    expect(providerSettings.visibleModels).toEqual(['claude-sonnet-4.5']);
    expect(providerSettings.modelAliases).toEqual({ 'claude-sonnet-4.5': 'Sonnet' });
  });

  it('keeps a model an existing selection still points at', () => {
    const providerSettings = getCopilotProviderSettings({
      model: 'copilot/legacy-model',
      providerConfigs: { copilot: { visibleModels: ['legacy-model'] } },
    });

    expect(providerSettings.visibleModels).toEqual(['legacy-model']);
  });

  it('rejects a stored reasoning effort the model does not advertise', () => {
    const providerSettings = getCopilotProviderSettings(settingsWithConfig({
      discoveredModels: [discoveredModel],
      preferredReasoningByModel: {
        'claude-sonnet-4.5': 'xhigh',
        'unknown-model': 'high',
      },
    }));

    expect(providerSettings.preferredReasoningByModel).toEqual({});
  });

  it('keeps a stored reasoning effort the model advertises', () => {
    const providerSettings = getCopilotProviderSettings(settingsWithConfig({
      discoveredModels: [discoveredModel],
      preferredReasoningByModel: { 'claude-sonnet-4.5': 'high' },
    }));

    expect(providerSettings.preferredReasoningByModel).toEqual({
      'claude-sonnet-4.5': 'high',
    });
  });

  it('accepts model selection ids for enabled models and aliases', () => {
    const providerSettings = getCopilotProviderSettings(settingsWithConfig({
      discoveredModels: [discoveredModel],
      modelAliases: { 'copilot/claude-sonnet-4.5': 'Sonnet' },
      visibleModels: ['copilot/claude-sonnet-4.5'],
    }));

    expect(providerSettings.visibleModels).toEqual(['claude-sonnet-4.5']);
    expect(providerSettings.modelAliases).toEqual({ 'claude-sonnet-4.5': 'Sonnet' });
  });
});

describe('updateCopilotProviderSettings', () => {
  it('writes a bare cliPath into the current host scope', () => {
    const settings: Record<string, unknown> = {};

    const updated = updateCopilotProviderSettings(settings, { cliPath: '/usr/local/bin/copilot' });

    expect(updated.cliPath).toBe('');
    expect(Object.values(updated.cliPathsByHost)).toEqual(['/usr/local/bin/copilot']);
    expect(getCopilotProviderSettings(settings).cliPathsByHost).toEqual(updated.cliPathsByHost);
  });

  it('clears the host CLI path when an empty value is written', () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { cliPath: '/usr/local/bin/copilot' });

    const updated = updateCopilotProviderSettings(settings, { cliPath: '  ' });

    expect(updated.cliPathsByHost).toEqual({});
  });

  it('drops enabled models that a replacement catalog no longer contains', () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, {
      discoveredModels: [discoveredModel],
      modelAliases: { 'claude-sonnet-4.5': 'sonnet' },
      preferredReasoningByModel: { 'claude-sonnet-4.5': 'high' },
      visibleModels: ['claude-sonnet-4.5'],
    });

    const updated = updateCopilotProviderSettings(settings, {
      discoveredModels: [{ ...discoveredModel, rawId: 'gpt-5' }],
    });

    expect(updated.visibleModels).toEqual([]);
    expect(updated.modelAliases).toEqual({});
    expect(updated.preferredReasoningByModel).toEqual({});
  });

  /**
   * An empty catalog means the fingerprint changed and rediscovery has not run yet.
   * Dropping the selection there would discard work the user did, so it is kept until a
   * catalog exists that can say the model is gone for good.
   */
  it('keeps the selection while the catalog is empty', () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, {
      discoveredModels: [discoveredModel],
      modelAliases: { 'claude-sonnet-4.5': 'sonnet' },
      preferredReasoningByModel: { 'claude-sonnet-4.5': 'high' },
      visibleModels: ['claude-sonnet-4.5'],
    });

    const cleared = updateCopilotProviderSettings(settings, { discoveredModels: [] });

    expect(cleared.visibleModels).toEqual(['claude-sonnet-4.5']);
    expect(cleared.modelAliases).toEqual({ 'claude-sonnet-4.5': 'sonnet' });
    expect(cleared.preferredReasoningByModel).toEqual({ 'claude-sonnet-4.5': 'high' });

    const rediscovered = updateCopilotProviderSettings(settings, {
      discoveredModels: [discoveredModel],
    });

    expect(rediscovered.visibleModels).toEqual(['claude-sonnet-4.5']);
    expect(rediscovered.modelAliases).toEqual({ 'claude-sonnet-4.5': 'sonnet' });
    expect(rediscovered.preferredReasoningByModel).toEqual({ 'claude-sonnet-4.5': 'high' });
  });

  it('contributes no selectable model while the catalog is empty', () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, {
      discoveredModels: [discoveredModel],
      visibleModels: ['claude-sonnet-4.5'],
    });
    updateCopilotProviderSettings(settings, { discoveredModels: [] });

    expect(getEnabledCopilotModels(getCopilotProviderSettings(settings))).toEqual([]);
  });

  it('persists a normalized round trip', () => {
    const settings: Record<string, unknown> = {};

    updateCopilotProviderSettings(settings, {
      discoveredModels: [discoveredModel],
      enabled: true,
      preferredReasoningByModel: { 'claude-sonnet-4.5': 'low' },
      visibleModels: ['claude-sonnet-4.5'],
    });

    expect(getCopilotProviderSettings(settings)).toMatchObject({
      enabled: true,
      preferredReasoningByModel: { 'claude-sonnet-4.5': 'low' },
      visibleModels: ['claude-sonnet-4.5'],
    });
  });
});

describe('getEnabledCopilotModels', () => {
  it('returns only enabled models in the order the user arranged them', () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, {
      discoveredModels: [
        discoveredModel,
        { ...discoveredModel, displayName: 'GPT-5', rawId: 'gpt-5' },
      ],
      visibleModels: ['gpt-5', 'claude-sonnet-4.5'],
    });

    expect(
      getEnabledCopilotModels(getCopilotProviderSettings(settings)).map(model => model.rawId),
    ).toEqual(['gpt-5', 'claude-sonnet-4.5']);
  });

  it('contributes no models when nothing is explicitly enabled', () => {
    const settings: Record<string, unknown> = {};
    updateCopilotProviderSettings(settings, { discoveredModels: [discoveredModel] });

    expect(getEnabledCopilotModels(getCopilotProviderSettings(settings))).toEqual([]);
  });
});
