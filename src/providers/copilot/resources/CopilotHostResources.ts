import { getHostnameKey } from '../../../utils/env';
import { getCopilotProviderSettings } from '../settings';
import {
  type CopilotResourcesByHost,
  type CopilotResourceSettings,
  normalizeCopilotResourceSettings,
} from './CopilotResourceSettings';

/**
 * What this computer selected for this vault.
 *
 * A selection names files and directories that exist on one machine, so it is stored per
 * host and never becomes another computer's selection by syncing the vault. A host that
 * has selected nothing selects nothing: there is no inherited default.
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
