import type { CopilotDiscoveredModel } from '@/providers/copilot/models';
import {
  getCopilotProviderSettings,
  updateCopilotProviderSettings,
} from '@/providers/copilot/settings';
import { copilotChatUIConfig } from '@/providers/copilot/ui/CopilotChatUIConfig';

const gpt5: CopilotDiscoveredModel = {
  contextWindow: 272_000,
  defaultReasoningEffort: 'medium',
  description: 'Balanced model',
  displayName: 'GPT-5',
  rawId: 'gpt-5',
  reasoningEfforts: ['low', 'medium', 'high'],
  supportsReasoning: true,
  supportsVision: true,
};

const sonnet: CopilotDiscoveredModel = {
  contextWindow: 200_000,
  displayName: 'Claude Sonnet 4.5',
  rawId: 'claude-sonnet-4.5',
  reasoningEfforts: [],
  supportsReasoning: false,
  supportsVision: true,
};

function settingsWith(visibleModels: string[]): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  updateCopilotProviderSettings(settings, {
    discoveredModels: [gpt5, sonnet],
    enabled: true,
    visibleModels,
  });
  return settings;
}

describe('copilotChatUIConfig model options', () => {
  it('lists only enabled models in the order the user arranged them', () => {
    expect(copilotChatUIConfig.getModelOptions(settingsWith(['claude-sonnet-4.5', 'gpt-5'])))
      .toEqual([
        {
          description: undefined,
          label: 'Claude Sonnet 4.5',
          value: 'copilot/claude-sonnet-4.5',
        },
        {
          description: 'Balanced model',
          label: 'GPT-5',
          value: 'copilot/gpt-5',
        },
      ].map(option => (
        option.description === undefined
          ? { label: option.label, value: option.value }
          : option
      )));
  });

  it('contributes nothing when the user enabled no models', () => {
    expect(copilotChatUIConfig.getModelOptions(settingsWith([]))).toEqual([]);
    expect(copilotChatUIConfig.getDefaultModel?.(settingsWith([]))).toBeNull();
  });

  it('uses a configured alias as the option label', () => {
    const settings = settingsWith(['gpt-5']);
    updateCopilotProviderSettings(settings, { modelAliases: { 'gpt-5': 'Fast' } });

    expect(copilotChatUIConfig.getModelOptions(settings)[0].label).toBe('Fast');
  });

  it('defaults to the first enabled model', () => {
    expect(copilotChatUIConfig.getDefaultModel?.(settingsWith(['gpt-5', 'claude-sonnet-4.5'])))
      .toBe('copilot/gpt-5');
  });

  it('owns only enabled Copilot selections', () => {
    const settings = settingsWith(['gpt-5']);

    expect(copilotChatUIConfig.ownsModel('copilot/gpt-5', settings)).toBe(true);
    expect(copilotChatUIConfig.ownsModel('copilot/claude-sonnet-4.5', settings)).toBe(false);
    expect(copilotChatUIConfig.ownsModel('grok/grok-4', settings)).toBe(false);
  });
});

describe('copilotChatUIConfig reasoning', () => {
  it('exposes the reasoning efforts an enabled model advertises', () => {
    expect(copilotChatUIConfig.getReasoningOptions('copilot/gpt-5', settingsWith(['gpt-5'])))
      .toEqual([
        { label: 'Low', value: 'low' },
        { label: 'Medium', value: 'medium' },
        { label: 'High', value: 'high' },
      ]);
    expect(copilotChatUIConfig.isAdaptiveReasoningModel(
      'copilot/gpt-5',
      settingsWith(['gpt-5']),
    )).toBe(true);
  });

  it('exposes nothing for a model without reasoning control', () => {
    const settings = settingsWith(['claude-sonnet-4.5']);

    expect(copilotChatUIConfig.getReasoningOptions('copilot/claude-sonnet-4.5', settings))
      .toEqual([]);
    expect(copilotChatUIConfig.getDefaultReasoningValue('copilot/claude-sonnet-4.5', settings))
      .toBe('');
  });

  it('exposes nothing for a model the user has not enabled', () => {
    expect(copilotChatUIConfig.getReasoningOptions('copilot/gpt-5', settingsWith([])))
      .toEqual([]);
  });

  it('prefers the declared model default over the shared fallback', () => {
    expect(copilotChatUIConfig.getDefaultReasoningValue(
      'copilot/gpt-5',
      settingsWith(['gpt-5']),
    )).toBe('medium');
  });

  it('persists a supported reasoning selection and rejects an unsupported one', () => {
    const settings = settingsWith(['gpt-5']);

    copilotChatUIConfig.applyReasoningSelection?.('copilot/gpt-5', 'low', settings);
    expect(getCopilotProviderSettings(settings).preferredReasoningByModel)
      .toEqual({ 'gpt-5': 'low' });

    copilotChatUIConfig.applyReasoningSelection?.('copilot/gpt-5', 'max', settings);
    expect(getCopilotProviderSettings(settings).preferredReasoningByModel).toEqual({});
  });
});

describe('copilotChatUIConfig model application', () => {
  it('applies the model and its default effort together', () => {
    const settings = settingsWith(['gpt-5']);

    copilotChatUIConfig.applyModelDefaults('copilot/gpt-5', settings);

    expect(settings.model).toBe('copilot/gpt-5');
    expect(settings.effortLevel).toBe('medium');
  });

  it('ignores a selection owned by another provider', () => {
    const settings = settingsWith(['gpt-5']);

    copilotChatUIConfig.applyModelDefaults('grok/grok-4', settings);

    expect(settings.model).toBeUndefined();
  });

  it('clears the effort projection for a non-Copilot model', () => {
    const settings = settingsWith(['gpt-5']);
    settings.effortLevel = 'high';

    copilotChatUIConfig.applyModelProjectionDefaults?.('grok/grok-4', settings);

    expect(settings.effortLevel).toBeUndefined();
  });

  it('canonicalizes a model variant', () => {
    expect(copilotChatUIConfig.normalizeModelVariant('  copilot/gpt-5  ', {}))
      .toBe('copilot/gpt-5');
    expect(copilotChatUIConfig.normalizeModelVariant('grok/grok-4', {}))
      .toBe('grok/grok-4');
  });
});

describe('copilotChatUIConfig context window', () => {
  it('uses the discovered window and falls back for an unknown model', () => {
    const settings = settingsWith(['gpt-5']);

    expect(copilotChatUIConfig.getContextWindowSize('copilot/gpt-5', {}, settings))
      .toBe(272_000);
    expect(copilotChatUIConfig.getContextWindowSize('copilot/unknown', {}, settings))
      .toBe(128_000);
    expect(copilotChatUIConfig.getContextWindowSize(
      'copilot/unknown',
      { 'copilot/unknown': 64_000 },
      settings,
    )).toBe(64_000);
  });
});

describe('copilotChatUIConfig toolbar controls', () => {
  it('offers no permission-mode toggle, because approvals are always interactive', () => {
    expect(copilotChatUIConfig.getPermissionModeToggle?.()).toBeNull();
    expect(copilotChatUIConfig.getModeSelector?.({})).toBeNull();
  });

  it('declares no custom model ids from the environment', () => {
    expect(copilotChatUIConfig.getCustomModelIds({})).toEqual(new Set());
  });
});
