import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import { copilotWorkspaceRegistration } from './app/CopilotWorkspaceServices';
import { COPILOT_PROVIDER_CAPABILITIES } from './capabilities';
import { copilotSettingsReconciler } from './env/CopilotSettingsReconciler';
import { CopilotExecutionBackend } from './execution/CopilotExecutionBackend';
import { CopilotConversationHistoryService } from './history/CopilotConversationHistoryService';
import { getCopilotProviderSettings, updateCopilotProviderSettings } from './settings';
import { copilotChatUIConfig } from './ui/CopilotChatUIConfig';

/**
 * The Copilot-namespaced keys that are not credentials.
 *
 * A claimed key is offered as a Copilot setting and persisted in plain text inside the
 * vault, so a token key must never be claimed: `COPILOT_GITHUB_TOKEN`,
 * `COPILOT_PROVIDER_API_KEY`, and every later spelling of a credential would otherwise be
 * filed under Copilot as somewhere to keep one. Sign-in belongs to the CLI and its OS
 * keychain entry.
 *
 * The `GITHUB_` namespace is left unclaimed entirely, because `GITHUB_COPILOT_*` carries
 * both trust switches and GitHub tokens, and matching by shape is what keeps a key a
 * later CLI release adds from having to be discovered before it stops being claimed.
 */
const COPILOT_CREDENTIAL_KEY_SHAPES = 'TOKEN|API_?KEY|SECRET|PASSWORD|CREDENTIAL|AUTH';

export const copilotProviderRegistration: ProviderModule = {
  id: 'copilot',
  blankTabOrder: 18,
  capabilities: COPILOT_PROVIDER_CAPABILITIES,
  chatUIConfig: copilotChatUIConfig,
  createExecutionBackend: plugin => new CopilotExecutionBackend(plugin),
  /**
   * The model a title turn runs with.
   *
   * A Copilot turn names its model explicitly, so an empty selection — the Auto setting —
   * has to resolve to one or auto-titling can never run. It resolves to the model the
   * chat selector would default to: the first one the user enabled. A selection the user
   * has since hidden, or one another provider owns, is not a model a turn may run with
   * either, so it resolves the same way. With nothing enabled there is no provider
   * default to reach for, and the turn is left without a model rather than given one the
   * user never turned on.
   */
  resolveTitleGenerationModel: (plugin) => {
    const selection = typeof plugin.settings.titleGenerationModel === 'string'
      ? plugin.settings.titleGenerationModel.trim()
      : '';
    if (selection && copilotChatUIConfig.ownsModel(selection, plugin.settings)) {
      return selection;
    }
    return copilotChatUIConfig.getDefaultModel?.(plugin.settings) ?? undefined;
  },
  displayName: 'Copilot',
  environmentKeyPatterns: [
    new RegExp(`^COPILOT_(?!.*(?:${COPILOT_CREDENTIAL_KEY_SHAPES}))`, 'i'),
  ],
  historyService: new CopilotConversationHistoryService(),
  isEnabled: settings => getCopilotProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateCopilotProviderSettings(settings, { enabled }),
  settingsReconciler: copilotSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'copilot');
      updateCopilotProviderSettings(target, getCopilotProviderSettings(stored));
      return hasStoredConfigNormalization(
        storedConfig,
        getProviderConfig(target, 'copilot'),
      );
    },
  },
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: copilotWorkspaceRegistration,
};
