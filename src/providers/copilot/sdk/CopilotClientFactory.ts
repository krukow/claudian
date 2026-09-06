import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import {
  buildCopilotRuntimeEnvironment,
  resolveCopilotHomeDirectory,
  resolveCopilotTrustedPath,
} from '../runtime/CopilotRuntimeEnvironment';
import {
  acquireNativeWithin,
  copilotNativeSilenceError,
  NATIVE_STARTUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_SECONDS,
} from './CopilotNativeBudget';
import { copilotConfigurationError, toCopilotRuntimeError } from './CopilotRuntimeError';
import type {
  CopilotSdkAuthStatus,
  CopilotSdkClient,
  CopilotSdkRuntime,
} from './CopilotSdkPort';
import { assertAuthenticated, copilotSdkRuntime } from './CopilotSdkRuntime';

/**
 * Everything that decides which CLI process a client binds to. Two clients created from
 * an equal identity are interchangeable; any difference requires a fresh client.
 */
export interface CopilotClientIdentity {
  readonly baseDirectory: string;
  readonly cliPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
}

export interface CopilotClientFactoryOptions {
  readonly runtime?: CopilotSdkRuntime;
}

export class CopilotClientFactory {
  private readonly runtime: CopilotSdkRuntime;

  constructor(
    private readonly host: ProviderHost,
    options: CopilotClientFactoryOptions = {},
  ) {
    this.runtime = options.runtime ?? copilotSdkRuntime;
  }

  /**
   * Resolves the identity a client would be created with, without starting a process.
   * Callers compare it against a live client's identity to decide whether to recycle.
   */
  async resolveIdentity(workingDirectory: string): Promise<CopilotClientIdentity> {
    const cliPath = await this.host.getResolvedProviderCliPath('copilot');
    if (!cliPath) {
      throw copilotConfigurationError(
        'The Copilot CLI could not be launched. Install it and set the CLI path in '
        + 'Copilot settings, or clear that path to let Claudian discover the CLI on this '
        + 'host: a path that is set is the only one tried, so an install that was moved '
        + 'or removed is never replaced by another one behind your back. The path must '
        + 'be absolute: a relative one is resolved against the vault, so it would name a '
        + 'note rather than an install. An npm install is launched through the platform '
        + 'package `@github/copilot-<platform>-<arch>`, so reinstall with '
        + '`npm install -g @github/copilot` if that package is missing. On Windows point '
        + 'the path at `copilot.exe` or at the npm install; a `.cmd` launcher cannot be '
        + 'started directly. A JavaScript entry must be named with a lowercase `.js`, '
        + 'which is the only spelling that starts it through Node.',
      );
    }

    const providerEnvironment = parseEnvironmentVariables(
      getRuntimeEnvironmentText(this.host.settings, 'copilot'),
    );
    const vaultPath = getVaultPath(this.host.app) ?? workingDirectory;
    return {
      baseDirectory: resolveCopilotHomeDirectory(vaultPath),
      cliPath,
      environment: buildCopilotRuntimeEnvironment({
        baseDirectory: resolveCopilotHomeDirectory(vaultPath),
        cliPath,
        providerEnvironment,
        trustedPath: resolveCopilotTrustedPath(cliPath),
      }),
      workingDirectory,
    };
  }

  /** Starts a client and proves it is signed in before any turn can be sent. */
  async createClient(identity: CopilotClientIdentity): Promise<CopilotSdkClient> {
    const client = await this.startClient(identity);
    try {
      assertAuthenticated(await this.readAuthStatus(client), identity.baseDirectory);
    } catch (error) {
      await abandonCopilotClient(client);
      throw error;
    }
    return client;
  }

  /**
   * Starts a client under the startup budget.
   *
   * A CLI that never finishes starting would otherwise hold the turn open, and the
   * cancellation and disposal queued behind it with it. A client that arrives once the
   * budget has elapsed has no caller left to hand it to, so it is abandoned where it
   * arrives rather than left running as a process nothing can stop.
   *
   * This bound has to be the same budget the runtime starts on. A shorter one here would
   * cut the cold start the runtime is still waiting out, and abandon a CLI that was about
   * to answer.
   */
  private async startClient(identity: CopilotClientIdentity): Promise<CopilotSdkClient> {
    const outcome = await acquireNativeWithin(
      this.runtime.createClient(identity),
      abandonCopilotClient,
      NATIVE_STARTUP_TIMEOUT_MS,
    );
    switch (outcome.kind) {
      case 'settled':
        return outcome.value;
      case 'rejected':
        throw toCopilotRuntimeError(outcome.error, 'transport');
      case 'timed-out':
        throw copilotNativeSilenceError(
          'starting the Copilot CLI',
          NATIVE_STARTUP_TIMEOUT_SECONDS,
        );
    }
  }

  /**
   * Reads the sign-in status under the shared release budget. A client that is already up
   * has nothing cold left to do, so silence here is reported as the transport failure it
   * is: a CLI that will not answer the gate cannot be asked to run a turn.
   */
  private async readAuthStatus(client: CopilotSdkClient): Promise<CopilotSdkAuthStatus> {
    const outcome = await acquireNativeWithin(client.getAuthStatus());
    switch (outcome.kind) {
      case 'settled':
        return outcome.value;
      case 'rejected':
        throw toCopilotRuntimeError(outcome.error, 'authentication');
      case 'timed-out':
        throw copilotNativeSilenceError('checking the Copilot sign-in');
    }
  }
}

/**
 * Shuts down a client the factory abandons before any caller was handed it.
 *
 * Nothing can check on it afterwards and no failure it reported would reach anyone, so
 * the graceful stop is always followed by a forced one: an orphaned CLI process outlives
 * the vault, while a forced stop on a runtime that already exited does nothing. Both
 * settle within the shared release budget, and neither may replace the failure the caller
 * is already being given.
 */
async function abandonCopilotClient(client: CopilotSdkClient): Promise<void> {
  await client.stop().catch(() => undefined);
  await client.forceStop().catch(() => undefined);
}

export function isSameCopilotClientIdentity(
  left: CopilotClientIdentity | null,
  right: CopilotClientIdentity,
): boolean {
  return left !== null
    && left.baseDirectory === right.baseDirectory
    && left.cliPath === right.cliPath
    && left.workingDirectory === right.workingDirectory
    && isSameEnvironment(left.environment, right.environment);
}

function isSameEnvironment(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }
  return leftKeys.every(key => left[key] === right[key]);
}
