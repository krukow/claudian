import type { ProviderHost } from '@/core/providers/ProviderHost';
import { getVaultPath } from '@/utils/path';

import { getCopilotHostResources } from '../resources/CopilotHostResources';
import { resolveCopilotSelectedResources } from '../resources/CopilotResourceResolver';
import type { CopilotMcpServerReference, CopilotResourceSettings } from '../resources/CopilotResourceSettings';
import { CopilotClientFactory } from '../sdk/CopilotClientFactory';
import { copilotNativeSilenceError, settleNativeWithin } from '../sdk/CopilotNativeBudget';
import { describeError } from '../sdk/CopilotRuntimeError';
import type { CopilotSdkRuntime, CopilotSdkSession } from '../sdk/CopilotSdkPort';
import { getCopilotProviderSettings, getEnabledCopilotModels } from '../settings';

export type CopilotMcpSignInState =
  | { readonly phase: 'idle' | 'starting' }
  | { readonly phase: 'connected'; readonly warning?: string }
  | { readonly phase: 'waiting'; readonly authorizationUrl: string }
  | { readonly phase: 'error'; readonly message: string };

export class CopilotMcpSignInCoordinator {
  private readonly factory: CopilotClientFactory;
  private readonly states = new Map<string, CopilotMcpSignInState>();
  private readonly listeners = new Set<() => void>();
  private readonly unregister: () => void;
  private readonly lifecycleFailures: unknown[] = [];
  private controller: AbortController | null = null;
  private authentication: Promise<void> | null = null;
  private flight: Promise<void> | null = null;
  private activeReference: string | null = null;
  private cancellationRevision = 0;
  private cancelled = false;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private transitioning = false;

  constructor(
    private readonly host: ProviderHost,
    options: { readonly runtime?: CopilotSdkRuntime } = {},
  ) {
    this.factory = new CopilotClientFactory(host, options);
    this.unregister = host.executionLifecycleRegistry.registerTransitionHook('copilot', {
      beforeTransition: async () => {
        this.transitioning = true;
        this.cancellationRevision += 1;
        if (!this.authentication) return;
        const authentication = this.authentication;
        const signal = this.controller!.signal;
        this.controller!.abort(new Error('Copilot settings changed during MCP sign-in. Try again.'));
        try {
          await authentication;
        } catch (error) {
          if (error !== signal.reason) throw error;
        }
      },
      afterTransition: () => { this.transitioning = false; },
    });
  }

  getState(reference: CopilotMcpServerReference): CopilotMcpSignInState {
    return this.states.get(referenceId(reference)) ?? { phase: 'idle' };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  signIn(reference: CopilotMcpServerReference): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('MCP sign-in is disposed.'));
    const id = referenceId(reference);
    if (this.transitioning) {
      this.publish(id, { phase: 'error', message: 'Copilot settings are changing. Wait for them to finish, then try again.' });
      return Promise.resolve();
    }
    if (this.flight) {
      if (this.activeReference === id) {
        if (this.controller?.signal.aborted) {
          const revision = this.cancellationRevision;
          return this.flight.then(() => {
            if (revision === this.cancellationRevision && !this.disposed) return this.signIn(reference);
          });
        }
        return this.flight;
      }
      this.publish(id, { phase: 'error', message: 'Finish or cancel the current MCP sign-in first.' });
      return Promise.resolve();
    }
    const controller = new AbortController();
    this.controller = controller;
    this.activeReference = id;
    this.cancelled = false;
    const generation = this.host.executionLifecycleRegistry.getProviderGeneration('copilot');
    let authenticated = false;
    const timer = window.setTimeout(() => {
      controller.abort(new Error('MCP sign-in timed out. Try again when you are ready.'));
    }, 300_000);
    this.authentication = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      this.publish(id, { phase: 'starting' });
      await this.authenticate(reference, controller.signal, generation, () => { authenticated = true; });
    }).catch(error => {
      if (!authenticated || error !== controller.signal.reason) throw error;
    }).finally(() => { this.authentication = null; });
    // A transition drains native authentication, never the flight awaiting that transition.
    this.flight = this.authentication.then(async () => {
      try {
        this.assertAuthorized(reference, generation);
        await this.host.runProviderExecutionTransition(['copilot'], async () => {
          this.assertAuthorized(reference, generation + 1);
        });
        this.assertAuthorized(reference, generation + 1);
      } catch (error) {
        this.lifecycleFailures.push(error);
        throw error;
      }
      this.publish(id, { phase: 'connected' });
    }).catch(error => {
      this.publish(id, authenticated
        ? { phase: 'connected', warning: describeError(error) }
        : this.cancelled && error === controller.signal.reason
        ? { phase: 'idle' }
        : { phase: 'error', message: describeError(error) });
    }).finally(() => {
      window.clearTimeout(timer);
      this.controller = null;
      this.flight = null;
      this.activeReference = null;
    });
    return this.flight;
  }

  async cancel(reference?: CopilotMcpServerReference): Promise<void> {
    if (reference && this.activeReference !== null && this.activeReference !== referenceId(reference)) return;
    this.cancellationRevision += 1;
    this.cancelled = true;
    this.controller?.abort(new Error('MCP sign-in cancelled.'));
    await this.flight;
    if (this.lifecycleFailures.length > 0) {
      throw new AggregateError(this.lifecycleFailures, this.lifecycleFailures.map(describeError).join('; '));
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.unregister();
    this.disposal = this.cancel().finally(() => {
      this.listeners.clear();
      this.states.clear();
    });
    return this.disposal;
  }

  private assertAuthorized(
    reference: CopilotMcpServerReference,
    generation: number,
  ): CopilotResourceSettings {
    if (generation !== this.host.executionLifecycleRegistry.getProviderGeneration('copilot')) {
      throw new Error('Copilot settings changed during MCP sign-in. Try again.');
    }
    const selection = getCopilotHostResources(this.host.settings);
    if (!selection.rememberMcpSignIns) {
      throw new Error('Enable Remember MCP sign-ins to connect a server from settings.');
    }
    if (!selection.selectedMcpServers.some(ref => referenceId(ref) === referenceId(reference))) {
      throw new Error('Select this MCP server before signing in.');
    }
    return selection;
  }

  private async authenticate(
    reference: CopilotMcpServerReference,
    signal: AbortSignal,
    generation: number,
    onAuthenticated: () => void,
  ): Promise<void> {
    const assertActive = (): CopilotResourceSettings => {
      signal.throwIfAborted();
      return this.assertAuthorized(reference, generation);
    };
    const selection = assertActive();
    const resolution = await resolveCopilotSelectedResources({
      ...selection,
      selectedMcpServers: [reference],
      selectedSkillPaths: [],
    });
    if (resolution.problems.length > 0 || !resolution.resources) {
      throw new Error(resolution.problems.join('\n') || 'This MCP server is unavailable.');
    }
    const server = resolution.resources.mcpServers[reference.name];
    if (server.type !== 'http' && server.type !== 'sse') {
      throw new Error('Browser sign-in is available for HTTP and SSE MCP servers.');
    }
    const [model] = getEnabledCopilotModels(getCopilotProviderSettings(this.host.settings));
    const workingDirectory = getVaultPath(this.host.app);
    if (!workingDirectory || !model) throw new Error('Connect Copilot and select a model first.');
    signal.throwIfAborted();
    const identity = await this.factory.resolveIdentity(workingDirectory);
    assertActive();
    const client = await this.factory.createClient(identity);
    let session: CopilotSdkSession | undefined;
    let status: string | undefined;
    let signInRequested = false;
    let changed: (() => void) | undefined;
    const failures: unknown[] = [];
    try {
      assertActive();
      session = await client.createSession({
        availableTools: [],
        model: model.rawId,
        onEvent: event => {
          if (event.type === 'session.mcp_server_status_changed' && event.data.serverName === reference.name) {
            status = event.data.status;
            if (signInRequested && status === 'connected') onAuthenticated();
            changed?.();
          }
        },
        onPermissionRequest: async () => ({ kind: 'reject', feedback: 'MCP sign-in runs no tools.' }),
        onUserInputRequest: async () => { throw new Error('MCP sign-in cannot answer chat questions.'); },
        resources: {
          mcpServers: { [reference.name]: server },
          mcpOAuthTokenStorage: 'persistent',
          skillDirectories: [],
        },
        systemMessage: { mode: 'replace', content: 'MCP authentication only; do not run a model turn.' },
        workingDirectory,
      });
      assertActive();
      status = undefined;
      signInRequested = true;
      const result = await session.signInMcpServer(reference.name);
      if (!result.authorizationUrl) onAuthenticated();
      assertActive();
      if (result.authorizationUrl) {
        const authorizationUrl = validateAuthorizationUrl(result.authorizationUrl);
        this.publish(referenceId(reference), { phase: 'waiting', authorizationUrl });
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            signal.removeEventListener('abort', abort);
            reject(signal.reason instanceof Error ? signal.reason : new Error('MCP sign-in cancelled.'));
          };
          changed = () => {
            if (status === 'connected' || status === 'failed') {
              signal.removeEventListener('abort', abort);
              if (status === 'connected') resolve();
              else reject(new Error('The MCP server could not finish signing in. Check browser authorization and retry.'));
            }
          };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          else changed();
        });
      }
    } catch (error) {
      if (error !== signal.reason) failures.push(error);
    }
    changed = undefined;
    const cleanupFailures: unknown[] = [];
    const releases: Array<[string, () => Promise<void>]> = [];
    if (session) {
      const acquired = session;
      releases.push(
        ['disconnecting MCP sign-in', () => acquired.disconnect()],
        ['deleting the temporary MCP sign-in session', async () => {
          await client.deleteSession(acquired.sessionId);
        }],
      );
    }
    for (const [step, release] of releases) {
      const outcome = await settleNativeWithin(release());
      if (outcome.kind === 'rejected') cleanupFailures.push(outcome.error);
      if (outcome.kind === 'timed-out') cleanupFailures.push(copilotNativeSilenceError(step));
    }
    try { await client.stop(); } catch (error) { cleanupFailures.push(error); }
    failures.push(...cleanupFailures);
    if (failures.length > 0) {
      const error = new AggregateError(failures, failures.map(describeError).join('; '));
      if (cleanupFailures.length > 0) this.lifecycleFailures.push(error);
      throw error;
    }
    signal.throwIfAborted();
  }

  private publish(id: string, state: CopilotMcpSignInState): void {
    this.states.set(id, state);
    for (const listener of this.listeners) listener();
  }
}

function referenceId(reference: CopilotMcpServerReference): string {
  return JSON.stringify([reference.configPath, reference.name]);
}

function validateAuthorizationUrl(value: string): string {
  const url = new URL(value);
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('The MCP server returned an unsupported sign-in URL.');
  }
  return url.href;
}
