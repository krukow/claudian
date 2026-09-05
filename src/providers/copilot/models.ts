import {
  formatReasoningValueLabel,
  resolvePreferredReasoningDefault,
} from '../../core/providers/reasoning';
import type { ReasoningEffort as SdkReasoningEffort } from './sdk/copilotSdkModule';

/**
 * The exact `ReasoningEffort` union the Copilot SDK accepts. Persisted and discovered
 * values are validated against it so an unknown effort can never reach `setModel`.
 */
export const COPILOT_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly SdkReasoningEffort[];

export type CopilotReasoningEffort = (typeof COPILOT_REASONING_EFFORTS)[number];

export interface CopilotDiscoveredModel {
  contextWindow?: number;
  defaultReasoningEffort?: CopilotReasoningEffort;
  description?: string;
  displayName: string;
  rawId: string;
  reasoningEfforts: CopilotReasoningEffort[];
  supportsReasoning: boolean;
  supportsVision: boolean;
}

export const COPILOT_MODEL_PREFIX = 'copilot/';
export const COPILOT_CONTEXT_WINDOW_FALLBACK = 128_000;

const REASONING_EFFORT_VALUES: ReadonlySet<string> = new Set(COPILOT_REASONING_EFFORTS);
const REASONING_EFFORT_ORDER = new Map(
  COPILOT_REASONING_EFFORTS.map((effort, index) => [effort, index] as const),
);

export function isCopilotReasoningEffort(value: unknown): value is CopilotReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORT_VALUES.has(value);
}

export function isCopilotModelSelectionId(model: string): boolean {
  return decodeCopilotModelId(model.trim()) !== null;
}

export function encodeCopilotModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  if (!normalized || normalized === COPILOT_MODEL_PREFIX) {
    return '';
  }
  return normalized.startsWith(COPILOT_MODEL_PREFIX)
    ? normalized
    : `${COPILOT_MODEL_PREFIX}${normalized}`;
}

export function decodeCopilotModelId(model: string): string | null {
  const normalized = model.trim();
  if (!normalized.startsWith(COPILOT_MODEL_PREFIX)) {
    return null;
  }
  const rawModelId = normalized.slice(COPILOT_MODEL_PREFIX.length).trim();
  return rawModelId || null;
}

export function normalizeCopilotDiscoveredModels(value: unknown): CopilotDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalizedById = new Map<string, CopilotDiscoveredModel>();
  for (const entry of value) {
    const model = normalizeCopilotDiscoveredModel(entry);
    if (model) {
      normalizedById.set(model.rawId, model);
    }
  }
  return [...normalizedById.values()];
}

/**
 * Compares two catalogs field by field, in order.
 *
 * Discovery persists on any difference, so a model whose context window, reasoning
 * efforts, display name, or vision support changed is written back rather than hidden
 * behind an unchanged id.
 */
export function sameCopilotDiscoveredModels(
  left: readonly CopilotDiscoveredModel[],
  right: readonly CopilotDiscoveredModel[],
): boolean {
  return left.length === right.length
    && left.every((model, index) => sameCopilotDiscoveredModel(model, right[index]));
}

function sameCopilotDiscoveredModel(
  left: CopilotDiscoveredModel,
  right: CopilotDiscoveredModel | undefined,
): boolean {
  return right !== undefined
    && left.rawId === right.rawId
    && left.displayName === right.displayName
    && left.description === right.description
    && left.contextWindow === right.contextWindow
    && left.supportsReasoning === right.supportsReasoning
    && left.supportsVision === right.supportsVision
    && left.defaultReasoningEffort === right.defaultReasoningEffort
    && left.reasoningEfforts.length === right.reasoningEfforts.length
    && left.reasoningEfforts.every((effort, index) => effort === right.reasoningEfforts[index]);
}

export function findCopilotModel(
  models: readonly CopilotDiscoveredModel[],
  modelId: string,
): CopilotDiscoveredModel | null {
  const rawModelId = decodeCopilotModelId(modelId) ?? modelId.trim();
  if (!rawModelId) {
    return null;
  }
  return models.find(model => model.rawId === rawModelId) ?? null;
}

export function getCopilotReasoningOptions(
  model: CopilotDiscoveredModel | null | undefined,
): readonly CopilotReasoningEffort[] {
  if (!model?.supportsReasoning) {
    return [];
  }
  return model.reasoningEfforts;
}

/**
 * Resolves the effort a turn runs with. A stored preference wins when the model still
 * advertises it, then the model's own default, then the shared ordered fallback.
 */
export function resolveCopilotDefaultReasoningEffort(
  model: CopilotDiscoveredModel | null | undefined,
  preferredEffort?: string,
): CopilotReasoningEffort | null {
  const available = getCopilotReasoningOptions(model);
  if (available.length === 0) {
    return null;
  }

  const preferred = typeof preferredEffort === 'string' ? preferredEffort.trim() : '';
  if (isCopilotReasoningEffort(preferred) && available.includes(preferred)) {
    return preferred;
  }

  const declaredDefault = model?.defaultReasoningEffort;
  if (declaredDefault && available.includes(declaredDefault)) {
    return declaredDefault;
  }

  const resolved = resolvePreferredReasoningDefault(available, available[0]);
  return isCopilotReasoningEffort(resolved) ? resolved : available[0];
}

export function resolveCopilotContextWindow(
  modelId: string,
  models: readonly CopilotDiscoveredModel[],
  customContextLimits: Record<string, number> = {},
): number {
  const model = findCopilotModel(models, modelId);
  if (model?.contextWindow !== undefined) {
    return model.contextWindow;
  }

  const rawModelId = decodeCopilotModelId(modelId);
  const customLimit = customContextLimits[modelId]
    ?? (rawModelId ? customContextLimits[rawModelId] : undefined);
  return isPositiveFiniteNumber(customLimit)
    ? customLimit
    : COPILOT_CONTEXT_WINDOW_FALLBACK;
}

export function formatCopilotReasoningLabel(effort: CopilotReasoningEffort): string {
  return formatReasoningValueLabel(effort);
}

function normalizeCopilotDiscoveredModel(value: unknown): CopilotDiscoveredModel | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawId = readTrimmedString(value.rawId ?? value.id);
  if (!rawId) {
    return null;
  }

  const reasoningEfforts = normalizeReasoningEfforts(
    value.reasoningEfforts ?? value.supportedReasoningEfforts,
  );
  const declaredDefault = readTrimmedString(
    value.defaultReasoningEffort ?? value.reasoningEffort,
  );
  const defaultReasoningEffort = isCopilotReasoningEffort(declaredDefault)
    && reasoningEfforts.includes(declaredDefault)
    ? declaredDefault
    : undefined;
  const contextWindow = readPositiveFiniteNumber(
    value.contextWindow ?? value.maxContextWindowTokens,
  );
  const description = readTrimmedString(value.description);
  const displayName = readTrimmedString(value.displayName ?? value.name ?? value.label)
    || rawId;

  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(description ? { description } : {}),
    displayName,
    rawId,
    reasoningEfforts,
    supportsReasoning: reasoningEfforts.length > 0,
    supportsVision: value.supportsVision === true,
  };
}

function normalizeReasoningEfforts(value: unknown): CopilotReasoningEffort[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const efforts = new Set<CopilotReasoningEffort>();
  for (const entry of value) {
    const effort = typeof entry === 'string' ? entry.trim() : '';
    if (isCopilotReasoningEffort(effort)) {
      efforts.add(effort);
    }
  }
  return [...efforts].sort((left, right) => (
    (REASONING_EFFORT_ORDER.get(left) ?? 0) - (REASONING_EFFORT_ORDER.get(right) ?? 0)
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readPositiveFiniteNumber(value: unknown): number | undefined {
  return isPositiveFiniteNumber(value) ? Math.floor(value) : undefined;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
