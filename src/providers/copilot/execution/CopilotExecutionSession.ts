import { randomUUID } from 'node:crypto';

import type {
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderExecutionRun,
  ProviderExecutionSession,
  ProviderRequestedEventScope,
  ProviderSessionConfig,
  ProviderSessionEvent,
  ProviderSessionSnapshot,
  ProviderSessionStatus,
} from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { CopilotReasoningEffort } from '../models';
import {
  decodeCopilotModelId,
  encodeCopilotModelId,
  isCopilotReasoningEffort,
} from '../models';
import { getCopilotHostResources } from '../resources/CopilotHostResources';
import { resolveCopilotSelectedResources } from '../resources/CopilotResourceResolver';
import {
  type CopilotClientFactory,
  type CopilotClientIdentity,
  isSameCopilotClientIdentity,
} from '../sdk/CopilotClientFactory';
import {
  acquireNativeWithin,
  copilotNativeSilenceError,
  settleNativeWithin,
} from '../sdk/CopilotNativeBudget';
import {
  copilotConfigurationError,
  CopilotRuntimeError,
  toCopilotRuntimeError,
} from '../sdk/CopilotRuntimeError';
import type {
  CopilotSdkClient,
  CopilotSdkSession,
  CopilotSdkSessionConfig,
  CopilotSdkSessionResources,
} from '../sdk/CopilotSdkPort';
import { getCopilotProviderSettings, getEnabledCopilotModels } from '../settings';
import { CopilotEventNormalizer } from './CopilotEventNormalizer';
import type { CopilotExecutionEventDraft } from './CopilotExecutionEventDraft';
import { CopilotInteractionHandler } from './CopilotInteractionHandler';
import {
  allowsCopilotResources,
  decodeSkillCommandInput,
  describeUnsupportedInput,
  encodeAdditionalDirectories,
  encodeCopilotResourceDigest,
  encodePrompt,
  encodeReasoningEffort,
  encodeSessionIdentity,
  encodeSystemMessage,
  encodeToolSelection,
} from './CopilotRequestEncoder';
import { buildCopilotUsageInfo } from './CopilotUsageBuilder';

class ExecutionEventQueue implements AsyncIterable<ProviderExecutionEvent> {
  private closed = false;
  private readonly items: ProviderExecutionEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<ProviderExecutionEvent>) => void> = [];

  constructor(private readonly onReturn: () => void) {}

  push(event: ProviderExecutionEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.items.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ProviderExecutionEvent> {
    return {
      next: async () => {
        const item = this.items.shift();
        if (item) return { done: false, value: item };
        if (this.closed) return { done: true, value: undefined };
        return new Promise(resolve => this.waiters.push(resolve));
      },
      return: async () => {
        this.onReturn();
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

class CopilotExecutionRunState implements ProviderExecutionRun {
  readonly events: AsyncIterable<ProviderExecutionEvent>;
  private readonly queue: ExecutionEventQueue;
  private terminal = false;

  constructor(
    readonly executionId: string,
    readonly turnId: string,
    private readonly cancelCallback: () => void,
  ) {
    this.queue = new ExecutionEventQueue(cancelCallback);
    this.events = this.queue;
  }

  cancel(): void {
    this.cancelCallback();
  }

  emit(event: ProviderExecutionEvent): void {
    if (!this.terminal) this.queue.push(event);
  }

  finish(event: ProviderExecutionEvent): void {
    if (this.terminal) return;
    this.terminal = true;
    this.queue.push(event);
    this.queue.close();
  }

  get isTerminal(): boolean {
    return this.terminal;
  }
}

interface ActiveExecution {
  readonly abortController: AbortController;
  /** The cancellation in progress, so a later caller joins it rather than starting one. */
  cancellation: Promise<void> | null;
  cancelled: boolean;
  readonly normalizer: CopilotEventNormalizer;
  readonly request: ProviderExecutionRequest;
  /** What the turn's selected resources could not resolve to, reported on the turn. */
  resourceProblems: readonly string[];
  readonly run: CopilotExecutionRunState;
  sequence: number;
  /** Whether this turn's session loaded skills, and so can answer a slash command. */
  skillsEnabled: boolean;
}

type CopilotSessionInvalidation = Extract<
  ProviderSessionSnapshot,
  { status: 'invalidated' }
>['invalidation'];

interface LiveSdkSession {
  readonly identity: string;
  readonly session: CopilotSdkSession;
  /**
   * Identity of this live session. Events, approvals, and questions all carry it, so a
   * session Claudian dropped can never reach the run that replaced it.
   */
  readonly token: object;
}

/** Deletion attempts an ephemeral session id gets before its failure is reported. */
const EPHEMERAL_DELETION_ATTEMPTS = 3;

/**
 * What a turn does with the message it was given: send a prompt, or report what the
 * runtime already answered with and run no turn.
 */
type CopilotTurnSubmission =
  | { readonly kind: 'send'; readonly notice?: string; readonly prompt: string }
  | { readonly kind: 'answered'; readonly notice: string };

export interface CopilotExecutionSessionOptions {
  readonly clientFactory: CopilotClientFactory;
}

export class CopilotExecutionSession implements ProviderExecutionSession {
  readonly providerId = 'copilot' as const;
  readonly sessionInstanceId = randomUUID();

  private active: ActiveExecution | null = null;
  /** Every native acquisition still running, so disposal can wait for all of them. */
  private readonly acquisitionFlights = new Set<Promise<void>>();
  private client: CopilotSdkClient | null = null;
  private clientIdentity: CopilotClientIdentity | null = null;
  /** The resources the live client was started under, which only a fresh one can change. */
  private clientResourceDigest: string | null = null;
  private disposalFlight: Promise<void> | null = null;
  private disposed = false;
  private readonly interactionHandler: CopilotInteractionHandler;
  /** The cancellation or failure recovery in progress, so disposal joins it. */
  private lifecycleFlight: Promise<void> | null = null;
  private readonly listeners = new Set<(event: ProviderSessionEvent) => void>();
  private live: LiveSdkSession | null = null;
  private providerSessionId: string | undefined;
  /** Clients this session has already shut down, so none is stopped twice. */
  private readonly stoppedClients = new WeakSet<CopilotSdkClient>();
  /** Session ids Claudian created for an ephemeral run and must delete on disposal. */
  private readonly ephemeralSessionIds = new Set<string>();
  /** Ephemeral ids whose deletion failed and is retried through the next client. */
  private readonly pendingEphemeralDeletions = new Set<string>();
  private readonly ephemeralDeletionAttempts = new Map<string, number>();
  /** Why a pending deletion is still pending, reported if no client is left to retry it. */
  private readonly ephemeralDeletionFailures = new Map<string, CopilotRuntimeError>();
  private readonly cleanupFailures: CopilotRuntimeError[] = [];
  /** True once disposal has run its last cleanup, so nothing is waiting to report one. */
  private finalTeardownCompleted = false;
  /** Cleanup that failed after that, which every disposal from then on reports. */
  private readonly terminalCleanupFailures: CopilotRuntimeError[] = [];
  private revision = 0;
  private snapshot: ProviderSessionSnapshot;

  constructor(
    private readonly host: ProviderHost,
    private readonly config: ProviderSessionConfig,
    private readonly options: CopilotExecutionSessionOptions,
  ) {
    this.providerSessionId = config.resumeSeed?.providerSessionId;
    this.snapshot = this.createSnapshot('idle');
    this.interactionHandler = new CopilotInteractionHandler({
      getActiveTurn: sessionToken => (
        this.live?.token === sessionToken && this.active && !this.active.run.isTerminal
          ? { signal: this.active.abortController.signal, turnId: this.active.run.turnId }
          : null
      ),
      getToolPolicy: () => this.active?.request.toolPolicy ?? null,
      interactionPort: config.interactionPort,
      sessionInstanceId: this.sessionInstanceId,
    });
  }

  execute(incomingRequest: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) throw new Error('Copilot execution session is disposed.');
    if (this.active) throw new Error('Copilot execution session is already executing.');

    const request = this.resolveRequestModel(incomingRequest);
    const run = new CopilotExecutionRunState(
      randomUUID(),
      randomUUID(),
      () => { void this.cancelRun(run); },
    );
    const active: ActiveExecution = {
      abortController: new AbortController(),
      cancellation: null,
      cancelled: false,
      normalizer: new CopilotEventNormalizer({
        buildUsage: data => buildCopilotUsageInfo(data, {
          customContextLimits: readCustomContextLimits(this.host.settings),
          discoveredModels: getCopilotProviderSettings(this.host.settings).discoveredModels,
          selectedModelId: request.configuration.model ?? '',
        }),
        nextScope: () => this.nextScope(active),
      }),
      request,
      resourceProblems: [],
      run,
      sequence: 0,
      skillsEnabled: false,
    };
    this.active = active;
    this.updateSnapshot('executing');

    const onAbort = (): void => { void this.cancelRun(run); };
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) {
      request.signal.removeEventListener('abort', onAbort);
      onAbort();
    } else {
      void this.performExecution(active).finally(() => {
        request.signal.removeEventListener('abort', onAbort);
      });
    }
    return run;
  }

  cancel(): void {
    const run = this.active?.run;
    if (run) void this.cancelRun(run);
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.snapshot;
  }

  getStatus(): ProviderSessionStatus {
    return this.snapshot.status;
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): Promise<void> {
    if (this.disposalFlight) return this.reportDisposal(this.disposalFlight);
    this.disposed = true;
    this.disposalFlight = (async () => {
      await this.settleLifecycleFlights();
      const active = this.active;
      if (active) await this.cancelRun(active.run);
      await this.releaseNative();
      this.listeners.clear();
      this.updateSnapshot('disposed');
      this.throwCleanupFailures();
    })();
    return this.reportDisposal(this.disposalFlight);
  }

  /**
   * Reports a disposal along with anything the runtime failed to release after it.
   *
   * A late answer that arrives once disposal has reported has no caller of its own: the
   * run it belonged to ended, and no further client will retry what it could not clean
   * up. Holding it on the session is the only way it stays reportable, so it replaces the
   * failure this disposal already delivered — every earlier caller was given that one.
   */
  private reportDisposal(flight: Promise<void>): Promise<void> {
    const failure = cleanupFailureError(this.terminalCleanupFailures);
    if (!failure) {
      return flight;
    }
    const report = (): never => {
      throw failure;
    };
    return flight.then(report, report);
  }

  private async performExecution(active: ActiveExecution): Promise<void> {
    try {
      const prompt = encodePrompt(active.request);
      const session = await this.acquireSdkSession(active);
      if (active.cancelled) {
        return;
      }

      active.run.emit(this.event(active, { accepted: true, type: 'turn_started' }));
      if (prompt) {
        active.run.emit(this.event(active, { content: prompt, type: 'user_message_started' }));
      }
      const unsupportedInput = describeUnsupportedInput(active.request);
      if (unsupportedInput) {
        active.run.emit(this.event(active, {
          level: 'warning',
          message: unsupportedInput,
          type: 'notice',
        }));
      }
      for (const problem of [...active.resourceProblems, ...session.resourceDiagnostics]) {
        active.run.emit(this.event(active, {
          level: 'warning',
          message: problem,
          type: 'notice',
        }));
      }

      const submission = await this.resolveSubmission(active, session, prompt);
      if (active.cancelled) {
        return;
      }
      if (submission.notice) {
        active.run.emit(this.event(active, {
          level: 'info',
          message: submission.notice,
          type: 'notice',
        }));
      }
      if (submission.kind === 'send') {
        await session.send(submission.prompt);
      }
      if (active.cancelled) {
        return;
      }
      active.run.finish(this.event(active, { reason: 'completed', type: 'turn_completed' }));
    } catch (error) {
      if (active.cancelled) {
        return;
      }
      await this.trackLifecycleFlight(
        this.recoverFromFailure(active, toCopilotRuntimeError(error)),
      );
    } finally {
      if (this.active === active) {
        this.active = null;
        this.settleToIdle();
      }
    }
  }

  /**
   * Drops the native state a failure made unusable, then ends the run with the failure
   * that caused it.
   *
   * Both steps are one flight because they belong to the same run: a disposal that joined
   * only the release would still clear the listeners before the run reported anything.
   */
  private async recoverFromFailure(
    active: ActiveExecution,
    error: CopilotRuntimeError,
  ): Promise<void> {
    await this.recordCleanup(
      'resetting the runtime after a failed turn',
      () => this.resetNativeAfterFailure(error),
    );
    this.failRun(active, error);
  }

  /**
   * Publishes the in-flight native acquisition so disposal can wait for it instead of
   * tearing down beside it, which would leave the late client or session unowned. Each
   * run tracks its own acquisition: a cancelled turn settling must not retract the
   * acquisition the turn that replaced it is still waiting on.
   */
  private acquireSdkSession(active: ActiveExecution): Promise<CopilotSdkSession> {
    // A stale SDK handle disconnects by native session ID, which a retry may reuse.
    const previousAcquisitions = Promise.all([...this.acquisitionFlights]);
    return this.trackAcquisition(previousAcquisitions.then(() => {
      this.assertRunOwnsNative(active);
      return this.ensureSdkSession(active);
    }));
  }

  /**
   * Publishes work disposal must drain before it tears down. Both a turn's acquisition
   * and the release of a resource that arrived after its budget go through here: the
   * release starts when the CLI finally answers, which may be while disposal is draining,
   * and joining the flights makes it part of that drain rather than a step running beside
   * it. Every published step is itself bounded, so draining them still terminates.
   */
  private trackAcquisition<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(() => undefined, () => undefined);
    this.acquisitionFlights.add(settled);
    void settled.finally(() => {
      this.acquisitionFlights.delete(settled);
    });
    return work;
  }

  /**
   * Returns the session to idle after a turn. An invalidated session keeps that status:
   * it needs a new session reference before it can accept another turn.
   */
  private settleToIdle(): void {
    if (this.disposed || this.snapshot.status === 'invalidated') {
      return;
    }
    this.updateSnapshot('idle');
  }

  private resolveRequestModel(request: ProviderExecutionRequest): ProviderExecutionRequest {
    if (request.configuration.model?.trim()) {
      return request;
    }
    const [model] = getEnabledCopilotModels(getCopilotProviderSettings(this.host.settings));
    if (!model) {
      return request;
    }
    return {
      ...request,
      configuration: {
        ...request.configuration,
        model: encodeCopilotModelId(model.rawId),
      },
    };
  }

  /**
   * Returns a live SDK session for the request, recycling the current one only when the
   * client identity and the session's own bound inputs are unchanged. Model and reasoning
   * are applied per turn because the CLI accepts them after creation.
   *
   * Every await is fenced: if the session was disposed or the turn was cancelled while
   * the CLI was starting a process or a session, the late resource is released here
   * instead of being installed, so nothing outlives the run that asked for it.
   */
  private async ensureSdkSession(active: ActiveExecution): Promise<CopilotSdkSession> {
    const request = active.request;
    const model = decodeCopilotModelId(request.configuration.model ?? '');
    if (!model) {
      throw copilotConfigurationError(
        'Select an enabled Copilot model before starting a turn.',
      );
    }

    const identity = await this.options.clientFactory.resolveIdentity(
      this.config.vaultWorkingDirectory,
    );
    this.assertRunOwnsNative(active);

    const resources = await this.resolveTurnResources(active);
    this.assertRunOwnsNative(active);
    const resourceDigest = encodeCopilotResourceDigest(resources);

    /**
     * A selection that changed needs a CLI that has not started anything yet. The
     * exclusion list a session states only applies where the runtime is starting servers
     * — a create or a cold resume — so resuming on the process that is already running
     * the previous selection's servers would leave them running. Ending that process and
     * resuming the same native session on a fresh one is what makes the change take
     * effect, and the conversation keeps its native id.
     */
    if (
      !isSameCopilotClientIdentity(this.clientIdentity, identity)
      || (this.client !== null && this.clientResourceDigest !== resourceDigest)
    ) {
      await this.teardownNative({ final: false });
      this.assertRunOwnsNative(active);
      const started = await this.options.clientFactory.createClient(identity);
      if (this.isFenced(active)) {
        await this.stopClient(started, 'stopping a client no turn owns');
        this.assertRunOwnsNative(active);
      }
      this.client = started;
      this.clientIdentity = identity;
      this.clientResourceDigest = resourceDigest;
      await this.retryPendingEphemeralDeletions(started);
      this.assertRunOwnsNative(active);
    }
    const client = this.client;
    if (!client) {
      throw copilotConfigurationError('The Copilot client could not be started.');
    }

    const toolSelection = encodeToolSelection(request.toolPolicy);
    const additionalDirectories = encodeAdditionalDirectories(request);
    const systemMessage = encodeSystemMessage(request, {
      customPrompt: readString(this.host.settings.systemPrompt),
      mediaFolder: readString(this.host.settings.mediaFolder),
      userName: readString(this.host.settings.userName),
      vaultPath: this.config.vaultWorkingDirectory,
    });
    const identityKey = encodeSessionIdentity({
      additionalDirectories,
      ...(resources ? { resources } : {}),
      systemMessage,
      toolSelection,
      workingDirectory: this.config.vaultWorkingDirectory,
    });
    const reasoningEffort = encodeReasoningEffort(request, isCopilotReasoningEffort);

    if (this.live && this.live.identity === identityKey) {
      const live = this.live;
      await this.applyTurnModel(live, model, reasoningEffort);
      this.assertRunOwnsNative(active);
      return live.session;
    }

    await this.disconnectLiveSession('disconnecting the session this turn replaces');
    this.assertRunOwnsNative(active);
    const liveToken = {};
    const interactions = this.interactionHandler.bind(liveToken);
    const sessionConfig: CopilotSdkSessionConfig = {
      ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
      ...(toolSelection.excludedTools ? { excludedTools: toolSelection.excludedTools } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      availableTools: toolSelection.availableTools,
      model,
      onEvent: (event) => {
        this.handleSdkEvent(liveToken, event);
      },
      onPermissionRequest: interactions.handlePermissionRequest,
      onUserInputRequest: interactions.handleUserInputRequest,
      ...(resources ? { resources } : {}),
      systemMessage,
      workingDirectory: this.config.vaultWorkingDirectory,
    };

    /**
     * The SDK boundary bounds the create or resume and ends the CLI that went silent on
     * one, so nothing is wrapped around it here: a second deadline would be waiting on a
     * process this layer was never handed and could not stop. A session that arrives for
     * a run that can no longer own it is still released, because the run may have been
     * cancelled or the session disposed while the CLI was answering.
     */
    const resumedSessionId = this.providerSessionId;
    const session = resumedSessionId
      ? await client.resumeSession(resumedSessionId, sessionConfig)
      : await client.createSession(sessionConfig);

    const isNewNativeSession = session.sessionId !== resumedSessionId;
    if (isNewNativeSession && this.shouldDeleteNativeSession()) {
      this.ephemeralSessionIds.add(session.sessionId);
    }
    if (this.isFenced(active)) {
      await this.releaseUnownedSession(client, session);
      this.assertRunOwnsNative(active);
    }

    this.providerSessionId = session.sessionId;
    this.live = { identity: identityKey, session, token: liveToken };
    this.updateSnapshot('executing');
    return session;
  }

  /**
   * Turns a message into what is actually sent.
   *
   * A skill command is invoked through the runtime rather than sent as text: the runtime
   * answers with a prompt to submit, and text that merely starts with a slash is not an
   * invocation. A message that names no selected skill command stays exactly as the user
   * wrote it.
   */
  private async resolveSubmission(
    active: ActiveExecution,
    session: CopilotSdkSession,
    prompt: string,
  ): Promise<CopilotTurnSubmission> {
    const candidate = active.skillsEnabled ? decodeSkillCommandInput(prompt) : null;
    if (!candidate) {
      return { kind: 'send', prompt };
    }
    const commands = await session.listSkillCommands();
    const match = commands.find(command => (
      command.name.toLowerCase() === candidate.name.toLowerCase()
    ));
    if (!match) {
      return { kind: 'send', prompt };
    }
    const invocation = await session.invokeSkillCommand(match.name, candidate.input);
    if (invocation.kind === 'text') {
      return { kind: 'answered', notice: invocation.text };
    }
    return {
      kind: 'send',
      ...(invocation.notice ? { notice: invocation.notice } : {}),
      prompt: invocation.prompt,
    };
  }

  /**
   * Reads the definitions behind this computer's selection, for the turns that may use
   * them.
   *
   * The read happens per turn rather than once per session, because the files it reads
   * are the user's own and change outside Claudian, and because nothing about them is
   * persisted: a definition lives only as long as the session it is handed to. What no
   * longer resolves is carried on the turn and reported there.
   */
  private async resolveTurnResources(
    active: ActiveExecution,
  ): Promise<CopilotSdkSessionResources | null> {
    if (!allowsCopilotResources(this.config.lifecycle, active.request.toolPolicy)) {
      return null;
    }
    const resolution = await resolveCopilotSelectedResources(
      getCopilotHostResources(this.host.settings),
    );
    active.resourceProblems = resolution.problems;
    active.skillsEnabled = (resolution.resources?.skillDirectories.length ?? 0) > 0;
    if (!resolution.resources) {
      return null;
    }
    return {
      mcpServers: resolution.resources.mcpServers,
      skillDirectories: resolution.resources.skillDirectories,
    };
  }

  /**
   * Applies the per-turn model to a session being reused, under the shared release budget.
   *
   * A model change the runtime never acknowledged says nothing about what the next prompt
   * would run as, exactly as an unacknowledged abort says nothing about the turn it was
   * meant to stop. The session is dropped rather than reused, so the next turn creates or
   * resumes one instead of sending into a session whose model is unknown.
   */
  private async applyTurnModel(
    live: LiveSdkSession,
    model: string,
    reasoningEffort: CopilotReasoningEffort | undefined,
  ): Promise<void> {
    const outcome = await settleNativeWithin(live.session.setModel(model, reasoningEffort));
    if (outcome.kind === 'settled') {
      return;
    }
    if (outcome.kind === 'rejected') {
      throw outcome.error;
    }
    await this.dropUnacknowledgedSession(
      live,
      'disconnecting a session that never acknowledged the model change',
    );
    throw copilotNativeSilenceError('applying the model to the live session');
  }

  /**
   * True once the run that asked for a native resource can no longer own it, because the
   * session was disposed, the turn was cancelled, or another run took over.
   */
  private isFenced(active: ActiveExecution): boolean {
    return this.disposed || this.active !== active || active.cancelled;
  }

  private assertRunOwnsNative(active: ActiveExecution): void {
    if (this.isFenced(active)) {
      throw new CopilotRuntimeError(
        'provider',
        'The Copilot turn was released before its runtime was ready.',
      );
    }
  }

  /**
   * Releases a native session the run may no longer install. Each step is attempted and
   * accounted for on its own: a session that refuses to disconnect still has the ephemeral
   * data Claudian created deleted, and the client that created it is still stopped.
   */
  private async releaseUnownedSession(
    client: CopilotSdkClient,
    session: CopilotSdkSession,
  ): Promise<void> {
    await this.releaseNativeSession(session, 'disconnecting a session no turn owns');
    if (this.ephemeralSessionIds.delete(session.sessionId)) {
      await this.deleteEphemeralSessions(client, [session.sessionId], false);
    }
    if (this.client !== client) {
      await this.stopClient(client, 'stopping a client no turn owns');
    }
  }

  /**
   * Shuts one client down, once.
   *
   * A client is reached from teardown, from the release of a session no turn owns, and
   * from the abandonment of an acquisition that went silent, and a late session can
   * arrive on one this session has already stopped. A second shutdown would bill another
   * bounded wait to whoever is draining and report a second failure about a runtime the
   * caller was already told about.
   */
  private async stopClient(client: CopilotSdkClient, context: string): Promise<void> {
    if (this.stoppedClients.has(client)) {
      return;
    }
    this.stoppedClients.add(client);
    await this.recordCleanup(context, () => client.stop());
  }

  private handleSdkEvent(
    liveToken: object,
    event: Parameters<CopilotEventNormalizer['normalize']>[0],
  ): void {
    const active = this.active;
    if (!active || active.run.isTerminal || active.cancelled) {
      return;
    }
    if (this.live?.token !== liveToken) {
      return;
    }
    for (const normalized of active.normalizer.normalize(event)) {
      active.run.emit(normalized);
    }
  }

  /**
   * Cancels one run, once.
   *
   * The native abort runs before the run ends, so the caller that started the
   * cancellation is not the only one that has to wait for it. A second caller, and
   * disposal, join the flight already in progress rather than aborting a turn that is
   * already being stopped and ending its run a second time.
   */
  private cancelRun(run: CopilotExecutionRunState): Promise<void> {
    const active = this.active;
    if (!active || active.run !== run) {
      return Promise.resolve();
    }
    if (active.cancelled) {
      return active.cancellation ?? Promise.resolve();
    }
    active.cancelled = true;
    active.abortController.abort();
    active.cancellation = this.trackLifecycleFlight(
      this.finishCancellation(active, run),
    );
    return active.cancellation;
  }

  private async finishCancellation(
    active: ActiveExecution,
    run: CopilotExecutionRunState,
  ): Promise<void> {
    await this.abortNativeTurn();
    run.finish(this.event(active, { reason: 'cancelled', type: 'cancelled' }));
    if (this.active === active) {
      this.active = null;
      this.settleToIdle();
    }
  }

  /**
   * Publishes the release-then-end work a cancellation or a failure recovery performs.
   *
   * Both release native state before ending the run they belong to, and both can still be
   * running when disposal arrives. Disposal joins the published flight so the run ends
   * while its listeners are still attached, and whatever the release could not do is
   * reported by the disposal the caller is already waiting on. The flight reports its own
   * failures through `recordCleanupFailure`, so what is published is the settled outcome:
   * joining it must not re-report a failure or replace the disposal's own report.
   */
  private trackLifecycleFlight(work: Promise<void>): Promise<void> {
    const settled = work.then(() => undefined, () => undefined);
    this.lifecycleFlight = settled;
    void settled.finally(() => {
      if (this.lifecycleFlight === settled) {
        this.lifecycleFlight = null;
      }
    });
    return settled;
  }

  /**
   * Drains the cancellation or failure recovery still running before disposal tears down.
   *
   * Only disposal waits here. A flight reaches teardown itself — a failure recovery drops
   * the client the failure made unusable — so making teardown wait for the flight that is
   * calling it would wedge the two against each other. This terminates because a disposed
   * session refuses further turns, and each run publishes at most one flight.
   */
  private async settleLifecycleFlights(): Promise<void> {
    while (this.lifecycleFlight) {
      await this.lifecycleFlight;
    }
  }

  /**
   * Stops the native turn without letting a runtime that stopped answering hold
   * cancellation or failure recovery open.
   *
   * An abort the runtime never acknowledged says nothing about the turn it was supposed to
   * stop, so the session is dropped instead of reused: the next turn creates or resumes one
   * rather than sending into a session that may still be running.
   */
  private async abortNativeTurn(): Promise<void> {
    const live = this.live;
    if (!live) {
      return;
    }
    const outcome = await settleNativeWithin(live.session.abort());
    if (outcome.kind === 'settled') {
      return;
    }
    await this.dropUnacknowledgedSession(
      live,
      'disconnecting a session that never acknowledged the abort',
    );
  }

  private async dropUnacknowledgedSession(
    live: LiveSdkSession,
    context: string,
  ): Promise<void> {
    if (this.live !== live) {
      return;
    }
    this.live = null;
    await this.releaseNativeSession(live.session, context);
  }

  /**
   * Drops the native state a failure made unusable, so the next turn creates or resumes a
   * session instead of sending into a runtime that already failed.
   */
  private async resetNativeAfterFailure(error: CopilotRuntimeError): Promise<void> {
    const reset = error.nativeReset;
    if (reset === 'none') {
      return;
    }
    await this.abortNativeTurn();
    if (reset === 'client') {
      await this.teardownNative({ final: false });
      return;
    }
    await this.disconnectLiveSession('disconnecting the session the failure left unusable');
  }

  private failRun(active: ActiveExecution, error: CopilotRuntimeError): void {
    if (error.category === 'provider-session-missing') {
      this.providerSessionId = undefined;
      this.invalidate({
        message: error.message,
        reason: 'provider-session-missing',
        recoverable: true,
      });
    }
    active.run.finish(this.event(active, {
      category: error.category,
      message: error.message,
      ...(error.missingProviderSessionId
        ? { missingProviderSessionId: error.missingProviderSessionId }
        : {}),
      recoverable: error.recoverable,
      type: 'execution_error',
    }));
  }

  /** Ephemeral sessions leave no native trace behind once the lease ends. */
  private shouldDeleteNativeSession(): boolean {
    return this.config.lifecycle === 'ephemeral'
      && this.config.nativePersistence !== 'enabled';
  }

  private async disconnectLiveSession(context: string): Promise<void> {
    const live = this.live;
    this.live = null;
    if (live) await this.releaseNativeSession(live.session, context);
  }

  /**
   * Waits for an in-flight native acquisition before tearing down, so a client or session
   * the CLI is still starting is owned by this session when it arrives rather than
   * escaping teardown.
   */
  private async releaseNative(): Promise<void> {
    await this.settleAcquisitions();
    await this.teardownNative({ final: true });
    this.finalTeardownCompleted = true;
  }

  /**
   * Drains every acquisition still running. This terminates rather than races: a disposed
   * session refuses new turns, so no acquisition can start once disposal has begun.
   */
  private async settleAcquisitions(): Promise<void> {
    while (this.acquisitionFlights.size > 0) {
      await Promise.all([...this.acquisitionFlights]);
    }
  }

  private async teardownNative(options: { readonly final: boolean }): Promise<void> {
    const live = this.live;
    const client = this.client;
    const ephemeralSessionIds = [...this.ephemeralSessionIds, ...this.pendingEphemeralDeletions];
    this.live = null;
    this.client = null;
    this.clientIdentity = null;
    this.clientResourceDigest = null;
    this.ephemeralSessionIds.clear();
    this.pendingEphemeralDeletions.clear();

    if (live) {
      await this.releaseNativeSession(live.session, 'disconnecting the native session');
    }
    if (!client) {
      this.carryEphemeralDeletions(ephemeralSessionIds, options.final);
      return;
    }
    await this.deleteEphemeralSessions(client, ephemeralSessionIds, options.final);
    await this.stopClient(client, 'stopping the Copilot CLI');
  }

  /**
   * Holds an ephemeral id for the next client. There is no next client once the session
   * is disposed, so the lease Claudian promised to clean up is reported rather than
   * dropped: the reason is the deletion failure that put it here, or the missing client
   * itself.
   */
  private carryEphemeralDeletions(sessionIds: readonly string[], final: boolean): void {
    for (const sessionId of sessionIds) {
      if (!this.isLastDeletionChance(final)) {
        this.pendingEphemeralDeletions.add(sessionId);
        continue;
      }
      const failure = this.ephemeralDeletionFailures.get(sessionId);
      this.forgetEphemeralDeletion(sessionId);
      this.recordCleanupFailure(failure ?? new CopilotRuntimeError(
        'provider',
        `deleting the ephemeral session ${sessionId}: `
        + 'the Copilot CLI was no longer running.',
      ));
    }
  }

  /**
   * True when nothing can retry a deletion that fails now, so it has to be reported.
   *
   * A disposed session accepts no further turn and therefore starts no further client,
   * which makes every deletion after disposal a last chance even when it belongs to a
   * resource that arrived long after teardown. Queueing one then would file the lease for
   * a retry that can never run.
   */
  private isLastDeletionChance(final: boolean): boolean {
    return final || this.disposed;
  }

  private async retryPendingEphemeralDeletions(client: CopilotSdkClient): Promise<void> {
    if (this.pendingEphemeralDeletions.size === 0) {
      return;
    }
    const pending = [...this.pendingEphemeralDeletions];
    this.pendingEphemeralDeletions.clear();
    await this.deleteEphemeralSessions(client, pending, false);
  }

  /**
   * Deletes ephemeral sessions, keeping a failed id for a bounded retry through the next
   * client rather than dropping the lease Claudian promised to clean up. Once no next
   * client can exist — the final teardown, or anything after disposal — the failure is
   * reported instead.
   *
   * Every id is attempted and accounted for on its own, and each attempt is bounded, so a
   * CLI that stops answering one deletion cannot hold teardown short of the shutdown that
   * follows it.
   */
  private async deleteEphemeralSessions(
    client: CopilotSdkClient,
    sessionIds: readonly string[],
    final: boolean,
  ): Promise<void> {
    for (const sessionId of sessionIds) {
      const attempts = (this.ephemeralDeletionAttempts.get(sessionId) ?? 0) + 1;
      const failure = await this.deleteEphemeralSession(client, sessionId);
      if (!failure) {
        this.forgetEphemeralDeletion(sessionId);
        continue;
      }
      if (!this.isLastDeletionChance(final) && attempts < EPHEMERAL_DELETION_ATTEMPTS) {
        this.ephemeralDeletionAttempts.set(sessionId, attempts);
        this.pendingEphemeralDeletions.add(sessionId);
        this.ephemeralDeletionFailures.set(sessionId, failure);
        continue;
      }
      this.forgetEphemeralDeletion(sessionId);
      this.recordCleanupFailure(failure);
    }
  }

  /**
   * Deletes one ephemeral session under the shared release budget and returns what stopped
   * it, or null when the data is gone. Silence means the same thing a refusal does: the
   * lease is still there, which the caller carries or reports rather than assuming it was
   * cleaned up because nobody said otherwise.
   */
  private async deleteEphemeralSession(
    client: CopilotSdkClient,
    sessionId: string,
  ): Promise<CopilotRuntimeError | null> {
    const context = `deleting the ephemeral session ${sessionId}`;
    const outcome = await acquireNativeWithin(client.deleteSession(sessionId));
    switch (outcome.kind) {
      case 'settled':
        return null;
      case 'rejected':
        return describeCleanupFailure(context, outcome.error, 'provider');
      case 'timed-out':
        return copilotNativeSilenceError(context);
    }
  }

  private forgetEphemeralDeletion(sessionId: string): void {
    this.ephemeralDeletionAttempts.delete(sessionId);
    this.ephemeralDeletionFailures.delete(sessionId);
  }

  /**
   * Releases one native session under the shared release budget.
   *
   * Every disconnect goes through here, so a CLI that stopped answering can never hold a
   * cancellation, a failure recovery, or disposal open at whichever release it happens to
   * be wedged on. Silence is a cleanup failure like a refusal is: the session Claudian
   * promised to release may still be running, which the user is told rather than not.
   */
  private async releaseNativeSession(
    session: CopilotSdkSession,
    context: string,
  ): Promise<void> {
    const outcome = await settleNativeWithin(session.disconnect());
    if (outcome.kind === 'settled') {
      return;
    }
    this.recordCleanupFailure(outcome.kind === 'rejected'
      ? describeCleanupFailure(context, outcome.error, 'transport')
      : copilotNativeSilenceError(context));
  }

  /**
   * Runs one cleanup step and keeps what it could not do, named by the step that failed,
   * so disposal can report it instead of the failure disappearing into a catch.
   */
  private async recordCleanup(context: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.recordCleanupFailure(describeCleanupFailure(context, error, 'transport'));
    }
  }

  /**
   * Keeps a cleanup failure for whoever will report it.
   *
   * Disposal reports what it could not release, so a failure raised before it has
   * finished belongs to that report. One raised afterwards — by a resource the CLI handed
   * back long after its budget — has no disposal left to join, and the session is the only
   * place it stays reportable from.
   */
  private recordCleanupFailure(failure: CopilotRuntimeError): void {
    if (this.finalTeardownCompleted) {
      this.terminalCleanupFailures.push(failure);
      return;
    }
    this.cleanupFailures.push(failure);
  }

  /**
   * Reports what disposal could not clean up. Every step still runs first, so one failure
   * never leaves the rest of the native state behind.
   */
  private throwCleanupFailures(): void {
    const failures = [...this.cleanupFailures];
    this.cleanupFailures.length = 0;
    const failure = cleanupFailureError(failures);
    if (failure) {
      throw failure;
    }
  }

  private nextScope(active: ActiveExecution): ProviderRequestedEventScope {
    return {
      executionId: active.run.executionId,
      kind: 'requested',
      sequence: ++active.sequence,
      sessionInstanceId: this.sessionInstanceId,
      turnId: active.run.turnId,
    };
  }

  private event(
    active: ActiveExecution,
    event: CopilotExecutionEventDraft,
  ): ProviderExecutionEvent {
    return { ...event, scope: this.nextScope(active) };
  }

  private updateSnapshot(status: Exclude<ProviderSessionStatus, 'invalidated'>): void {
    if (this.snapshot.status === 'disposed' && status !== 'disposed') {
      return;
    }
    this.snapshot = { ...this.snapshotBase(), status };
    this.publishSnapshot();
  }

  private invalidate(invalidation: CopilotSessionInvalidation): void {
    if (this.snapshot.status === 'disposed') {
      return;
    }
    this.snapshot = { ...this.snapshotBase(), invalidation, status: 'invalidated' };
    this.publishSnapshot();
  }

  private createSnapshot(
    status: Exclude<ProviderSessionStatus, 'invalidated'>,
  ): ProviderSessionSnapshot {
    return { ...this.snapshotBase(), status };
  }

  private snapshotBase(): {
    providerId: 'copilot';
    providerSessionId?: string;
    revision: number;
  } {
    return {
      ...(this.providerSessionId ? { providerSessionId: this.providerSessionId } : {}),
      providerId: this.providerId,
      revision: this.revision++,
    };
  }

  private publishSnapshot(): void {
    const active = this.active;
    if (active && !active.run.isTerminal) {
      active.run.emit(this.event(active, {
        snapshot: this.snapshot,
        type: 'session_state_changed',
      }));
      return;
    }

    const event: ProviderSessionEvent = {
      scope: {
        kind: 'session',
        sequence: this.snapshot.revision,
        sessionInstanceId: this.sessionInstanceId,
      },
      snapshot: this.snapshot,
      type: 'session_state_changed',
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Session listeners cannot interfere with the native Copilot lifecycle.
      }
    }
  }
}

/** Names the cleanup step a failure came from, keeping the runtime's own message. */
function describeCleanupFailure(
  context: string,
  error: unknown,
  fallbackCategory: 'provider' | 'transport',
): CopilotRuntimeError {
  const failure = toCopilotRuntimeError(error, fallbackCategory);
  return new CopilotRuntimeError(
    failure.category,
    `${context}: ${failure.message}`,
    { cause: failure },
  );
}

/** One report for everything a release could not do, or null when it did all of it. */
function cleanupFailureError(
  failures: readonly CopilotRuntimeError[],
): CopilotRuntimeError | null {
  if (failures.length === 0) {
    return null;
  }
  return new CopilotRuntimeError(
    failures[0].category,
    `Copilot could not release its runtime: ${
      failures.map(failure => failure.message).join('; ')
    }`,
    { cause: failures.length === 1 ? failures[0] : new AggregateError([...failures]) },
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readCustomContextLimits(
  settings: Record<string, unknown>,
): Record<string, number> {
  const limits = settings.customContextLimits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    return {};
  }
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(limits as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      normalized[key] = value;
    }
  }
  return normalized;
}
