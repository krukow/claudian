import type { UsageInfo } from '../../../core/types';
import {
  type CopilotDiscoveredModel,
  resolveCopilotContextWindow,
} from '../models';
import type { CopilotUsageEventData } from './CopilotEventNormalizer';

export interface CopilotUsageBuilderOptions {
  readonly customContextLimits?: Record<string, number>;
  readonly discoveredModels: readonly CopilotDiscoveredModel[];
  /** Claudian's model selection id for the turn, used to resolve the context window. */
  readonly selectedModelId: string;
}

/**
 * Projects a Copilot usage report onto Claudian's usage contract.
 *
 * Context occupancy is the prompt side of the exchange: fresh input plus what the runtime
 * served from cache. Output tokens are billed but are not resident context, so they are
 * deliberately excluded from the occupancy figure.
 */
export function buildCopilotUsageInfo(
  data: CopilotUsageEventData,
  options: CopilotUsageBuilderOptions,
): UsageInfo | null {
  const inputTokens = readTokenCount(data.inputTokens);
  const cacheReadInputTokens = readTokenCount(data.cacheReadTokens);
  const cacheCreationInputTokens = readTokenCount(data.cacheWriteTokens);
  if (
    inputTokens === 0
    && cacheReadInputTokens === 0
    && cacheCreationInputTokens === 0
  ) {
    return null;
  }

  const contextWindow = resolveCopilotContextWindow(
    options.selectedModelId,
    options.discoveredModels,
    options.customContextLimits ?? {},
  );
  const contextTokens = inputTokens + cacheReadInputTokens;

  return {
    cacheCreationInputTokens,
    cacheReadInputTokens,
    contextTokens,
    contextWindow,
    inputTokens,
    ...(typeof data.model === 'string' && data.model ? { model: data.model } : {}),
    percentage: contextWindow > 0
      ? Math.min(100, (contextTokens / contextWindow) * 100)
      : 0,
  };
}

function readTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}
