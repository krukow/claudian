import type { CopilotReasoningEffort } from '../models';
import type {
  ModelInfo,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
  SessionEvent,
} from './copilotSdkModule';

type UserInputHandler = NonNullable<SessionConfig['onUserInputRequest']>;

/**
 * The whole surface Claudian uses from `@github/copilot-sdk`, restated as a port.
 *
 * Every production module depends on these types instead of the SDK classes, so tests
 * substitute a fake runtime and the SDK plus the `copilot` CLI stay the only mocked
 * boundary. The real implementation lives in `CopilotSdkRuntime`.
 */

export type CopilotSdkEvent = SessionEvent;
export type CopilotSdkModel = ModelInfo;
export type CopilotSdkPermissionRequest = PermissionRequest;
export type CopilotSdkPermissionResult = PermissionRequestResult;
export type CopilotSdkUserInputRequest = Parameters<UserInputHandler>[0];
export type CopilotSdkUserInputResponse = Awaited<ReturnType<UserInputHandler>>;

export interface CopilotSdkAuthStatus {
  readonly isAuthenticated: boolean;
  readonly statusMessage?: string;
}

/** Everything that decides which CLI process, account, and data directory back a client. */
export interface CopilotSdkClientOptions {
  /** Absolute path to the user-installed `copilot` executable. Never SDK-bundled. */
  readonly cliPath: string;
  /** `COPILOT_HOME` for the spawned CLI, kept outside vault content. */
  readonly baseDirectory: string;
  /** Complete environment for the CLI process. Not merged with `process.env` downstream. */
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
}

export interface CopilotSdkSessionConfig {
  readonly additionalDirectories?: readonly string[];
  /** Tool allow-list. An empty array denies every tool; `undefined` keeps CLI defaults. */
  readonly availableTools?: readonly string[];
  readonly excludedTools?: readonly string[];
  readonly model: string;
  readonly onEvent: (event: CopilotSdkEvent) => void;
  readonly onPermissionRequest: (
    request: CopilotSdkPermissionRequest,
  ) => Promise<CopilotSdkPermissionResult>;
  readonly onUserInputRequest: (
    request: CopilotSdkUserInputRequest,
  ) => Promise<CopilotSdkUserInputResponse>;
  readonly reasoningEffort?: CopilotReasoningEffort;
  readonly systemMessage: CopilotSdkSystemMessage;
  readonly workingDirectory: string;
}

export type CopilotSdkSystemMessage =
  | { readonly mode: 'replace'; readonly content: string }
  | { readonly mode: 'append'; readonly content: string };

export interface CopilotSdkSession {
  readonly sessionId: string;
  /** Sends a prompt and resolves when the turn reaches idle. */
  send(prompt: string): Promise<void>;
  /**
   * Stops the running turn. Resolves once the runtime acknowledges the abort, and rejects
   * when it could not: the caller may only reuse the session in the first case.
   */
  abort(): Promise<void>;
  setModel(model: string, reasoningEffort?: CopilotReasoningEffort): Promise<void>;
  /** Releases in-memory resources. Native session data is left untouched. */
  disconnect(): Promise<void>;
}

/**
 * Outcome of deleting native session data. A session the runtime already dropped is
 * `missing`: the data Claudian wanted gone is gone, which is not a cleanup failure.
 */
export type CopilotSdkSessionDeletion = 'deleted' | 'missing';

export interface CopilotSdkClient {
  getAuthStatus(): Promise<CopilotSdkAuthStatus>;
  listModels(): Promise<readonly CopilotSdkModel[]>;
  createSession(config: CopilotSdkSessionConfig): Promise<CopilotSdkSession>;
  resumeSession(
    providerSessionId: string,
    config: CopilotSdkSessionConfig,
  ): Promise<CopilotSdkSession>;
  /** Deletes native session data. Only used for ephemeral sessions Claudian created. */
  deleteSession(providerSessionId: string): Promise<CopilotSdkSessionDeletion>;
  /**
   * Shuts the CLI down, escalating to {@link forceStop} when the graceful stop does not
   * fully succeed. Rejects with what that stop could not do, so a caller that has to
   * account for the runtime it released learns the CLI was killed rather than shut down.
   *
   * Always settles within the shared native release budget, unlike
   * {@link CopilotSdkSession}'s abort and disconnect, which their caller bounds. A caller
   * bounds those two because it has to decide what a silent runtime means for a session it
   * might still reuse; a client being stopped is discarded either way, so bounding it here
   * is both enough and the only place that covers every caller, including the
   * model-discovery probe and the authentication gate.
   */
  stop(): Promise<void>;
  /**
   * Terminates the CLI process without waiting for it to shut down cleanly. Settles
   * within the same release budget as {@link stop}.
   */
  forceStop(): Promise<void>;
}

export interface CopilotSdkRuntime {
  /**
   * Starts a CLI and hands back the client bound to it, within the startup budget rather
   * than the shorter one every release shares: a cold CLI is still coming up long after a
   * runtime that is already running would have answered.
   */
  createClient(options: CopilotSdkClientOptions): Promise<CopilotSdkClient>;
}
