import { getHostnameKey } from '../../../utils/env';
import { getCopilotProviderSettings } from '../settings';
import {
  type CopilotResourcesByHost,
  type CopilotResourceSettings,
  normalizeCopilotResourceSettings,
} from './CopilotResourceSettings';

/**
 * This computer's explicit selections and repository-skill opt-outs for this vault.
 *
 * A selection names files and directories that exist on one machine, so it is stored per
 * host and never becomes another computer's explicit selection by syncing the vault.
 * Repository defaults are resolved from the vault's filesystem, not persisted here.
 */
export function getCopilotHostResources(
  settings: Record<string, unknown>,
): CopilotResourceSettings {
  const resources = getCopilotProviderSettings(settings).resourcesByHost[getHostnameKey()];
  return normalizeCopilotResourceSettings(resources);
}

/** The full by-host map with this host's selection updated and every other one kept. */
export function updateCopilotHostResources(
  settings: Record<string, unknown>,
  updates: Partial<CopilotResourceSettings>,
): CopilotResourcesByHost {
  const current = getCopilotProviderSettings(settings).resourcesByHost;
  return {
    ...current,
    [getHostnameKey()]: normalizeCopilotResourceSettings({
      ...getCopilotHostResources(settings),
      ...updates,
    }),
  };
}
