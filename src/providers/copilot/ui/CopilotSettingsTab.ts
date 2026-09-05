import { Notice, Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderSettingsTabRenderer,
  ProviderSettingsTabRendererContext,
} from '../../../core/providers/types';
import type { ClaudianSettings } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import { renderHostnameCliPathSetting } from '../../../shared/settings/HostnameCliPathSetting';
import { renderProviderEnablementSetting } from '../../../shared/settings/ProviderEnablementSetting';
import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '../../../shared/settings/ProviderModelEnablementWarning';
import {
  type ProviderModelPickerModel,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import { getHostnameKey } from '../../../utils/env';
import { getCopilotWorkspaceServices } from '../app/CopilotWorkspaceServices';
import type { CopilotDiscoveredModel } from '../models';
import { COPILOT_CONFIGURABLE_ENVIRONMENT_KEYS } from '../runtime/CopilotRuntimeEnvironment';
import {
  getCopilotProviderSettings,
  normalizeCopilotVisibleModels,
  updateCopilotProviderSettings,
} from '../settings';

const COPILOT_PROVIDER_ID = 'copilot' as const;

export const copilotSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const hostnameKey = getHostnameKey();
    const workspace = getCopilotWorkspaceServices();

    const refreshModelCatalog = async (): Promise<'empty' | 'failed' | 'loaded'> => {
      const result = await workspace.refreshModelCatalog();
      if (result.diagnostics) {
        new Notice(`Copilot model discovery failed: ${result.diagnostics}`);
        return 'failed';
      }
      modelWarning.context.notifyProviderModelOptionsChanged(COPILOT_PROVIDER_ID);
      return getCopilotProviderSettings(settingsBag).discoveredModels.length > 0
        ? 'loaded'
        : 'empty';
    };

    new Setting(container).setName('Setup').setHeading();

    renderProviderEnablementSetting({
      container,
      description: t('settings.providerEnablement.desc', { provider: 'Copilot' }),
      getValue: () => getCopilotProviderSettings(settingsBag).enabled,
      name: t('settings.providerEnablement.name', { provider: 'Copilot' }),
      onChange: async (enabled) => {
        if (!ProviderSettingsCoordinator.canApplyProviderEnablement(
          settingsBag,
          COPILOT_PROVIDER_ID,
          enabled,
        )) {
          lastProviderWarning.showFor();
          return;
        }

        let accepted = true;
        await context.plugin.runProviderExecutionTransition(
          [COPILOT_PROVIDER_ID],
          async () => context.plugin.mutateSettings((settings) => {
            accepted = ProviderSettingsCoordinator.applyProviderEnablement(
              settings,
              COPILOT_PROVIDER_ID,
              enabled,
            );
          }),
        );
        if (accepted) {
          lastProviderWarning.hide();
        } else {
          lastProviderWarning.showFor();
        }
        modelWarning.context.notifyProviderModelOptionsChanged(COPILOT_PROVIDER_ID);
      },
    });

    const lastProviderWarning = renderLastEnabledProviderWarning(container);

    const modelWarning = renderProviderModelEnablementWarning(container, context, {
      getHasEnabledModels: () => (
        getCopilotProviderSettings(settingsBag).visibleModels.length > 0
      ),
      getIsEnabled: () => getCopilotProviderSettings(settingsBag).enabled,
      providerId: COPILOT_PROVIDER_ID,
      providerName: 'Copilot',
    });

    renderHostnameCliPathSetting({
      container,
      description: 'Optional absolute path to the Copilot CLI for this computer. Leave empty to look for `copilot` on this computer\'s own PATH; a PATH entry set under Environment below is never used to find or run the CLI. Claudian never bundles or downloads the CLI.',
      getValue: () => {
        const current = getCopilotProviderSettings(settingsBag);
        return current.cliPathsByHost[hostnameKey] ?? current.cliPath;
      },
      name: 'CLI path',
      onChange: async (value) => {
        const cliPathsByHost = {
          ...getCopilotProviderSettings(settingsBag).cliPathsByHost,
        };
        if (value) {
          cliPathsByHost[hostnameKey] = value;
        } else {
          delete cliPathsByHost[hostnameKey];
        }
        const mutation = (settings: ClaudianSettings): void => {
          updateCopilotProviderSettings(settings, {
            cliPath: '',
            cliPathsByHost,
            discoveredModels: [],
          });
        };
        await context.plugin.applyProviderRuntimeSettings(
          [COPILOT_PROVIDER_ID],
          mutation,
          () => workspace.cliResolver.reset(),
        );
        modelWarning.context.notifyProviderModelOptionsChanged(COPILOT_PROVIDER_ID);
      },
      placeholder: process.platform === 'win32'
        ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\copilot.exe'
        : '/usr/local/bin/copilot',
    });

    new Setting(container).setName('Models').setHeading();
    renderCopilotModelPicker(
      container,
      modelWarning.context,
      settingsBag,
      refreshModelCatalog,
    );

    renderEnvironmentSettingsSection({
      container,
      desc: 'Environment variables passed only to Copilot. Claudian forwards a minimal '
        + 'host environment plus these entries, and accepts only '
        + `${[...COPILOT_CONFIGURABLE_ENVIRONMENT_KEYS].sort().join(', ')} — every other `
        + 'entry is ignored, including PATH, the proxy and certificate settings, and the '
        + 'CLI switches that would let it act without asking. Where the CLI connects and '
        + "which certificates it trusts come from this computer's own environment, "
        + 'because a vault syncs and can be shared. PATH and COPILOT_HOME are managed by '
        + "Claudian: PATH comes from this computer's own environment and the resolved "
        + 'CLI, and COPILOT_HOME points outside the vault. Sign in by running the Copilot '
        + 'CLI once with COPILOT_HOME set to that directory; these entries are stored in '
        + 'plain text in .claudian/claudian-settings.json, so never put a token or an API '
        + 'key here.',
      heading: 'Environment',
      name: 'Copilot environment variables',
      placeholder: 'LANG=en_US.UTF-8',
      plugin: context.plugin,
      renderCustomContextLimits: target => (
        context.renderCustomContextLimits(target, COPILOT_PROVIDER_ID)
      ),
      scope: 'provider:copilot',
    });
  },
};

function renderCopilotModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  settingsBag: Record<string, unknown>,
  loadCatalog: () => Promise<'empty' | 'failed' | 'loaded'>,
): void {
  const getState = (): ProviderModelPickerState => {
    const settings = getCopilotProviderSettings(settingsBag);
    return {
      aliases: settings.modelAliases,
      discoveredCount: settings.discoveredModels.length,
      models: buildCopilotPickerModels(settings.discoveredModels),
      selectedIds: settings.visibleModels,
    };
  };

  renderProviderModelPicker({
    container,
    emptyCatalogText: 'No Copilot models discovered yet. Sign in to this vault\'s own Copilot home once, by running the Copilot CLI with COPILOT_HOME set to the directory named in the sign-in error, then click Discover.',
    failedCatalogText: 'Could not load the Copilot model catalog. Check the CLI path and that the CLI is signed in with an active Copilot subscription, then try again.',
    getState,
    initiallyOpen: getCopilotProviderSettings(settingsBag).discoveredModels.length === 0,
    loadCatalog: async () => loadCatalog(),
    loadingCatalogText: 'Loading the Copilot model catalog...',
    modifier: 'copilot',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updateCopilotProviderSettings(settings, { modelAliases });
      });
      context.notifyProviderModelOptionsChanged(COPILOT_PROVIDER_ID);
    },
    async onSelectedIdsChange(selectedIds) {
      const current = getCopilotProviderSettings(settingsBag);
      const visibleModels = normalizeCopilotVisibleModels(
        selectedIds,
        new Set(current.discoveredModels.map(model => model.rawId)),
      );
      if (sameList(current.visibleModels, visibleModels)) {
        return;
      }
      await context.plugin.mutateSettings((settings) => {
        updateCopilotProviderSettings(settings, { visibleModels });
      });
      context.notifyProviderModelOptionsChanged(COPILOT_PROVIDER_ID);
    },
    providerName: 'Copilot',
    searchPlaceholder: 'Filter by model name, description, or alias ID...',
  });
}

export function buildCopilotPickerModels(
  models: readonly CopilotDiscoveredModel[],
): ProviderModelPickerModel[] {
  return models.map(model => ({
    description: describeModel(model),
    id: model.rawId,
    name: model.displayName,
  }));
}

function describeModel(model: CopilotDiscoveredModel): string {
  const details: string[] = [];
  if (model.description) {
    details.push(model.description);
  }
  if (model.contextWindow) {
    details.push(`${Math.round(model.contextWindow / 1000)}K context`);
  }
  if (model.supportsReasoning) {
    details.push(`reasoning: ${model.reasoningEfforts.join(', ')}`);
  }
  if (model.supportsVision) {
    details.push('image input');
  }
  return details.join(' | ');
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
