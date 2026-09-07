import { createHash } from 'node:crypto';

import type { ProviderCommandDiscoveryResult } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { loadRuntimeCommands } from '@/core/providers/commands/RuntimeCommandLoader';
import type {
  ProviderCommandLoader as ProviderCommandLoaderContract,
  ProviderCommandLoaderContext,
} from '@/core/providers/types';
import type { SlashCommand } from '@/core/types';

import { getCopilotHostResources } from '../resources/CopilotHostResources';
import { getCopilotProviderSettings } from '../settings';
import type { CopilotCommandMetadataProbe } from './CopilotCommandMetadataProbe';

/**
 * What decides whether a cached command listing still describes this computer.
 *
 * The selected skills are named by a digest rather than by their paths: a fingerprint is
 * a cache identity that outlives the listing it belongs to, and a skill path names a
 * place on the user's disk. An explicit refresh moves the revision, so a skill edited in
 * place can be re-read without changing the selection.
 */
export class CopilotCommandLoader implements ProviderCommandLoaderContract {
  private refreshRevision = 0;

  constructor(private readonly metadataProbe: CopilotCommandMetadataProbe) {}

  getCacheFingerprint(settings: Record<string, unknown>): string {
    const providerSettings = getCopilotProviderSettings(settings);
    const selectedSkills = [...getCopilotHostResources(settings).selectedSkillPaths].sort();
    return [
      'copilot:commands:v1',
      providerSettings.enabled ? 'enabled' : 'disabled',
      createHash('sha256').update(JSON.stringify(selectedSkills)).digest('hex'),
      String(this.refreshRevision),
    ].join(':');
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return getCopilotProviderSettings(settings).enabled
      && getCopilotHostResources(settings).selectedSkillPaths.length > 0;
  }

  /** Invalidates the cached listing without changing what is selected. */
  requestRefresh(): void {
    this.refreshRevision += 1;
  }

  async loadCommands(
    context: ProviderCommandLoaderContext,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    return loadRuntimeCommands({
      allowIsolatedMetadataCreation: context.allowIsolatedMetadataCreation,
      discover: signal => this.metadataProbe.load(signal),
      errorMessage: 'Could not load the selected Copilot skills.',
      projectItems: commands => commands,
      readyCommandSnapshot: context.readyCommandSnapshot,
      requiresSessionMessage: 'Copilot skill metadata has not been loaded for this tab.',
      signal: context.signal,
    });
  }
}
