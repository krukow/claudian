import { createHash } from 'node:crypto';

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

/** One settings-scoped queue, with an isolated native lease for each selected server. */
export class CopilotMcpReadinessCoordinator {
  private readonly factory: CopilotClientFactory;
  private readonly states = new Map<string, { stamp: string; state: CopilotMcpReadinessState }>();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, CopilotMcpServerReference>();
  private readonly unregister: () => void;
  private controller: AbortController | null = null;
  private flight: Promise<void> | null = null;
  private cancellationGeneration = 0;
  private disposed = false;
  private transitioning = false;

  constructor(private readonly host: ProviderHost, options: { runtime?: CopilotSdkRuntime } = {}) {
    this.factory = new CopilotClientFactory(host, options);
    this.unregister = host.executionLifecycleRegistry.registerTransitionHook('copilot', {
      beforeTransition: async () => {
        this.transitioning = true;
        await this.quiesce();
      },
      afterTransition: () => {
        const stamp = this.stamp();
        for (const [id, entry] of this.states) {
          if (entry.stamp !== stamp) this.states.delete(id);
        }
        this.transitioning = false;
        this.notify();
      },
    });
  }

  getState(reference: CopilotMcpServerReference): CopilotMcpReadinessState {
    const entry = this.states.get(referenceId(reference));
    return this.selected(reference) && entry?.stamp === this.stamp()
      ? entry.state : { phase: 'unchecked' };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  check(reference?: CopilotMcpServerReference): Promise<void> {
    return this.enqueue(reference, false);
  }

  ensureChecked(): Promise<void> {
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
    if (this.flight) return this.flight;
    const controller = new AbortController();
    this.controller = controller;
    this.flight = Promise.resolve().then(async () => {
      try {
        while (this.pending.size > 0 && !controller.signal.aborted) await this.drain(controller.signal);
      } finally {
        this.flight = null;
        this.controller = null;
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
          this.states.delete(id);
          this.notify();
          continue;
        }
        if (!signal.aborted && current()) this.publish(reference, stamp, result);
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
    return hash([
      computeCopilotEnvironmentHash(this.host.settings),
      getVaultPath(this.host.app),
      selection.selectedMcpServers,
      selection.rememberMcpSignIns === true,
    ]);
  }

  private publish(reference: CopilotMcpServerReference, stamp: string, state: CopilotMcpReadinessState): void {
    if (this.disposed || stamp !== this.stamp() || !this.selected(reference)) return;
    this.states.set(referenceId(reference), { stamp, state });
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
