import type { CopilotReasoningEffort } from '../models';
import type {
  MCPServerConfig,
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
export type CopilotSdkMcpServerConfig = MCPServerConfig;
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
  /**
   * `COPILOT_HOME` for the spawned CLI, kept outside vault content.
   *
   * Must be absolute, and a per-vault directory of Claudian's own. It is what the runtime
   * reads a session's installed plugins and global configuration from, and the SDK only
   * clears those for a client in the mode that also shuts the CLI out of its keychain, so
   * this directory is the isolation. An empty one leaves `COPILOT_HOME` unset and hands
   * the CLI the user's shared `~/.copilot`; a relative one is resolved against the vault
   * the CLI is spawned in.
   */
  readonly baseDirectory: string;
  /** Complete environment for the CLI process. Not merged with `process.env` downstream. */
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
}

/**
 * What a caller decides about a session.
 *
 * Everything a session could use to read the user's global Copilot configuration or act
 * outside the vault is deliberately absent: plugin and instruction directories, file
 * hooks, host git operations, the cross-session store, memory, remote export, telemetry,
 * persistent embedding and OAuth storage, and runtime configuration discovery are stated
 * by `CopilotSdkRuntime` on every create and resume, and cannot be reached — or weakened —
 * from here. MCP servers and skills reach a session only through {@link resources}, which
 * names each one; a session without it starts none, including the ones the CLI's own home
 * would otherwise supply.
 */
export interface CopilotSdkSessionConfig {
  readonly additionalDirectories?: readonly string[];
  /**
   * Tool allow-list. An empty array denies every tool, including the tools of a server
   * named in {@link resources}: a selection says which servers a session may reach, never
   * that it has tools. This list alone is the grant.
   *
   * Required rather than optional: omitting it reads as "keep the CLI's own defaults",
   * which is the ambient coding-agent behaviour every other field here exists to keep out,
   * and the caller that omitted it would not learn so until a turn ran.
   */
  readonly availableTools: readonly string[];
  /**
   * Tool deny-list, which always wins over {@link availableTools}: the SDK sends
   * `toolFilterPrecedence: 'excluded'` for every client it builds.
   */
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
  /** The named MCP servers and skills this session may use. Absent means none of them. */
  readonly resources?: CopilotSdkSessionResources;
  readonly systemMessage: CopilotSdkSystemMessage;
  readonly workingDirectory: string;
}

/**
 * The resources one session runs with, resolved by the caller and never persisted.
 *
 * Each server is named and defined here rather than referred to, because the runtime
 * reads a definition from the caller or from its own configuration, and only the first of
 * those is something Claudian chose. Skill directories are package directories: the CLI
 * loads every skill under a directory it is pointed at, so a parent root would enable the
 * siblings of the skill that was selected.
 *
 * This is a narrowing, not a grant. A session whose {@link CopilotSdkSessionConfig.availableTools}
 * is empty connects the servers named here and is given none of their tools, so a caller
 * that opened a session only to ask the runtime something does not become one that can
 * call an MCP server. Only a session that already allows tools has its allow-list widened,
 * and only with the exact tools its selected servers offer.
 */
export interface CopilotSdkSessionResources {
  readonly mcpServers: Readonly<Record<string, CopilotSdkMcpServerConfig>>;
  readonly skillDirectories: readonly string[];
}

/**
 * How the caller's instructions reach the runtime's system prompt.
 *
 * `replace` supplies the whole message and keeps nothing the runtime would have built.
 * `append` keeps the runtime's own sections and adds to them — except its account of the
 * host the CLI is running on, which `CopilotSdkRuntime` always removes.
 */
export type CopilotSdkSystemMessage =
  | { readonly mode: 'replace'; readonly content: string }
  | { readonly mode: 'append'; readonly content: string };

export interface CopilotSdkSession {
  readonly sessionId: string;
  /**
   * What the session could not fully set up: a selected MCP server that never connected,
   * or a tool list its server refused. The resources themselves are still absent rather
   * than substituted, so a caller reports these instead of a turn behaving as though a
   * server had answered.
   */
  readonly resourceDiagnostics: readonly string[];
  /** Sends a prompt and resolves when the turn reaches idle. */
  send(prompt: string): Promise<void>;
  /**
   * The user-invocable slash commands the selected skills registered, and nothing else:
   * no builtin skill, and no command the runtime or a client owns.
   */
  listSkillCommands(): Promise<readonly CopilotSdkSkillCommand[]>;
  /**
   * Runs one of those commands and returns what the runtime produced for it. A skill
   * answers with a prompt the caller has to submit; nothing is sent by invoking it.
   */
  invokeSkillCommand(name: string, input: string): Promise<CopilotSdkSkillInvocation>;
  /**
   * Stops the running turn. Resolves once the runtime acknowledges the abort, and rejects
   * when it could not: the caller may only reuse the session in the first case.
   */
  abort(): Promise<void>;
  setModel(model: string, reasoningEffort?: CopilotReasoningEffort): Promise<void>;
  /** Releases in-memory resources. Native session data is left untouched. */
  disconnect(): Promise<void>;
}

export interface CopilotSdkSkillCommand {
  readonly argumentHint?: string;
  readonly description?: string;
  readonly name: string;
}

/**
 * What invoking a skill command produced: the prompt the caller submits as the turn, or
 * text the runtime answered with directly and no turn to run.
 */
export type CopilotSdkSkillInvocation =
  | {
      readonly kind: 'prompt';
      readonly prompt: string;
      readonly displayPrompt: string;
      readonly notice?: string;
    }
  | { readonly kind: 'text'; readonly text: string };

/**
 * Outcome of deleting native session data. A session the runtime already dropped is
 * `missing`: the data Claudian wanted gone is gone, which is not a cleanup failure.
 */
export type CopilotSdkSessionDeletion = 'deleted' | 'missing';

export interface CopilotSdkClient {
  getAuthStatus(): Promise<CopilotSdkAuthStatus>;
  listModels(): Promise<readonly CopilotSdkModel[]>;
  /**
   * Opens a session with bounded native acquisition and resource preparation. Individual
   * acquisitions use the release budget; selected resources share one startup budget.
   *
   * The deadline belongs here rather than to a caller: the CLI a silent request was made
   * of is stopped and killed before this rejects, which only the owner of that client can
   * do, and a session that arrives afterwards is disconnected where it arrives. A caller
   * therefore never has to wrap a deadline of its own around an inner call that might
   * never answer — it receives a transport failure saying the CLI was terminated, drops
   * the client, and starts a fresh one.
   */
  createSession(config: CopilotSdkSessionConfig): Promise<CopilotSdkSession>;
  /** Resumes a session under the same budget and cleanup as {@link createSession}. */
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
