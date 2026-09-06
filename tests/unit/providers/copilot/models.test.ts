import {
  COPILOT_CONTEXT_WINDOW_FALLBACK,
  decodeCopilotModelId,
  encodeCopilotModelId,
  findCopilotModel,
  getCopilotReasoningOptions,
  isCopilotModelSelectionId,
  isCopilotReasoningEffort,
  normalizeCopilotDiscoveredModels,
  resolveCopilotContextWindow,
  resolveCopilotDefaultReasoningEffort,
} from '@/providers/copilot/models';

describe('Copilot model selection ids', () => {
  it('round-trips a raw model id through the provider prefix', () => {
    expect(encodeCopilotModelId('gpt-5')).toBe('copilot/gpt-5');
    expect(decodeCopilotModelId('copilot/gpt-5')).toBe('gpt-5');
  });

  it('is idempotent when the id is already encoded', () => {
    expect(encodeCopilotModelId('copilot/gpt-5')).toBe('copilot/gpt-5');
  });

  it('rejects ids owned by another provider or with an empty body', () => {
    expect(decodeCopilotModelId('grok/gpt-5')).toBeNull();
    expect(decodeCopilotModelId('copilot/')).toBeNull();
    expect(decodeCopilotModelId('copilot/   ')).toBeNull();
    expect(encodeCopilotModelId('   ')).toBe('');
    expect(isCopilotModelSelectionId('gpt-5')).toBe(false);
    expect(isCopilotModelSelectionId(' copilot/gpt-5 ')).toBe(true);
  });
});

describe('normalizeCopilotDiscoveredModels', () => {
  it('normalizes a discovered SDK model into the persisted shape', () => {
    expect(normalizeCopilotDiscoveredModels([{
      description: 'Balanced model',
      id: '  gpt-5  ',
      maxContextWindowTokens: 272_000.7,
      name: 'GPT-5',
      reasoningEffort: 'high',
      supportedReasoningEfforts: ['high', 'low', 'low'],
      supportsVision: true,
    }])).toEqual([{
      contextWindow: 272_000,
      defaultReasoningEffort: 'high',
      description: 'Balanced model',
      displayName: 'GPT-5',
      rawId: 'gpt-5',
      reasoningEfforts: ['low', 'high'],
      supportsReasoning: true,
      supportsVision: true,
    }]);
  });

  it('falls back to the raw id when no display name is provided', () => {
    expect(normalizeCopilotDiscoveredModels([{ id: 'gpt-5' }])).toEqual([{
      displayName: 'gpt-5',
      rawId: 'gpt-5',
      reasoningEfforts: [],
      supportsReasoning: false,
      supportsVision: false,
    }]);
  });

  it('drops entries without a usable id and non-array input', () => {
    expect(normalizeCopilotDiscoveredModels([{ id: '  ' }, null, 'gpt-5', 7])).toEqual([]);
    expect(normalizeCopilotDiscoveredModels('not-an-array')).toEqual([]);
  });

  it('rejects reasoning efforts the CLI does not accept', () => {
    const [model] = normalizeCopilotDiscoveredModels([{
      id: 'gpt-5',
      reasoningEffort: 'ultra',
      supportedReasoningEfforts: ['low', 'ultra', 42],
    }]);

    expect(model.reasoningEfforts).toEqual(['low']);
    expect(model.defaultReasoningEffort).toBeUndefined();
  });

  it('drops a declared default the model does not advertise', () => {
    const [model] = normalizeCopilotDiscoveredModels([{
      defaultReasoningEffort: 'max',
      id: 'gpt-5',
      supportedReasoningEfforts: ['low', 'medium'],
    }]);

    expect(model.defaultReasoningEffort).toBeUndefined();
  });

  it('ignores a non-positive context window', () => {
    const [model] = normalizeCopilotDiscoveredModels([
      { id: 'gpt-5', maxContextWindowTokens: 0 },
    ]);

    expect(model.contextWindow).toBeUndefined();
  });

  /**
   * A context window is a token count, so it is read as whole tokens. A value below one
   * whole token describes no window at all, and keeping it would leave every turn's
   * budget divided by a window of zero rather than by the shared default.
   */
  it('ignores a context window that is not a whole token', () => {
    for (const maxContextWindowTokens of [0.4, 0.999, -0.5]) {
      const [model] = normalizeCopilotDiscoveredModels([
        { id: 'gpt-5', maxContextWindowTokens },
      ]);

      expect(model.contextWindow).toBeUndefined();
    }
  });

  it('keeps the last entry when a model id repeats', () => {
    expect(normalizeCopilotDiscoveredModels([
      { id: 'gpt-5', name: 'First' },
      { id: 'gpt-5', name: 'Second' },
    ]).map(model => model.displayName)).toEqual(['Second']);
  });
});

describe('isCopilotReasoningEffort', () => {
  it('accepts exactly the efforts the SDK reasoning union declares', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(isCopilotReasoningEffort(effort)).toBe(true);
    }
    expect(isCopilotReasoningEffort('none')).toBe(false);
    expect(isCopilotReasoningEffort('ultra')).toBe(false);
    expect(isCopilotReasoningEffort(undefined)).toBe(false);
  });
});

describe('resolveCopilotDefaultReasoningEffort', () => {
  const reasoningModel = {
    displayName: 'GPT-5',
    rawId: 'gpt-5',
    reasoningEfforts: ['low', 'medium', 'high'] as const,
    supportsReasoning: true,
    supportsVision: false,
  };

  it('prefers a stored preference the model advertises', () => {
    expect(resolveCopilotDefaultReasoningEffort(
      { ...reasoningModel, reasoningEfforts: [...reasoningModel.reasoningEfforts] },
      'low',
    )).toBe('low');
  });

  it('falls back to the declared model default when the preference is unavailable', () => {
    expect(resolveCopilotDefaultReasoningEffort({
      ...reasoningModel,
      defaultReasoningEffort: 'medium',
      reasoningEfforts: [...reasoningModel.reasoningEfforts],
    }, 'max')).toBe('medium');
  });

  it('falls back to the shared ordered default when nothing else applies', () => {
    expect(resolveCopilotDefaultReasoningEffort({
      ...reasoningModel,
      reasoningEfforts: [...reasoningModel.reasoningEfforts],
    })).toBe('high');
  });

  it('uses the first advertised effort when no standard value is offered', () => {
    expect(resolveCopilotDefaultReasoningEffort({
      ...reasoningModel,
      reasoningEfforts: ['xhigh', 'max'],
    })).toBe('xhigh');
  });

  it('returns null for a model without reasoning control', () => {
    expect(resolveCopilotDefaultReasoningEffort({
      ...reasoningModel,
      reasoningEfforts: [],
      supportsReasoning: false,
    })).toBeNull();
    expect(resolveCopilotDefaultReasoningEffort(null)).toBeNull();
  });
});

describe('getCopilotReasoningOptions', () => {
  it('exposes nothing for a model that does not support reasoning', () => {
    expect(getCopilotReasoningOptions({
      displayName: 'GPT-5',
      rawId: 'gpt-5',
      reasoningEfforts: ['low'],
      supportsReasoning: false,
      supportsVision: false,
    })).toEqual([]);
  });
});

describe('resolveCopilotContextWindow', () => {
  const models = normalizeCopilotDiscoveredModels([
    { id: 'gpt-5', maxContextWindowTokens: 272_000 },
    { id: 'no-window' },
  ]);

  it('prefers the discovered context window', () => {
    expect(resolveCopilotContextWindow('copilot/gpt-5', models)).toBe(272_000);
  });

  it('uses a custom limit keyed by selection id or raw id', () => {
    expect(resolveCopilotContextWindow('copilot/no-window', models, {
      'copilot/no-window': 64_000,
    })).toBe(64_000);
    expect(resolveCopilotContextWindow('copilot/no-window', models, {
      'no-window': 32_000,
    })).toBe(32_000);
  });

  it('falls back to the shared default for an unknown model', () => {
    expect(resolveCopilotContextWindow('copilot/unknown', models))
      .toBe(COPILOT_CONTEXT_WINDOW_FALLBACK);
  });

  /**
   * Custom limits are typed into settings, so they are read as whole tokens on the way
   * out. A limit below one whole token names no window the caller could divide by, and
   * the shared default is a usable answer where that value is not.
   */
  it('falls back to the shared default for a limit below one whole token', () => {
    for (const limit of [0.4, 0.999, 0, -8]) {
      expect(resolveCopilotContextWindow('copilot/no-window', models, {
        'copilot/no-window': limit,
      })).toBe(COPILOT_CONTEXT_WINDOW_FALLBACK);
    }
  });

  it('reads a fractional custom limit as whole tokens', () => {
    expect(resolveCopilotContextWindow('copilot/no-window', models, {
      'copilot/no-window': 64_000.7,
    })).toBe(64_000);
  });
});

describe('findCopilotModel', () => {
  const models = normalizeCopilotDiscoveredModels([{ id: 'gpt-5' }]);

  it('matches by selection id and by raw id', () => {
    expect(findCopilotModel(models, 'copilot/gpt-5')?.rawId).toBe('gpt-5');
    expect(findCopilotModel(models, 'gpt-5')?.rawId).toBe('gpt-5');
    expect(findCopilotModel(models, '  ')).toBeNull();
  });
});
