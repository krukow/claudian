import type { CopilotReasoningEffort } from '../models';
import {
  copilotNativeSilenceError,
  NATIVE_OPERATION_TIMEOUT_SECONDS,
  NATIVE_STARTUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_SECONDS,
  settleNativeWithin,
} from './CopilotNativeBudget';
import {
  copilotAuthenticationError,
  copilotMissingSessionError,
  CopilotRuntimeError,
  describeError,
  toCopilotRuntimeError,
  toCopilotSendError,
} from './CopilotRuntimeError';
import type * as copilotSdkModule from './copilotSdkModule';
import type { CopilotSession, SessionConfig } from './copilotSdkModule';
import type {
  CopilotSdkClient,
  CopilotSdkClientOptions,
  CopilotSdkRuntime,
  CopilotSdkSession,
  CopilotSdkSessionConfig,
  CopilotSdkSessionDeletion,
} from './CopilotSdkPort';

type CopilotSdkModule = typeof copilotSdkModule;

let sdkModulePromise: Promise<CopilotSdkModule> | null = null;

/**
 * Deferred so importing the Copilot provider does not pull the SDK's JSON-RPC and
 * process-spawn graph into plugin startup. The first client creation pays for it.
 */
function loadCopilotSdk(): Promise<CopilotSdkModule> {
  sdkModulePromise ??= import('./copilotSdkModule');
  return sdkModulePromise;
}

/**
 * The single place `@github/copilot-sdk` is constructed.
 *
 * Every capability Claudian does not support is turned off here rather than at a call
 * site: remote sessions and remote export, MCP apps, the built-in session store, host git
 * operations, embedding retrieval, long-term memory, infinite sessions, scheduling, and
 * file hooks. The CLI is always the user-installed executable passed as an absolute path.
 *
 * The start is bounded here rather than by the caller, because it is the one native call
 * made while the raw SDK client is still private to this module. A caller was handed
 * nothing it could stop, so a start that never answers is ended here and the CLI it
 * spawned is killed; no client is ever returned once that has happened.
 *
 * It runs on the startup budget rather than the one every release shares, because a cold
 * CLI is still coming up long after a runtime that is already running would have answered.
 */
export const copilotSdkRuntime: CopilotSdkRuntime = {
  async createClient(options: CopilotSdkClientOptions): Promise<CopilotSdkClient> {
    const { CopilotClient, RuntimeConnection } = await loadCopilotSdk();
    const client = new CopilotClient({
      baseDirectory: options.baseDirectory,
      connection: RuntimeConnection.forStdio({
        env: { ...options.environment },
        path: options.cliPath,
      }),
      enableRemoteSessions: false,
      logLevel: 'error',
      workingDirectory: options.workingDirectory,
    });

    const outcome = await settleNativeWithin(client.start(), NATIVE_STARTUP_TIMEOUT_MS);
    if (outcome.kind === 'settled') {
      return new SdkBackedClient(client);
    }

    await stopQuietly(client);
    throw outcome.kind === 'rejected'
      ? toCopilotRuntimeError(outcome.error, 'transport')
      : copilotNativeSilenceError(
        'starting the Copilot CLI',
        NATIVE_STARTUP_TIMEOUT_SECONDS,
      );
  },
};

class SdkBackedClient implements CopilotSdkClient {
  constructor(private readonly client: InstanceType<CopilotSdkModule['CopilotClient']>) {}

  async getAuthStatus(): Promise<{ isAuthenticated: boolean; statusMessage?: string }> {
    try {
      const status = await this.client.getAuthStatus();
      return {
        isAuthenticated: status.isAuthenticated,
        ...(status.statusMessage ? { statusMessage: status.statusMessage } : {}),
      };
    } catch (error) {
      throw toCopilotRuntimeError(error, 'authentication');
    }
  }

  async listModels() {
    try {
      return await this.client.listModels();
    } catch (error) {
      throw toCopilotRuntimeError(error, 'provider');
    }
  }

  async createSession(config: CopilotSdkSessionConfig): Promise<CopilotSdkSession> {
    try {
      return new SdkBackedSession(await this.client.createSession(toSessionConfig(config)));
    } catch (error) {
      throw toCopilotRuntimeError(error, 'provider');
    }
  }

  async resumeSession(
    providerSessionId: string,
    config: CopilotSdkSessionConfig,
  ): Promise<CopilotSdkSession> {
    try {
      const session = await this.client.resumeSession(
        providerSessionId,
        toSessionConfig(config),
      );
      return new SdkBackedSession(session);
    } catch (error) {
      const runtimeError = toCopilotRuntimeError(error, 'provider');
      throw runtimeError.category === 'provider-session-missing'
        ? copilotMissingSessionError(runtimeError.message, providerSessionId)
        : runtimeError;
    }
  }

  async deleteSession(providerSessionId: string): Promise<CopilotSdkSessionDeletion> {
    try {
      await this.client.deleteSession(providerSessionId);
      return 'deleted';
    } catch (error) {
      const failure = toCopilotRuntimeError(error, 'provider');
      if (failure.category === 'provider-session-missing') {
        return 'missing';
      }
      throw failure;
    }
  }

  /**
   * Shuts the CLI down under the shared native release budget, escalating to a forced
   * stop when the graceful one does not fully succeed, and reporting what it could not do.
   *
   * `CopilotClient.stop` resolves with the errors it hit rather than rejecting, so a
   * shutdown that closed neither a session nor its connection looks like a clean one to a
   * caller that only awaits it, and a CLI that stopped answering never resolves it at
   * all. All three mean the same thing here: the CLI was killed instead of shut down, and
   * the caller records that rather than reporting a runtime it released cleanly.
   */
  async stop(): Promise<void> {
    const failure = await this.stopGracefully();
    if (!failure) {
      return;
    }
    await this.forceStopQuietly();
    throw failure;
  }

  /** Returns what the graceful stop could not do, or null when it did all of it. */
  private async stopGracefully(): Promise<CopilotRuntimeError | null> {
    const shutdown = this.client.stop();
    const outcome = await settleNativeWithin(shutdown.then(() => undefined));
    switch (outcome.kind) {
      case 'settled':
        return describeShutdownErrors(await shutdown);
      case 'rejected':
        return toCopilotRuntimeError(outcome.error, 'transport');
      case 'timed-out':
        return shutdownTimeoutError();
    }
  }

  /**
   * A forced stop that failed adds nothing the caller can act on: the graceful failure
   * already says the CLI could not be shut down, and it is the one that is reported. It
   * is bounded too, so a runtime that stopped answering cannot hold the escalation open
   * after it already held the shutdown open.
   */
  private async forceStopQuietly(): Promise<void> {
    await settleNativeWithin(this.client.forceStop());
  }

  async forceStop(): Promise<void> {
    const outcome = await settleNativeWithin(this.client.forceStop());
    if (outcome.kind === 'settled') {
      return;
    }
    throw outcome.kind === 'rejected'
      ? toCopilotRuntimeError(outcome.error, 'transport')
      : shutdownTimeoutError();
  }
}

class SdkBackedSession implements CopilotSdkSession {
  constructor(private readonly session: CopilotSession) {}

  get sessionId(): string {
    return this.session.sessionId;
  }

  async send(prompt: string): Promise<void> {
    try {
      await this.session.sendAndWait(prompt, TURN_TIMEOUT_MS);
    } catch (error) {
      throw toCopilotSendError(error, TURN_TIMEOUT_MS);
    }
  }

  /**
   * The SDK resolves once the runtime acknowledges the abort, and rejects when the session
   * is disconnected or the connection failed. Which of the two happened decides whether
   * the caller may reuse the session for another turn, so it is reported rather than
   * flattened into a resolved promise here.
   */
  async abort(): Promise<void> {
    try {
      await this.session.abort();
    } catch (error) {
      throw toCopilotRuntimeError(error, 'transport');
    }
  }

  async setModel(model: string, reasoningEffort?: CopilotReasoningEffort): Promise<void> {
    try {
      await this.session.setModel(
        model,
        reasoningEffort ? { reasoningEffort } : undefined,
      );
    } catch (error) {
      throw toCopilotRuntimeError(error, 'configuration');
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.session.disconnect();
    } catch (error) {
      throw toCopilotRuntimeError(error, 'transport');
    }
  }
}

/** Ten minutes, matching the longest turn the Copilot CLI will run unattended. */
const TURN_TIMEOUT_MS = 600_000;

function toSessionConfig(config: CopilotSdkSessionConfig): SessionConfig {
  return {
    ...(config.additionalDirectories?.length
      ? { additionalDirectories: [...config.additionalDirectories] }
      : {}),
    ...(config.availableTools ? { availableTools: [...config.availableTools] } : {}),
    ...(config.excludedTools?.length ? { excludedTools: [...config.excludedTools] } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    clientName: 'Claudian',
    customAgentsLocalOnly: true,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableMcpApps: false,
    enableSessionStore: false,
    enableSkills: false,
    includeSubAgentStreamingEvents: false,
    infiniteSessions: { enabled: false },
    manageScheduleEnabled: false,
    memory: { enabled: false },
    model: config.model,
    onEvent: config.onEvent,
    onPermissionRequest: request => config.onPermissionRequest(request),
    onUserInputRequest: request => config.onUserInputRequest(request),
    remoteSession: 'off',
    skipCustomInstructions: true,
    skipEmbeddingRetrieval: true,
    streaming: true,
    systemMessage: config.systemMessage,
    workingDirectory: config.workingDirectory,
  };
}

/**
 * Shuts down a client no caller will ever be handed, and therefore no caller can ever be
 * told about. Nothing can check on it later, so the graceful stop is always followed by a
 * forced one: an orphaned CLI process outlives the vault, while a forced stop on a runtime
 * that already exited does nothing. Both run under the shared release budget, so a CLI
 * that stopped answering cannot hold client creation open instead.
 */
async function stopQuietly(
  client: InstanceType<CopilotSdkModule['CopilotClient']>,
): Promise<void> {
  await settleNativeWithin(client.stop().then(() => undefined));
  await settleNativeWithin(client.forceStop());
}

/** The shutdown a CLI never answered, told as the cleanup failure it is. */
function shutdownTimeoutError(): CopilotRuntimeError {
  return new CopilotRuntimeError(
    'transport',
    'The Copilot CLI did not shut down within '
    + `${NATIVE_OPERATION_TIMEOUT_SECONDS} seconds and was terminated.`,
  );
}

/**
 * Turns the errors `CopilotClient.stop` reports into one categorized failure. An empty
 * list is a clean shutdown and produces none.
 */
function describeShutdownErrors(errors: readonly Error[]): CopilotRuntimeError | null {
  if (errors.length === 0) {
    return null;
  }
  const described = errors.map(error => describeError(error)).join('; ');
  return new CopilotRuntimeError(
    'transport',
    `The Copilot CLI did not shut down cleanly: ${described}`,
    { cause: errors.length === 1 ? errors[0] : new AggregateError(errors) },
  );
}

export function assertAuthenticated(status: {
  isAuthenticated: boolean;
  statusMessage?: string;
}): void {
  if (!status.isAuthenticated) {
    throw copilotAuthenticationError(
      status.statusMessage
        ?? 'The Copilot CLI is not signed in. Run `copilot` in a terminal and sign in.',
    );
  }
}
