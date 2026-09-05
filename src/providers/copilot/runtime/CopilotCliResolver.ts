import type { ProviderCliResolutionContext } from '../../../core/providers/cli/CachedProviderCliResolver';
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
 * A configured path is an answer, not a preference. Where one is set — for this host, or
 * in the legacy field a host that has never been configured falls back to — it is the
 * only path considered, and it either resolves to an executable the SDK can be handed or
 * resolves to nothing. Only an unconfigured path lets discovery search the host.
 *
 * That discovery searches the host's own resolution alone. A PATH typed into the vault is
 * deliberately not searched: it would choose which `copilot` a signed-in turn runs, and
 * the directory the CLI resolves from is prepended to the environment that CLI receives.
 * An install the host cannot resolve names its path explicitly instead.
 *
 * The path that comes out is narrowed to something the SDK can spawn: it has to be
 * absolute, because the SDK spawns the CLI with the vault as the working directory and a
 * relative path would name vault content instead of an install. On Windows npm installs
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
    resolve: context => resolveCopilotCliEntry(discoverCopilotCliPath(context)),
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

/**
 * The one path this resolution may consider, before it is narrowed to an entry.
 *
 * A configured path that names nothing is a setting to fix, and the two states a path
 * field can be in are told apart here rather than collapsed into one absent answer:
 * unset, which leaves the choice to the host, and set to something that does not resolve,
 * which is an install that was moved, renamed, or removed. Falling through the second
 * would silently run whichever `copilot` the host happens to have, under a path the user
 * never named and cannot see in settings, with the environment Claudian builds around it.
 *
 * The current host's own path answers first because it is the one this machine was
 * configured with; the legacy field is what a vault carried before paths were kept per
 * host, so it only answers for a host that names none.
 */
function discoverCopilotCliPath(context: ProviderCliResolutionContext): string | null {
  const configuredPath = context.hostnamePath || context.legacyCliPath;
  return configuredPath
    ? resolveConfiguredCliPath(configuredPath)
    : findCliBinaryPath(COPILOT_BINARY_NAME);
}
