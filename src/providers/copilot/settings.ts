import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import type { HostnameCliPaths } from '../../core/types/settings';
import { getHostnameKey } from '../../utils/env';
import {
  type CopilotDiscoveredModel,
  type CopilotReasoningEffort,
  decodeCopilotModelId,
  getCopilotReasoningOptions,
  isCopilotReasoningEffort,
  normalizeCopilotDiscoveredModels,
} from './models';

export interface CopilotProviderSettings {
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  discoveredModels: CopilotDiscoveredModel[];
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  preferredReasoningByModel: Record<string, CopilotReasoningEffort>;
  visibleModels: string[];
}

export const DEFAULT_COPILOT_PROVIDER_SETTINGS: Readonly<CopilotProviderSettings> =
  Object.freeze({
    cliPath: '',
    cliPathsByHost: {},
    discoveredModels: [],
    enabled: false,
    environmentHash: '',
    environmentVariables: '',
    modelAliases: {},
    preferredReasoningByModel: {},
    visibleModels: [],
  });

export function getCopilotProviderSettings(
  settings: Record<string, unknown>,
): CopilotProviderSettings {
  const config = getProviderConfig(settings, 'copilot');
  const discoveredModels = normalizeCopilotDiscoveredModels(config.discoveredModels);
  const knownModelIds = collectKnownRawModelIds(settings, discoveredModels);
  const retainSelection = discoveredModels.length === 0;
  const visibleModels = normalizeCopilotVisibleModels(
    config.visibleModels,
    knownModelIds,
    retainSelection,
  );

  return {
    cliPath: readTrimmedString(config.cliPath),
    cliPathsByHost: normalizeHostnameStringMap(config.cliPathsByHost),
    discoveredModels,
    enabled: config.enabled === true,
    environmentHash: readTrimmedString(config.environmentHash),
    environmentVariables: typeof config.environmentVariables === 'string'
      ? config.environmentVariables
      : getProviderEnvironmentVariables(settings, 'copilot')
        ?? DEFAULT_COPILOT_PROVIDER_SETTINGS.environmentVariables,
    modelAliases: normalizeCopilotModelAliases(
      config.modelAliases,
      knownModelIds,
      retainSelection,
    ),
    preferredReasoningByModel: normalizeCopilotPreferredReasoning(
      config.preferredReasoningByModel,
      discoveredModels,
    ),
    visibleModels,
  };
}

export function updateCopilotProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<CopilotProviderSettings>,
): CopilotProviderSettings {
  const current = getCopilotProviderSettings(settings);
  const cliPathsByHost = updates.cliPathsByHost !== undefined
    ? normalizeHostnameStringMap(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let cliPath = updates.cliPathsByHost !== undefined
    ? readTrimmedString(updates.cliPath)
    : current.cliPath;

  if ('cliPath' in updates && updates.cliPathsByHost === undefined) {
    const hostCliPath = readTrimmedString(updates.cliPath);
    if (hostCliPath) {
      cliPathsByHost[getHostnameKey()] = hostCliPath;
    } else {
      delete cliPathsByHost[getHostnameKey()];
    }
    cliPath = DEFAULT_COPILOT_PROVIDER_SETTINGS.cliPath;
  }

  const discoveredModels = updates.discoveredModels !== undefined
    ? normalizeCopilotDiscoveredModels(updates.discoveredModels)
    : current.discoveredModels;
  const knownModelIds = collectKnownRawModelIds(settings, discoveredModels);
  const retainSelection = discoveredModels.length === 0;

  const next: CopilotProviderSettings = {
    cliPath,
    cliPathsByHost,
    discoveredModels,
    enabled: updates.enabled ?? current.enabled,
    environmentHash: updates.environmentHash !== undefined
      ? readTrimmedString(updates.environmentHash)
      : current.environmentHash,
    environmentVariables: updates.environmentVariables ?? current.environmentVariables,
    modelAliases: normalizeCopilotModelAliases(
      updates.modelAliases ?? current.modelAliases,
      knownModelIds,
      retainSelection,
    ),
    preferredReasoningByModel: normalizeCopilotPreferredReasoning(
      updates.preferredReasoningByModel ?? current.preferredReasoningByModel,
      discoveredModels,
    ),
    visibleModels: normalizeCopilotVisibleModels(
      updates.visibleModels ?? current.visibleModels,
      knownModelIds,
      retainSelection,
    ),
  };

  setProviderConfig(settings, 'copilot', next as unknown as Record<string, unknown>);
  return next;
}

/**
 * Enabled models in the order the user arranged them. Only explicitly enabled models are
 * selectable: an empty list means Copilot contributes no chat models at all.
 */
export function getEnabledCopilotModels(
  providerSettings: CopilotProviderSettings,
): CopilotDiscoveredModel[] {
  const discoveredById = new Map(
    providerSettings.discoveredModels.map(model => [model.rawId, model] as const),
  );
  return providerSettings.visibleModels
    .map(rawId => discoveredById.get(rawId))
    .filter((model): model is CopilotDiscoveredModel => model !== undefined);
}

/**
 * `retainUnknown` keeps a selection whose model the catalog does not list. An empty
 * catalog means Claudian invalidated it and has not rediscovered yet, so dropping the
 * selection there would silently discard the user's enabled models, their order, their
 * aliases, and their reasoning preferences. A populated catalog is authoritative again.
 */
export function normalizeCopilotVisibleModels(
  value: unknown,
  knownModelIds: ReadonlySet<string>,
  retainUnknown = false,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const rawModelId = normalizeRawModelId(entry);
    if (!rawModelId || seen.has(rawModelId)) {
      continue;
    }
    if (!retainUnknown && !knownModelIds.has(rawModelId)) {
      continue;
    }
    seen.add(rawModelId);
    normalized.push(rawModelId);
  }
  return normalized;
}

export function normalizeCopilotModelAliases(
  value: unknown,
  knownModelIds: ReadonlySet<string>,
  retainUnknown = false,
): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [modelId, aliasValue] of Object.entries(value)) {
    const rawModelId = normalizeRawModelId(modelId);
    const alias = readTrimmedString(aliasValue);
    if (rawModelId && alias && (retainUnknown || knownModelIds.has(rawModelId))) {
      normalized[rawModelId] = alias;
    }
  }
  return normalized;
}

export function normalizeCopilotPreferredReasoning(
  value: unknown,
  discoveredModels: readonly CopilotDiscoveredModel[],
): Record<string, CopilotReasoningEffort> {
  if (!isRecord(value)) {
    return {};
  }

  const retainUnknown = discoveredModels.length === 0;
  const modelsById = new Map(discoveredModels.map(model => [model.rawId, model] as const));
  const normalized: Record<string, CopilotReasoningEffort> = {};
  for (const [modelId, effortValue] of Object.entries(value)) {
    const rawModelId = normalizeRawModelId(modelId);
    const effort = readTrimmedString(effortValue);
    if (!rawModelId || !isCopilotReasoningEffort(effort)) {
      continue;
    }
    if (retainUnknown) {
      normalized[rawModelId] = effort;
      continue;
    }
    const supported = getCopilotReasoningOptions(modelsById.get(rawModelId));
    if (supported.includes(effort)) {
      normalized[rawModelId] = effort;
    }
  }
  return normalized;
}

/**
 * Discovered models plus any model an existing selection still points at, so switching
 * hosts or clearing the catalog never silently drops a conversation's stored model.
 */
function collectKnownRawModelIds(
  settings: Record<string, unknown>,
  discoveredModels: readonly CopilotDiscoveredModel[],
): Set<string> {
  const known = new Set(discoveredModels.map(model => model.rawId));
  addSelectedRawModelId(known, settings.model);
  addSelectedRawModelId(known, settings.titleGenerationModel);
  if (isRecord(settings.savedProviderModel)) {
    addSelectedRawModelId(known, settings.savedProviderModel.copilot);
  }
  return known;
}

function addSelectedRawModelId(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string') {
    return;
  }
  const rawModelId = decodeCopilotModelId(value.trim());
  if (rawModelId) {
    target.add(rawModelId);
  }
}

function normalizeRawModelId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return decodeCopilotModelId(normalized) ?? normalized;
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
