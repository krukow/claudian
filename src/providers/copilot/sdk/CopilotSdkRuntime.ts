import * as path from 'node:path';

import type { CopilotReasoningEffort } from '../models';
import { isAbsoluteCopilotPath } from '../runtime/CopilotAbsolutePath';
import { canonicalizeCopilotHostPath } from '../runtime/CopilotCanonicalPath';
import {
  acquireNativeWithin,
  copilotNativeSilenceError,
  NATIVE_OPERATION_TIMEOUT_SECONDS,
  NATIVE_STARTUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_SECONDS,
  settleNativeWithin,
} from './CopilotNativeBudget';
import {
  copilotAuthenticationError,
  copilotConfigurationError,
  copilotMissingSessionError,
  CopilotRuntimeError,
  describeError,
  toCopilotRuntimeError,
  toCopilotSendError,
} from './CopilotRuntimeError';
import type * as copilotSdkModule from './copilotSdkModule';
import type {
  CopilotClientOptions,
  CopilotSession,
  SessionConfig,
} from './copilotSdkModule';
import type {
  CopilotSdkClient,
  CopilotSdkClientOptions,
  CopilotSdkRuntime,
  CopilotSdkSession,
  CopilotSdkSessionConfig,
  CopilotSdkSessionDeletion,
  CopilotSdkSessionResources,
  CopilotSdkSkillCommand,
  CopilotSdkSkillInvocation,
  CopilotSdkSystemMessage,
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
 * The client runs in the SDK's `copilot-cli` defaulting mode, because that is the only
 * mode which leaves the CLI able to reach its own credential store. `mode: 'empty'` writes
 * `COPILOT_DISABLE_KEYTAR=1` into the environment the CLI is spawned with — after the
 * caller's own environment, so nothing can take it back out — and a CLI that cannot open
 * its keychain reports itself signed out however recently the user signed in. Claudian
 * owns no GitHub credential and offers nowhere to keep one, so the CLI's own sign-in is
 * the only thing that can answer the auth gate: no token is handed to the SDK, and the
 * `gh` CLI is not a fallback Claudian promises.
 *
 * What empty mode used to supply is therefore supplied here instead. Every capability
 * Claudian does not support is stated on each session rather than defaulted: session
 * telemetry, the shared embedding cache and its retrieval, keychain-backed MCP OAuth
 * storage, MCP servers and apps, remote sessions and remote export, the built-in session
 * store, host git operations, long-term memory, infinite sessions, scheduling, skills,
 * file hooks, plugin directories, custom instructions and their on-demand discovery,
 * runtime configuration discovery, experimental features, the commit co-author trailer,
 * and the runtime's own description of the host it is running on. The CLI is always the
 * user-installed executable passed as an absolute path.
 *
 * A session's installed plugins are the one thing that cannot be stated: the SDK exposes
 * them only through the patch it sends in empty mode. They are read from the runtime's
 * `COPILOT_HOME`, which is why {@link CopilotSdkClientOptions.baseDirectory} must be a
 * per-vault directory of Claudian's own and is checked before a CLI is started.
 *
 * The start is bounded here rather than by the caller, because it is the one native call
 * made while the raw SDK client is still private to this module. A caller was handed
 * nothing it could stop, so a start that never answers is ended here and the CLI it
 * spawned is killed; no client is ever returned once that has happened.
 *
 * Opening a session is bounded here for a related reason: ending the CLI that went silent
 * on one is something only the module that owns the client can do, so the layer above is
 * given a bounded call and a terminated process rather than an unbounded request it would
 * have to wrap a deadline around and could not clean up after.
 *
 * It runs on the startup budget rather than the one every release shares, because a cold
 * CLI is still coming up long after a runtime that is already running would have answered.
 */
export const copilotSdkRuntime: CopilotSdkRuntime = {
  async createClient(options: CopilotSdkClientOptions): Promise<CopilotSdkClient> {
    if (!isAbsoluteCopilotPath(options.baseDirectory)) {
      throw copilotConfigurationError(
        'The Copilot CLI was given no usable data directory of its own. `COPILOT_HOME` '
        + 'must name an absolute per-vault directory: an empty one leaves it unset, so '
        + 'the CLI writes this vault\'s agent state into the user\'s shared '
        + '`~/.copilot` and reads that install\'s plugins and configuration, and a '
        + 'relative one is resolved against the vault the CLI is spawned in, so that '
        + 'state lands inside the notes it is meant to stay out of.',
      );
    }

    const { CopilotClient, RuntimeConnection } = await loadCopilotSdk();
    const client = new CopilotClient({
      baseDirectory: options.baseDirectory,
      connection: RuntimeConnection.forStdio({
        env: { ...options.environment },
        path: options.cliPath,
      }),
      enableRemoteSessions: false,
      logLevel: 'error',
      mode: 'copilot-cli',
      useLoggedInUser: true,
      workingDirectory: options.workingDirectory,
    } satisfies CopilotClientOptions);

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
      const disabledMcpServers = await this.excludeAmbientMcpServers(config);
      const session = await this.openSession(
        this.client.createSession(toSessionConfig(config, disabledMcpServers)),
        'open a session',
      );
      return await this.prepareSession(session, config, true);
    } catch (error) {
      throw toCopilotRuntimeError(error, 'provider');
    }
  }

  async resumeSession(
    providerSessionId: string,
    config: CopilotSdkSessionConfig,
  ): Promise<CopilotSdkSession> {
    try {
      const disabledMcpServers = await this.excludeAmbientMcpServers(config);
      const session = await this.openSession(
        this.client.resumeSession(
          providerSessionId,
          toSessionConfig(config, disabledMcpServers),
        ),
        'resume the session',
      );
      return await this.prepareSession(session, config, false);
    } catch (error) {
      const runtimeError = toCopilotRuntimeError(error, 'provider');
      throw runtimeError.category === 'provider-session-missing'
        ? copilotMissingSessionError(runtimeError.message, providerSessionId)
        : runtimeError;
    }
  }

  /**
   * Names every MCP server the CLI would otherwise start on its own, so the session can
   * refuse them by name.
   *
   * A session that states no servers still gets the ones its `COPILOT_HOME` configuration
   * and its plugins declare: an empty map is not a replacement, and neither
   * `enableConfigDiscovery: false` nor an empty tool list stops the process from being
   * launched and authenticated. Only `disabledMcpServers` does, and it takes exact names,
   * which is what this enumeration is for. A caller's own selection is left out of the
   * list, because those are the servers it asked for.
   *
   * An enumeration that fails leaves no list, and a session opened without one would run
   * whatever the CLI's home holds. That is the single thing this boundary promises it does
   * not do, so nothing is opened.
   */
  private async excludeAmbientMcpServers(
    config: CopilotSdkSessionConfig,
  ): Promise<readonly string[]> {
    const selected = new Set(Object.keys(config.resources?.mcpServers ?? {}));
    const outcome = await acquireNativeWithin(
      this.client.rpc.mcp.discover({ workingDirectory: config.workingDirectory }),
    );
    switch (outcome.kind) {
      case 'settled':
        return outcome.value.servers
          .map(server => server.name)
          .filter(name => !selected.has(name));
      case 'rejected':
        throw outcome.error;
      case 'timed-out':
        await stopQuietly(this.client);
        throw copilotNativeSilenceError('listing the MCP servers this computer configures');
    }
  }

  private async prepareSession(
    session: CopilotSession,
    config: CopilotSdkSessionConfig,
    unpublished: boolean,
  ): Promise<CopilotSdkSession> {
    if (!config.resources) {
      return new SdkBackedSession(session, [], new Set());
    }
    const cancellation = new AbortController();
    const call: ResourceSetupCall = async operation => {
      cancellation.signal.throwIfAborted();
      const result = await operation();
      cancellation.signal.throwIfAborted();
      return result;
    };
    const outcome = await acquireNativeWithin(
      prepareSessionResources(session, config, call),
      undefined,
      NATIVE_STARTUP_TIMEOUT_MS,
    );
    if (outcome.kind === 'settled') {
      return outcome.value;
    }
    const error = outcome.kind === 'rejected'
      ? outcome.error
      : copilotNativeSilenceError('preparing selected Copilot resources', NATIVE_STARTUP_TIMEOUT_SECONDS);
    cancellation.abort(error);

    const failures: unknown[] = [error];
    const disconnected = await settleNativeWithin(session.disconnect());
    if (disconnected.kind !== 'settled') {
      failures.push(disconnected.kind === 'rejected'
        ? disconnected.error
        : copilotNativeSilenceError('disconnecting an unprepared Copilot session'));
    }
    // No caller or turn has ever owned a fresh session whose preparation failed.
    if (unpublished) {
      const deleted = await settleNativeWithin(this.client.deleteSession(session.sessionId));
      if (deleted.kind !== 'settled') {
        failures.push(deleted.kind === 'rejected'
          ? deleted.error
          : copilotNativeSilenceError('deleting an unpublished Copilot session'));
      }
    }
    if (outcome.kind === 'timed-out' || failures.length > 1) {
      await stopQuietly(this.client);
      throw new CopilotRuntimeError(
        'transport',
        `${failures.map(describeError).join('; ')}. The Copilot CLI was terminated.`,
        { cause: new AggregateError(failures, 'Copilot resource preparation failed.') },
      );
    }
    throw error;
  }

  /**
   * Waits for a session the CLI is opening, under the shared native release budget.
   *
   * Opening one is an acquisition from a runtime that is already up, so it answers or it
   * does not; a CLI that never answers would otherwise hold the turn that asked open for
   * as long as it stays silent, and hold whatever is queued behind that turn open with
   * it. Bounding it here is what lets the layer above call this like any other native
   * operation instead of wrapping a deadline of its own around an unbounded call.
   *
   * A CLI that went silent cannot be asked anything else, so it is stopped and killed
   * rather than handed back as a client whose next call waits out the same silence, and
   * the caller is told what happened to it. A session that arrives afterwards belongs to
   * nobody — the caller already has its failure and the process is gone — so it is
   * disconnected where it arrives rather than left open, and neither its arrival nor its
   * refusal replaces the failure that was already reported.
   */
  private async openSession(
    opening: Promise<CopilotSession>,
    step: string,
  ): Promise<CopilotSession> {
    const outcome = await acquireNativeWithin(
      opening,
      session => session.disconnect(),
    );
    switch (outcome.kind) {
      case 'settled':
        return outcome.value;
      case 'rejected':
        throw outcome.error;
      case 'timed-out':
        await stopQuietly(this.client);
        throw sessionSilenceError(step);
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
  constructor(
    private readonly session: CopilotSession,
    readonly resourceDiagnostics: readonly string[],
    /** Command names the selected skills answer to, lowercased for the runtime's match. */
    private readonly skillCommandNames: ReadonlySet<string>,
  ) {}

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
   * The commands the selected skills registered.
   *
   * The runtime also lists its own builtin skills, which no selection covers, so the
   * listing is narrowed to the commands the selected packages answer to. Builtin and
   * client commands are excluded at the request itself.
   */
  async listSkillCommands(): Promise<readonly CopilotSdkSkillCommand[]> {
    if (this.skillCommandNames.size === 0) {
      return [];
    }
    const listing = await this.acquire(
      this.session.rpc.commands.list({
        includeBuiltins: false,
        includeClientCommands: false,
        includeSkills: true,
      }),
      'listing the Copilot skill commands',
    );
    return listing.commands
      .filter(command => (
        command.kind === 'skill' && this.skillCommandNames.has(command.name.toLowerCase())
      ))
      .map(command => ({
        ...(command.description ? { description: command.description } : {}),
        ...(command.input?.hint ? { argumentHint: command.input.hint } : {}),
        name: command.name,
      }));
  }

  async invokeSkillCommand(
    name: string,
    input: string,
  ): Promise<CopilotSdkSkillInvocation> {
    const result = await this.acquire(
      this.session.rpc.commands.invoke({ ...(input ? { input } : {}), name }),
      `invoking the Copilot skill command ${name}`,
    );
    if (result.kind === 'agent-prompt') {
      return {
        displayPrompt: result.displayPrompt,
        kind: 'prompt',
        ...(result.notice ? { notice: result.notice } : {}),
        prompt: result.prompt,
      };
    }
    if (result.kind === 'text') {
      return { kind: 'text', text: result.text };
    }
    throw copilotConfigurationError(
      `The Copilot skill command ${name} answered with something Claudian cannot run `
      + `(${result.kind}). Send the request as an ordinary message instead.`,
    );
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

  /** One bounded metadata call against a runtime that is already up. */
  private async acquire<T>(work: Promise<T>, context: string): Promise<T> {
    const outcome = await acquireNativeWithin(work);
    switch (outcome.kind) {
      case 'settled':
        return outcome.value;
      case 'rejected':
        throw toCopilotRuntimeError(outcome.error, 'provider');
      case 'timed-out':
        throw copilotNativeSilenceError(context);
    }
  }
}

/**
 * Brings a freshly opened session down to exactly the resources it was given, before its
 * caller can run a turn on it.
 *
 * Two things survive the session configuration and have to be answered here. The runtime
 * loads its own builtin skills whenever skills are enabled at all, so every skill that is
 * not one of the selected packages is disabled by name. And a selected MCP server's tools
 * are only knowable once it has connected, so the session's allow-list is widened to the
 * exact `mcp:<server>-<tool>` names it offers — never `mcp:*`, which would carry every
 * tool of every server the runtime ever loads.
 *
 * A server that has not connected contributes no tools and is reported instead, because a
 * turn that ran as though it had would be answering without the resource the user asked
 * for. Anything that leaves the session unable to reach that state releases it: a session
 * whose unselected skills are still loaded is not the session the caller asked for.
 */
async function prepareSessionResources(
  session: CopilotSession,
  config: CopilotSdkSessionConfig,
  call: ResourceSetupCall,
): Promise<CopilotSdkSession> {
  const resources = config.resources;
  if (!resources) {
    return new SdkBackedSession(session, [], new Set());
  }
  const skillCommandNames = await selectNativeSkills(session, resources, call);
  const mcp = await collectSelectedMcpTools(session, config, resources, call);
  if (mcp.tools.length > 0) {
    await call(() => session.rpc.options.update({
        availableTools: [...config.availableTools, ...mcp.tools],
    }));
  }
  return new SdkBackedSession(session, mcp.diagnostics, skillCommandNames);
}

type ResourceSetupCall = <T>(operation: () => Promise<T>) => Promise<T>;

/** Disables every loaded skill outside the selection, and names those that stay. */
async function selectNativeSkills(
  session: CopilotSession,
  resources: CopilotSdkSessionResources,
  call: ResourceSetupCall,
): Promise<ReadonlySet<string>> {
  if (resources.skillDirectories.length === 0) {
    return new Set();
  }
  const selectedDirectories = new Set(resources.skillDirectories.flatMap(directory => [
    path.normalize(directory),
    canonicalizeCopilotHostPath(directory, process.platform),
  ].filter((value): value is string => Boolean(value))));
  await call(() => session.rpc.skills.ensureLoaded());
  const listed = await call(() => session.rpc.skills.list());
  const commandNames = new Set<string>();
  for (const skill of listed.skills) {
    if (isSelectedSkill(skill.path, selectedDirectories)) {
      if (skill.userInvocable) {
        commandNames.add((skill.commandName ?? skill.name).toLowerCase());
      }
      continue;
    }
    await call(() => session.rpc.skills.disable({ name: skill.name }));
  }
  return commandNames;
}

/**
 * Whether a loaded skill is one of the selected packages.
 *
 * The runtime reports the path it reached a skill through, which need not be the spelling
 * the directory was selected under: macOS reaches every temporary directory through
 * `/var`, a link to `/private/var`, and a vault kept on an external disk or in a synced
 * folder is commonly a link itself. So the spelling is asked first and the name the
 * filesystem gives both sides second — two spellings that resolve to one directory are
 * one skill package, and a skill with no path at all is one the runtime supplied rather
 * than one that was selected.
 */
function isSelectedSkill(
  skillPath: string | undefined,
  selectedDirectories: ReadonlySet<string>,
): boolean {
  if (!skillPath) {
    return false;
  }
  const directory = path.dirname(skillPath);
  if (selectedDirectories.has(path.normalize(directory))) {
    return true;
  }
  const canonical = canonicalizeCopilotHostPath(directory, process.platform);
  return canonical !== null && selectedDirectories.has(canonical);
}

/** The exact MCP tool names the session may use, and what could not be asked. */
async function collectSelectedMcpTools(
  session: CopilotSession,
  config: CopilotSdkSessionConfig,
  resources: CopilotSdkSessionResources,
  call: ResourceSetupCall,
): Promise<{ diagnostics: string[]; tools: string[] }> {
  const serverNames = Object.keys(resources.mcpServers);
  if (serverNames.length === 0) {
    return { diagnostics: [], tools: [] };
  }
  const diagnostics: string[] = [];
  const tools: string[] = [];
  const states = await settleMcpConnections(session, serverNames, call);
  /**
   * Selecting a server says which servers this session may reach, not that it has tools.
   * An empty allow-list is the port's deny-all, and widening it here would turn a
   * tool-free caller — the command-metadata probe, or any other session opened only to
   * ask the runtime something — into one that can call an MCP server because a selection
   * happened to exist. The base list is the grant; the selection only narrows what a
   * granted session may reach.
   */
  const grantsTools = config.availableTools.length > 0;

  for (const serverName of serverNames) {
    const unavailable = describeUnavailableServer(serverName, states.get(serverName));
    if (unavailable) {
      diagnostics.push(unavailable);
      continue;
    }
    if (!grantsTools) {
      continue;
    }
    const server = resources.mcpServers[serverName];
    const allowed = server.tools && !server.tools.includes('*')
      ? new Set(server.tools)
      : null;
    try {
      const listing = await call(() => session.rpc.mcp.listTools({ serverName }));
      for (const tool of listing.tools) {
        if (!allowed || allowed.has(tool.name)) {
          tools.push(`mcp:${serverName}-${tool.name}`);
        }
      }
    } catch (error) {
      diagnostics.push(
        `The MCP server ${serverName} did not answer with its tools, so none of them are `
        + `available in this session: ${describeError(error)}`,
      );
    }
  }
  return { diagnostics, tools };
}

/** How often the runtime is asked again about a server it is still connecting. */
const MCP_CONNECTION_POLL_MS = 250;

/**
 * Waits until no selected server is still connecting, and reports where each one ended up.
 *
 * A server is a process the runtime spawns and handshakes with while the session is
 * opening, so asking for its tools immediately would ask a server that has not answered
 * yet. That wait runs on the startup budget rather than the release one for the same
 * reason starting the CLI does: it is cold work a first launch, a package download, or a
 * slow disk stretches well past what a running runtime takes to answer.
 *
 * A server missing from a successful state listing is resolved through its tool listing.
 * A failed state request is a setup error, not evidence that the server is available.
 */
async function settleMcpConnections(
  session: CopilotSession,
  serverNames: readonly string[],
  call: ResourceSetupCall,
): Promise<Map<string, McpServerState>> {
  for (;;) {
    const states = await call(() => readMcpServerStates(session, serverNames));
    const pending = serverNames.filter(name => states.get(name)?.status === 'pending');
    if (pending.length === 0) {
      return states;
    }
    await call(() => new Promise(resolve => window.setTimeout(resolve, MCP_CONNECTION_POLL_MS)));
  }
}

interface McpServerState {
  readonly failure?: string;
  readonly status: string;
}

/** Selected server states reported by the pinned runtime. */
async function readMcpServerStates(
  session: CopilotSession,
  serverNames: readonly string[],
): Promise<Map<string, McpServerState>> {
  const states = new Map<string, McpServerState>();
  const listing = await session.rpc.mcp.list();
  for (const server of listing.servers) {
    if (!serverNames.includes(server.name)) {
      continue;
    }
    const failure = server.error ?? listing.host?.failedServers?.[server.name]?.message;
    states.set(server.name, {
      ...(failure ? { failure } : {}),
      status: server.status,
    });
  }
  return states;
}

/** Why a selected server offers nothing, or null when it is one the session may ask. */
function describeUnavailableServer(
  serverName: string,
  state: McpServerState | undefined,
): string | null {
  if (!state || state.status === 'connected') {
    return null;
  }
  const detail = state.failure ? `: ${state.failure}` : '';
  return `The MCP server ${serverName} is ${state.status}, so none of its tools are `
    + `available in this session${detail}.`;
}

/** Ten minutes, matching the longest turn the Copilot CLI will run unattended. */
const TURN_TIMEOUT_MS = 600_000;

/**
 * The session Claudian asks for, stated in full.
 *
 * Nothing here is left to a runtime default. The SDK only fills these in for a client in
 * empty mode, which is the mode that shuts the CLI out of its keychain, so a session that
 * omitted them would inherit the coding agent's own behaviour: telemetry on, an embedding
 * cache shared on disk between sessions, MCP OAuth tokens written to the OS keychain, a
 * commit co-author trailer, and whatever instruction, skill, plugin, and MCP sources the
 * runtime discovers around the vault.
 *
 * The caller chooses tools, a model, directories, and the handlers; it cannot reach any of
 * this, because a session that could would be a session that could read the user's global
 * Copilot configuration or act outside the vault.
 */
function toSessionConfig(
  config: CopilotSdkSessionConfig,
  disabledMcpServers: readonly string[],
): SessionConfig {
  const resources = config.resources;
  return {
    ...(config.additionalDirectories?.length
      ? { additionalDirectories: [...config.additionalDirectories] }
      : {}),
    ...(config.excludedTools?.length ? { excludedTools: [...config.excludedTools] } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(resources?.skillDirectories.length
      ? { skillDirectories: [...resources.skillDirectories] }
      : {}),
    availableTools: [...config.availableTools],
    clientName: 'Claudian',
    coauthorEnabled: false,
    customAgentsLocalOnly: true,
    disabledMcpServers: [...disabledMcpServers],
    embeddingCacheStorage: 'in-memory',
    enableConfigDiscovery: false,
    enableExperimentalMode: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableMcpApps: false,
    enableOnDemandInstructionDiscovery: false,
    enableSessionStore: false,
    enableSessionTelemetry: false,
    enableSkills: (resources?.skillDirectories.length ?? 0) > 0,
    includeSubAgentStreamingEvents: false,
    infiniteSessions: { enabled: false },
    manageScheduleEnabled: false,
    mcpOAuthTokenStorage: 'in-memory',
    mcpServers: { ...resources?.mcpServers },
    memory: { enabled: false },
    model: config.model,
    onEvent: config.onEvent,
    onPermissionRequest: request => config.onPermissionRequest(request),
    onUserInputRequest: request => config.onUserInputRequest(request),
    pluginDirectories: [],
    remoteSession: 'off',
    skipCustomInstructions: true,
    skipEmbeddingRetrieval: true,
    streaming: true,
    systemMessage: toSystemMessageConfig(config.systemMessage),
    workingDirectory: config.workingDirectory,
  };
}

/**
 * The system message as the runtime receives it, with its own account of the host removed.
 *
 * A replaced message has no runtime sections left to strip. An appended one keeps every
 * section the CLI would build for its own coding agent, `environment_context` among them,
 * which describes the machine Claudian's session is running on. Asking for the removal by
 * name is what empty mode used to do on Claudian's behalf; the appended content itself is
 * unchanged, because the runtime appends it as additional instructions either way.
 */
function toSystemMessageConfig(
  systemMessage: CopilotSdkSystemMessage,
): SessionConfig['systemMessage'] {
  return systemMessage.mode === 'replace'
    ? { content: systemMessage.content, mode: 'replace' }
    : {
      content: systemMessage.content,
      mode: 'customize',
      sections: { environment_context: { action: 'remove' } },
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
 * The session a CLI never opened, told as the transport failure it is. The CLI it was
 * asked of is gone by the time this is raised, so the message says so: the next attempt
 * starts a fresh one rather than waiting out the same silence.
 */
function sessionSilenceError(step: string): CopilotRuntimeError {
  return new CopilotRuntimeError(
    'transport',
    `Copilot did not ${step} within ${NATIVE_OPERATION_TIMEOUT_SECONDS} seconds. `
    + 'The CLI was terminated; send the message again to start a fresh one.',
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

/**
 * Refuses a client whose CLI is not signed in, and says which sign-in would fix it.
 *
 * Claudian hands the CLI a `COPILOT_HOME` of this vault's own, so that this vault's agent
 * state, plugins, and configuration stay out of the user's shared install. The credential
 * itself is shared — the CLI keeps one per host in the OS keychain — but the record of
 * which account it belongs to lives in the home it was signed in with, and without that
 * record the CLI never opens the keychain. A home nobody has signed in to is therefore the
 * ordinary first failure, and a bare `copilot` would sign in to `~/.copilot` and change
 * nothing here, so the directory is named.
 *
 * What the CLI said is kept rather than replaced: "Not authenticated" adds nothing, but an
 * expiry or a single-sign-on refusal is the whole answer.
 */
export function assertAuthenticated(
  status: { isAuthenticated: boolean; statusMessage?: string },
  baseDirectory: string,
): void {
  if (status.isAuthenticated) {
    return;
  }
  throw copilotAuthenticationError(
    `The Copilot CLI is not signed in for this vault${
      status.statusMessage ? ` (it reports: ${status.statusMessage})` : ''
    }. Claudian runs the CLI with a \`COPILOT_HOME\` of this vault's own, at `
    + `\`${baseDirectory}\`, so this vault's agent state and plugins stay out of your `
    + 'shared Copilot install. Sign in to it once by running the Copilot CLI with '
    + '`COPILOT_HOME` set to that directory and signing in there; signing in without it '
    + 'signs in to the shared install instead and leaves this vault signed out.',
  );
}
