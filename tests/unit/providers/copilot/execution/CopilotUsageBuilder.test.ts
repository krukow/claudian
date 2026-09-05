import type { CopilotUsageEventData } from '@/providers/copilot/execution/CopilotEventNormalizer';
import { buildCopilotUsageInfo } from '@/providers/copilot/execution/CopilotUsageBuilder';
import { normalizeCopilotDiscoveredModels } from '@/providers/copilot/models';

const discoveredModels = normalizeCopilotDiscoveredModels([
  { id: 'gpt-5', maxContextWindowTokens: 200_000 },
]);

function usageData(overrides: Partial<CopilotUsageEventData> = {}): CopilotUsageEventData {
  return { model: 'gpt-5', ...overrides } as CopilotUsageEventData;
}

describe('buildCopilotUsageInfo', () => {
  it('projects prompt tokens onto the Claudian usage contract', () => {
    expect(buildCopilotUsageInfo(usageData({
      cacheReadTokens: 5_000,
      cacheWriteTokens: 1_000,
      inputTokens: 15_000,
      outputTokens: 900,
    }), { discoveredModels, selectedModelId: 'copilot/gpt-5' })).toEqual({
      cacheCreationInputTokens: 1_000,
      cacheReadInputTokens: 5_000,
      contextTokens: 20_000,
      contextWindow: 200_000,
      inputTokens: 15_000,
      model: 'gpt-5',
      percentage: 10,
    });
  });

  it('excludes output tokens from context occupancy', () => {
    const usage = buildCopilotUsageInfo(usageData({
      inputTokens: 1_000,
      outputTokens: 50_000,
    }), { discoveredModels, selectedModelId: 'copilot/gpt-5' });

    expect(usage?.contextTokens).toBe(1_000);
  });

  it('uses the discovered context window for the selected model', () => {
    expect(buildCopilotUsageInfo(usageData({ inputTokens: 100 }), {
      discoveredModels,
      selectedModelId: 'copilot/gpt-5',
    })?.contextWindow).toBe(200_000);
  });

  it('falls back to the shared default for an unknown model', () => {
    expect(buildCopilotUsageInfo(usageData({ inputTokens: 100 }), {
      discoveredModels,
      selectedModelId: 'copilot/unknown',
    })?.contextWindow).toBe(128_000);
  });

  it('prefers a configured custom context limit', () => {
    expect(buildCopilotUsageInfo(usageData({ inputTokens: 100 }), {
      customContextLimits: { 'copilot/unknown': 64_000 },
      discoveredModels,
      selectedModelId: 'copilot/unknown',
    })?.contextWindow).toBe(64_000);
  });

  it('caps the reported percentage at 100', () => {
    expect(buildCopilotUsageInfo(usageData({ inputTokens: 500_000 }), {
      discoveredModels,
      selectedModelId: 'copilot/gpt-5',
    })?.percentage).toBe(100);
  });

  it('returns null when the report carries no prompt tokens', () => {
    expect(buildCopilotUsageInfo(usageData({ outputTokens: 42 }), {
      discoveredModels,
      selectedModelId: 'copilot/gpt-5',
    })).toBeNull();
  });

  it('ignores negative and non-finite token counts', () => {
    expect(buildCopilotUsageInfo(usageData({
      cacheReadTokens: Number.NaN,
      inputTokens: -5,
    }), { discoveredModels, selectedModelId: 'copilot/gpt-5' })).toBeNull();
  });

  it('omits the model when the report does not name one', () => {
    expect(buildCopilotUsageInfo({ inputTokens: 10 } as CopilotUsageEventData, {
      discoveredModels,
      selectedModelId: 'copilot/gpt-5',
    })).not.toHaveProperty('model');
  });
});
