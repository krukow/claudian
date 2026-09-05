import { CachedProviderCliResolver } from '../../../core/providers/cli/CachedProviderCliResolver';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { findCliBinaryPath, resolveConfiguredCliPath } from '../../../utils/cliBinaryLocator';
import { getCopilotProviderSettings } from '../settings';
import { resolveCopilotCliEntry } from './CopilotCliEntry';

const COPILOT_BINARY_NAME = 'copilot';

/**
 * Resolves the user-installed `copilot` executable. Claudian never resolves, bundles, or
 * distributes the CLI that ships inside the SDK, so an unresolvable binary is a
 * configuration failure rather than a fallback to a vendored runtime.
 *
 * Discovery searches the configured CLI path and then the host's own resolution. A PATH
 * typed into the vault is deliberately not searched: it would choose which `copilot` a
 * signed-in turn runs, and the directory the CLI resolves from is prepended to the
 * environment that CLI receives. An install the host cannot resolve names its path
 * explicitly instead.
 *
 * The discovered path is narrowed to something the SDK can spawn: on Windows npm installs
 * the CLI as a `copilot.cmd` launcher that `spawn` refuses to start, so the package's
 * JavaScript entry is resolved from it, and a launcher that names nothing resolvable
 * fails closed instead of resolving to a path that only breaks at spawn time.
 */
export class CopilotCliResolver {
  private readonly resolver = new CachedProviderCliResolver({
    binaryName: COPILOT_BINARY_NAME,
    getSettingsProjection: (settings) => {
      const providerSettings = getCopilotProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'copilot'),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: 'copilot',
    resolve: context => resolveCopilotCliEntry(
      resolveConfiguredCliPath(context.hostnamePath)
      ?? resolveConfiguredCliPath(context.legacyCliPath)
      ?? findCliBinaryPath(COPILOT_BINARY_NAME),
    ),
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  resolve(
    hostnamePaths: Record<string, string> | undefined,
    legacyPath: string,
    environmentText: string,
  ): string | null {
    return this.resolver.resolve({
      cliPathsByHost: hostnamePaths,
      environmentText,
      legacyCliPath: legacyPath,
    });
  }
  reset(): void {
    this.resolver.reset();
  }
}
