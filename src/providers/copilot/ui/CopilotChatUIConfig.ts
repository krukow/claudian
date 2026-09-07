import type {
  ProviderChatUIConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import {
  decodeCopilotModelId,
  encodeCopilotModelId,
  findCopilotModel,
  formatCopilotReasoningLabel,
  getCopilotReasoningOptions,
  isCopilotModelSelectionId,
  resolveCopilotContextWindow,
  resolveCopilotDefaultReasoningEffort,
} from '../models';
import {
  getCopilotProviderSettings,
  getEnabledCopilotModels,
  updateCopilotProviderSettings,
} from '../settings';

export const copilotChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const copilotSettings = getCopilotProviderSettings(settings);
    const aliases = copilotSettings.modelAliases;
    return getEnabledCopilotModels(copilotSettings).map(model => ({
      ...(model.description ? { description: model.description } : {}),
      label: aliases[model.rawId] ?? model.displayName,
      value: encodeCopilotModelId(model.rawId),
    }));
  },

  /** Only an explicitly enabled model can be a default; there is no provider fallback. */
  getDefaultModel(settings): string | null {
    const [first] = getEnabledCopilotModels(getCopilotProviderSettings(settings));
    return first ? encodeCopilotModelId(first.rawId) : null;
  },

  ownsModel(model, settings): boolean {
    return isCopilotModelSelectionId(model)
      && this.getModelOptions(settings).some(option => option.value === model.trim());
  },

  isAdaptiveReasoningModel(model, settings): boolean {
    return getCopilotReasoningOptions(getEnabledModel(model, settings)).length > 0;
  },

  getReasoningOptions(model, settings): ProviderReasoningOption[] {
    return getCopilotReasoningOptions(getEnabledModel(model, settings)).map(effort => ({
      label: formatCopilotReasoningLabel(effort),
      value: effort,
    }));
  },

  getDefaultReasoningValue(model, settings): string {
    const rawId = decodeCopilotModelId(model);
    if (!rawId) {
      return '';
    }
    return resolveCopilotDefaultReasoningEffort(
      getEnabledModel(model, settings),
      getCopilotProviderSettings(settings).preferredReasoningByModel[rawId],
    ) ?? '';
  },

  getContextWindowSize(model, customLimits = {}, settings = {}): number {
    return resolveCopilotContextWindow(
      model,
      getCopilotProviderSettings(settings).discoveredModels,
      customLimits,
    );
  },

  isDefaultModel(): boolean {
    return false;
  },

  applyModelDefaults(model, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const normalized = normalizeSelection(model);
    if (!isCopilotModelSelectionId(normalized)) {
      return;
    }
    clearSavedEffortProjection(settings);
    settings.model = normalized;
    settings.effortLevel = this.getDefaultReasoningValue(normalized, settings);
  },

  applyModelProjectionDefaults(model, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    clearSavedEffortProjection(settings);
    if (!decodeCopilotModelId(model)) {
      delete settings.effortLevel;
      return;
    }
    settings.effortLevel = this.getDefaultReasoningValue(model, settings);
  },

  applyReasoningSelection(model, value, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const rawId = decodeCopilotModelId(model);
    if (!rawId) {
      clearSavedEffortProjection(settings);
      delete settings.effortLevel;
      return;
    }

    const supported = new Set<string>(getCopilotReasoningOptions(
      getEnabledModel(model, settings),
    ));
    const preferredReasoningByModel = {
      ...getCopilotProviderSettings(settings).preferredReasoningByModel,
    };
    if (supported.has(value)) {
      Object.assign(preferredReasoningByModel, { [rawId]: value });
    } else {
      delete preferredReasoningByModel[rawId];
    }
    updateCopilotProviderSettings(settings, { preferredReasoningByModel });
  },

  normalizeModelVariant(model): string {
    return normalizeSelection(model);
  },

  getCustomModelIds(): Set<string> {
    return new Set();
  },

  /** Copilot approvals are always interactive; there is no permission-mode toggle. */
  getPermissionModeToggle(): null {
    return null;
  },

  getModeSelector(): null {
    return null;
  },
};

/**
 * The enabled model behind a selection. A model that is not enabled contributes no
 * reasoning options, so a stale selection cannot resurrect a disabled model's controls.
 */
function getEnabledModel(model: string, settings: Record<string, unknown>) {
  const rawId = decodeCopilotModelId(model);
  if (!rawId) {
    return null;
  }
  return findCopilotModel(
    getEnabledCopilotModels(getCopilotProviderSettings(settings)),
    rawId,
  );
}

function normalizeSelection(model: string): string {
  const rawId = decodeCopilotModelId(model.trim());
  return rawId ? encodeCopilotModelId(rawId) : model;
}

function clearSavedEffortProjection(settings: Record<string, unknown>): void {
  if (isRecord(settings.savedProviderEffort)) {
    delete settings.savedProviderEffort.copilot;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
