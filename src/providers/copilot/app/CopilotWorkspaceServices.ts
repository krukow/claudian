import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type {
  ProviderModelCatalogRefreshResult,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { computeCopilotEnvironmentHash } from '../env/CopilotSettingsReconciler';
import { sameCopilotDiscoveredModels } from '../models';
import { CopilotCliResolver } from '../runtime/CopilotCliResolver';
import { CopilotModelDiscoveryService } from '../runtime/CopilotModelDiscoveryService';
import { getCopilotProviderSettings, updateCopilotProviderSettings } from '../settings';

const COPILOT_PROVIDER_ID = 'copilot' as const;

export interface CopilotWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: CopilotCliResolver;
  refreshModelCatalog(): Promise<ProviderModelCatalogRefreshResult>;
}

export interface CopilotWorkspaceServicesOptions {
  readonly modelDiscoveryService?: Pick<CopilotModelDiscoveryService, 'discoverModels'>;
}

export function createCopilotWorkspaceServices(
  plugin: ProviderHost,
  options: CopilotWorkspaceServicesOptions = {},
): CopilotWorkspaceServices {
  const cliResolver = new CopilotCliResolver();
  const modelDiscoveryService = options.modelDiscoveryService
    ?? new CopilotModelDiscoveryService(plugin);

  return {
    cliResolver,

    /**
     * Discovery runs against the CLI, environment, and account the settings named when it
     * started, so the fingerprint of those inputs is captured before it and revalidated
     * inside the transaction that would publish the result. Settings transactions are
     * serialized, so an edit the user made while the CLI was answering can be applied
     * between any check outside the transaction and the write itself; deciding inside it
     * is the only place the answer cannot go stale. A catalog the user's own edits outran
     * describes a runtime that is no longer configured and is dropped, leaving the
     * persisted catalog, its fingerprint, and the queued edit as they are.
     *
     * The fingerprint says what the runtime inputs are, not whether they held still.
     * Settings that changed and changed back while the CLI was answering produce the
     * fingerprint discovery started under, and the probe resolves its own CLI path and
     * environment after that fingerprint is taken, so the catalog can belong to the
     * runtime in between. The provider's execution generation moves once per runtime
     * settings transition and never moves back, so it is captured and revalidated beside
     * the fingerprint: a catalog is published only when the runtime it describes both
     * matches the settings and never moved while it was being discovered.
     */
    async refreshModelCatalog(): Promise<ProviderModelCatalogRefreshResult> {
      const discoveredUnder = computeCopilotEnvironmentHash(plugin.settings);
      const discoveredAtGeneration = plugin.executionLifecycleRegistry
        .getProviderGeneration(COPILOT_PROVIDER_ID);
      const result = await modelDiscoveryService.discoverModels();
      if (result.kind === 'failed') {
        return { changed: false, diagnostics: result.message };
      }

      let published = false;
      await plugin.mutateSettingsConditionally((settings) => {
        const bag = settings as unknown as Record<string, unknown>;
        if (
          computeCopilotEnvironmentHash(bag) !== discoveredUnder
          || plugin.executionLifecycleRegistry.getProviderGeneration(COPILOT_PROVIDER_ID)
            !== discoveredAtGeneration
        ) {
          return false;
        }

        const current = getCopilotProviderSettings(bag);
        if (
          current.environmentHash === discoveredUnder
          && sameCopilotDiscoveredModels(current.discoveredModels, result.models)
        ) {
          return false;
        }

        updateCopilotProviderSettings(bag, {
          discoveredModels: result.models,
          environmentHash: discoveredUnder,
        });
        published = true;
        return true;
      });
      return published ? { changed: true, persistedSettingsChanged: true } : { changed: false };
    },
  };
}
