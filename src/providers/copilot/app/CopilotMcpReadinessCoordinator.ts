import { createHash } from 'node:crypto';

import { type EventRef, Notice } from 'obsidian';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { getVaultPath } from '@/utils/path';

import { computeCopilotEnvironmentHash } from '../env/CopilotSettingsReconciler';
import { getCopilotHostResources } from '../resources/CopilotHostResources';
import { resolveCopilotSelectedResources } from '../resources/CopilotResourceResolver';
import type { CopilotMcpServerReference } from '../resources/CopilotResourceSettings';
import { CopilotClientFactory, type CopilotClientIdentity, isSameCopilotClientIdentity } from '../sdk/CopilotClientFactory';
import { copilotNativeSilenceError, settleNativeWithin } from '../sdk/CopilotNativeBudget';
import { describeError } from '../sdk/CopilotRuntimeError';
import type {
  CopilotMcpReadiness,
  CopilotSdkRuntime,
  CopilotSdkSession,
} from '../sdk/CopilotSdkPort';
import { getCopilotProviderSettings, getEnabledCopilotModels } from '../settings';

export type CopilotMcpReadinessState = CopilotMcpReadiness
  | { readonly phase: 'unchecked' | 'queued' | 'checking' };

const MAX_CONCURRENT_CHECKS = 3;
const BACKGROUND_CHECK_INTERVAL_MS = 15 * 60_000;

/** A bounded queue, with an isolated native lease for each selected server. */
export class CopilotMcpReadinessCoordinator {
  private readonly factory: CopilotClientFactory;
  private readonly states = new Map<string, {
    stamp: string;
    generation?: number;
    state: CopilotMcpReadinessState;
    supportsSignIn: boolean;
  }>();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, CopilotMcpServerReference>();
  private readonly notifiedAuth = new Set<string>();
  private readonly observedWindows = new Map<Window, () => void>();
  private readonly windowEvents: EventRef[] = [];
  private readonly unregister: () => void;
  private controller: AbortController | null = null;
  private flight: Promise<void> | null = null;
  private queueChanged: (() => void) | null = null;
  private cancellationGeneration = 0;
  private disposed = false;
  private transitioning = false;
  private quiescedForTransition = false;
  private started = false;
  private lastCheckedAt = -Infinity;

  constructor(private readonly host: ProviderHost, options: { runtime?: CopilotSdkRuntime } = {}) {
    this.factory = new CopilotClientFactory(host, options);
    this.unregister = host.executionLifecycleRegistry.registerTransitionHook('copilot', {
      beforeTransition: async () => {
        this.transitioning = true;
        await this.quiesce();
        this.quiescedForTransition = true;
      },
      afterTransition: ({ generation }) => {
        const stamp = this.stamp();
        for (const [id, entry] of this.states) {
          if (entry.stamp !== stamp || (entry.generation !== undefined && entry.generation !== generation)) {
            this.states.delete(id);
            this.pending.delete(id);
          }
        }
        this.transitioning = false;
        const resumeChecks = this.quiescedForTransition;
        this.quiescedForTransition = false;
        this.notify();
        if (resumeChecks) this.checkInBackground();
      },
    });
  }

  getState(reference: CopilotMcpServerReference): CopilotMcpReadinessState {
    const entry = this.states.get(referenceId(reference));
    return this.selected(reference) && entry?.stamp === this.stamp()
      && (entry.generation === undefined
        || entry.generation === this.host.executionLifecycleRegistry.getProviderGeneration('copilot'))
      ? entry.state : { phase: 'unchecked' };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const { workspace } = this.host.app;
    this.observeWindow(window);
    workspace.iterateAllLeaves(leaf => {
      const win = leaf.view.containerEl.ownerDocument.defaultView;
      if (win) this.observeWindow(win);
    });
    this.windowEvents.push(
      workspace.on('window-open', (_container, win) => this.observeWindow(win)),
      workspace.on('window-close', (_container, win) => this.forgetWindow(win)),
    );
    this.checkInBackground();
  }

  private observeWindow(win: Window): void {
    if (this.observedWindows.has(win)) return;
    const doc = win.document;
    const onResume = (): void => {
      if (doc.visibilityState !== 'visible' || this.flight
        || Date.now() - this.lastCheckedAt < BACKGROUND_CHECK_INTERVAL_MS) return;
      this.checkInBackground(true);
    };
    win.addEventListener('focus', onResume);
    doc.addEventListener('visibilitychange', onResume);
    this.observedWindows.set(win, () => {
      win.removeEventListener('focus', onResume);
      doc.removeEventListener('visibilitychange', onResume);
    });
  }

  private forgetWindow(win: Window): void {
    this.observedWindows.get(win)?.();
    this.observedWindows.delete(win);
  }

  check(reference?: CopilotMcpServerReference): Promise<void> {
    return this.enqueue(reference, false);
  }

  ensureChecked(): Promise<void> {
    if (!getCopilotProviderSettings(this.host.settings).enabled) return Promise.resolve();
    return this.enqueue(undefined, true);
  }

  private enqueue(reference: CopilotMcpServerReference | undefined, onlyUnchecked: boolean): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('MCP readiness is disposed.'));
    if (this.transitioning) return Promise.resolve();
    if (this.controller?.signal.aborted) {
      const generation = this.cancellationGeneration;
      return this.flight!.then(() => {
        if (generation === this.cancellationGeneration) return this.enqueue(reference, onlyUnchecked);
      });
    }
    const references = reference ? [reference] : getCopilotHostResources(this.host.settings).selectedMcpServers;
    for (const candidate of references) {
      if (!this.selected(candidate)) continue;
      const phase = this.getState(candidate).phase;
      if (onlyUnchecked && phase !== 'unchecked') continue;
      if (phase === 'queued' || phase === 'checking') continue;
      this.pending.set(referenceId(candidate), candidate);
      this.publish(candidate, this.stamp(), { phase: 'queued' });
    }
    if (this.flight) {
      this.queueChanged?.();
      return this.flight;
    }
    if (this.pending.size === 0) return Promise.resolve();
    const controller = new AbortController();
    this.controller = controller;
    this.flight = Promise.resolve().then(async () => {
      const workers = new Set<Promise<void>>();
      const failures: unknown[] = [];
      try {
        while (workers.size > 0 || (this.pending.size > 0 && !controller.signal.aborted)) {
          while (this.pending.size > 0 && workers.size < MAX_CONCURRENT_CHECKS
            && !controller.signal.aborted) {
            const worker = this.drain(controller.signal)
              .catch(error => { failures.push(error); })
              .finally(() => { workers.delete(worker); });
            workers.add(worker);
          }
          if (workers.size === 0) break;
          await Promise.race([
            ...workers,
            new Promise<void>(resolve => { this.queueChanged = resolve; }),
          ]);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, failures.map(describeError).join('; '));
      } finally {
        this.queueChanged = null;
        this.flight = null;
        this.controller = null;
        if (!controller.signal.aborted) {
          this.lastCheckedAt = Date.now();
          this.notifyAuthenticationRequired();
        }
      }
    });
    return this.flight;
  }

  async cancel(): Promise<void> {
    this.states.clear();
    await this.quiesce();
  }

  private async quiesce(): Promise<void> {
    this.cancellationGeneration += 1;
    this.controller?.abort(new Error('MCP readiness check cancelled.'));
    this.pending.clear();
    for (const [id, { state }] of this.states) {
      if (state.phase === 'queued' || state.phase === 'checking') this.states.delete(id);
    }
    this.notify();
    await this.flight;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const ref of this.windowEvents.splice(0)) this.host.app.workspace.offref(ref);
    for (const win of this.observedWindows.keys()) this.forgetWindow(win);
    this.unregister();
    this.listeners.clear();
    await this.cancel();
  }

  private async drain(signal: AbortSignal): Promise<void> {
    for (const [id, reference] of this.pending) {
      this.pending.delete(id);
      if (signal.aborted) break;
      if (!this.selected(reference)) continue;
      const stamp = this.stamp();
      const generation = this.host.executionLifecycleRegistry.getProviderGeneration('copilot');
      const current = () => this.selected(reference)
        && stamp === this.stamp()
        && generation === this.host.executionLifecycleRegistry.getProviderGeneration('copilot');
      this.publish(reference, stamp, { phase: 'checking' });
      try {
        const resolution = await this.resolve(reference);
        signal.throwIfAborted();
        if (!current()) continue;
        if (resolution.problems.length > 0 || !resolution.resources) {
          throw new Error(resolution.problems.join('; ') || 'Server configuration is unavailable. Refresh and retry.');
        }
        const fingerprint = hash(resolution);
        const workingDirectory = getVaultPath(this.host.app);
        if (!workingDirectory) throw new Error('Open a local vault before checking MCP servers.');
        const identity = await this.factory.resolveIdentity(workingDirectory);
        signal.throwIfAborted();
        if (!current()) continue;
        const result = await this.probe(reference, resolution.resources, identity, signal).catch(error => {
          if (signal.aborted) throw error;
          return { phase: 'error', message: describeError(error) } as const;
        });
        signal.throwIfAborted();
        if (fingerprint !== hash(await this.resolve(reference))
          || !isSameCopilotClientIdentity(identity, await this.factory.resolveIdentity(workingDirectory))) {
          if (current()) {
            this.states.delete(id);
            this.notify();
          }
          continue;
        }
        if (!signal.aborted && current()) {
          const { type } = resolution.resources.mcpServers[reference.name];
          this.publish(reference, stamp, result, type === 'http' || type === 'sse');
        }
      } catch (error) {
        if (signal.aborted) {
          if (error !== signal.reason) throw error;
          break;
        }
        if (current()) this.publish(reference, stamp, { phase: 'error', message: describeError(error) });
      }
    }
  }

  private resolve(reference: CopilotMcpServerReference) {
    // No vault argument: repository-default skills must not enter a metadata session.
    return resolveCopilotSelectedResources({
      ...getCopilotHostResources(this.host.settings),
      selectedMcpServers: [reference], selectedSkillPaths: [],
    });
  }

  private async probe(
    reference: CopilotMcpServerReference,
    resources: NonNullable<Awaited<ReturnType<typeof resolveCopilotSelectedResources>>['resources']>,
    identity: CopilotClientIdentity,
    signal: AbortSignal,
  ): Promise<CopilotMcpReadiness> {
    const [model] = getEnabledCopilotModels(getCopilotProviderSettings(this.host.settings));
    if (!model) throw new Error('Connect Copilot and enable a model before checking servers.');
    signal.throwIfAborted();
    const client = await this.factory.createClient(identity);
    let session: CopilotSdkSession | undefined;
    let outcome: { result: CopilotMcpReadiness } | { error: unknown };
    const releaseErrors: Error[] = [];
    try {
      signal.throwIfAborted();
      session = await client.createSession({
        availableTools: [], permissionMode: 'ask', model: model.rawId,
        resources: { ...resources, skillDirectories: [] },
        workingDirectory: identity.workingDirectory,
        systemMessage: { mode: 'replace', content: 'MCP readiness only; never run a model turn.' },
        onEvent: () => {},
        onPermissionRequest: async () => ({ kind: 'reject', feedback: 'Readiness checks run no tools.' }),
        onUserInputRequest: async () => { throw new Error('Readiness checks cannot answer chat questions.'); },
      });
      signal.throwIfAborted();
      outcome = { result: await session.checkMcpServer(reference.name) };
    } catch (error) {
      outcome = { error };
    }
    if (session) {
      const acquired = session;
      for (const [step, release] of [
        ['disconnecting the MCP check', () => acquired.disconnect()],
        ['deleting the temporary MCP check', () => client.deleteSession(acquired.sessionId)],
      ] as const) {
        const outcome = await settleNativeWithin((async () => { await release(); })());
        if (outcome.kind === 'rejected') releaseErrors.push(new Error(describeError(outcome.error), { cause: outcome.error }));
        if (outcome.kind === 'timed-out') releaseErrors.push(copilotNativeSilenceError(step));
      }
    }
    try { await client.stop(); } catch (error) { releaseErrors.push(new Error(describeError(error), { cause: error })); }
    if (releaseErrors.length) {
      const failures = 'error' in outcome && outcome.error !== signal.reason
        ? [new Error(describeError(outcome.error), { cause: outcome.error }), ...releaseErrors]
        : releaseErrors;
      throw new Error(failures.map(describeError).join('; '), { cause: new AggregateError(failures) });
    }
    signal.throwIfAborted();
    if ('error' in outcome) throw new Error(describeError(outcome.error), { cause: outcome.error });
    return outcome.result;
  }

  private selected(reference: CopilotMcpServerReference): boolean {
    return getCopilotHostResources(this.host.settings).selectedMcpServers
      .some(candidate => referenceId(candidate) === referenceId(reference));
  }

  private stamp(): string {
    const selection = getCopilotHostResources(this.host.settings);
    const settings = getCopilotProviderSettings(this.host.settings);
    return hash([
      settings.enabled,
      getEnabledCopilotModels(settings).length > 0,
      computeCopilotEnvironmentHash(this.host.settings),
      getVaultPath(this.host.app),
      selection.selectedMcpServers,
      selection.rememberMcpSignIns === true,
    ]);
  }

  private checkInBackground(force = false): void {
    const settings = getCopilotProviderSettings(this.host.settings);
    if (!this.started || this.disposed || !settings.enabled || getEnabledCopilotModels(settings).length === 0) return;
    void (force ? this.check() : this.ensureChecked()).catch(error => {
      new Notice(`MCP readiness check failed: ${describeError(error)}`);
    });
  }

  private notifyAuthenticationRequired(): void {
    if (!this.started || this.disposed || !getCopilotProviderSettings(this.host.settings).enabled) return;
    const selection = getCopilotHostResources(this.host.settings);
    const selectedIds = new Set(selection.selectedMcpServers.map(referenceId));
    for (const id of this.notifiedAuth) {
      if (!selectedIds.has(id)) this.notifiedAuth.delete(id);
    }
    const remote: string[] = [];
    const local: string[] = [];
    for (const reference of selection.selectedMcpServers) {
      const id = referenceId(reference);
      const { phase } = this.getState(reference);
      if (phase === 'connected') this.notifiedAuth.delete(id);
      if (phase !== 'needs-auth' || this.notifiedAuth.has(id)) continue;
      this.notifiedAuth.add(id);
      (this.states.get(id)?.supportsSignIn ? remote : local).push(reference.name);
    }
    const messages: string[] = [];
    if (remote.length > 0) {
      messages.push(`Copilot MCP sign-in required: ${remote.join(', ')}. `
        + 'Open Settings > Claudian > Providers > Copilot > Resources '
        + (selection.rememberMcpSignIns
          ? 'and choose Sign in beside each server.'
          : 'and turn on Remember MCP sign-ins, then choose Sign in beside each server.'));
    }
    if (local.length > 0) {
      messages.push(`Copilot MCP authentication required: ${local.join(', ')}. `
        + 'Check each server\'s source configuration; local servers do not support browser sign-in.');
    }
    if (messages.length > 0) new Notice(messages.join('\n'), 10_000);
  }

  private publish(
    reference: CopilotMcpServerReference,
    stamp: string,
    state: CopilotMcpReadinessState,
    supportsSignIn = false,
  ): void {
    if (this.disposed || stamp !== this.stamp() || !this.selected(reference)) return;
    this.states.set(referenceId(reference), {
      stamp,
      state,
      supportsSignIn,
      ...(state.phase === 'queued' || state.phase === 'checking'
        ? { generation: this.host.executionLifecycleRegistry.getProviderGeneration('copilot') }
        : {}),
    });
    this.notify();
  }

  private notify(): void { for (const listener of this.listeners) listener(); }
}

function referenceId(reference: CopilotMcpServerReference): string {
  return JSON.stringify([reference.configPath, reference.name]);
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
