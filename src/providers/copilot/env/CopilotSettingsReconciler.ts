import { createCliPathFingerprintInputs } from '../../../core/providers/cli/CliPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { createRuntimeInputFingerprint } from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { decodeCopilotModelId, encodeCopilotModelId } from '../models';
import { getCopilotProviderSettings, updateCopilotProviderSettings } from '../settings';

/**
 * Inputs that change which Copilot account, CLI, or data directory a session binds to.
 * A change to any of them invalidates the discovered catalog and every live session.
 */
export function computeCopilotEnvironmentHash(settings: Record<string, unknown>): string {
  const providerSettings = getCopilotProviderSettings(settings);
  const environmentText = getRuntimeEnvironmentText(settings, 'copilot');
  const cliPathInputs = createCliPathFingerprintInputs(
    providerSettings.cliPathsByHost[getHostnameKey()],
    providerSettings.cliPath,
  );
  const environmentKeys = Object.keys(parseEnvironmentVariables(environmentText)).sort(
    (left, right) => left.localeCompare(right),
  );
  return createRuntimeInputFingerprint({
    additionalInputs: cliPathInputs,
    environmentKeys,
    environmentText,
  });
}

export const copilotSettingsReconciler: ProviderSettingsReconciler = {
  environmentSessionPolicy: 'invalidate',

  invalidateConversationSessions(conversations) {
    return conversations.filter(conversation => invalidateConversation(conversation));
  },

  reconcileModelWithEnvironment(settings, conversations) {
    if (!getCopilotProviderSettings(settings).enabled) {
      return { changed: false, invalidatedConversations: [] };
    }

    const environmentHash = computeCopilotEnvironmentHash(settings);
    if (getCopilotProviderSettings(settings).environmentHash === environmentHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    updateCopilotProviderSettings(settings, {
      discoveredModels: [],
      environmentHash,
    });
    return {
      changed: true,
      invalidatedConversations: conversations.filter(conversation => (
        invalidateConversation(conversation)
      )),
    };
  },

  normalizeModelVariantSettings(settings): boolean {
    let changed = normalizeSelectionAt(settings, 'model');
    changed = normalizeSelectionAt(settings, 'titleGenerationModel') || changed;

    const savedProviderModel = settings.savedProviderModel;
    if (isRecord(savedProviderModel)) {
      changed = normalizeSelectionAt(savedProviderModel, 'copilot') || changed;
    }
    return changed;
  },
};

function invalidateConversation(conversation: Conversation): boolean {
  if (conversation.providerId !== 'copilot' || !conversation.sessionId) {
    return false;
  }
  conversation.sessionId = null;
  return true;
}

function normalizeSelectionAt(settings: Record<string, unknown>, key: string): boolean {
  const current = settings[key];
  if (typeof current !== 'string') {
    return false;
  }

  const rawModelId = decodeCopilotModelId(current.trim());
  if (!rawModelId) {
    return false;
  }

  const normalized = encodeCopilotModelId(rawModelId);
  if (normalized === current) {
    return false;
  }
  settings[key] = normalized;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
