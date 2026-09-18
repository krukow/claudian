import type { ProviderHost } from '@/core/providers/ProviderHost';
import { getVaultPath } from '@/utils/path';

import { getCopilotHostResources } from '../resources/CopilotHostResources';
import { resolveCopilotSelectedResources } from '../resources/CopilotResourceResolver';
import type { CopilotMcpServerReference } from '../resources/CopilotResourceSettings';
import { CopilotClientFactory } from '../sdk/CopilotClientFactory';
import { copilotNativeSilenceError, settleNativeWithin } from '../sdk/CopilotNativeBudget';
import { describeError } from '../sdk/CopilotRuntimeError';
import type { CopilotSdkRuntime, CopilotSdkSession } from '../sdk/CopilotSdkPort';
import { getCopilotProviderSettings, getEnabledCopilotModels } from '../settings';

export type CopilotMcpSignInState =
  | { readonly phase: 'idle' | 'starting' | 'connected' }
  | { readonly phase: 'waiting'; readonly authorizationUrl: string }
  | { readonly phase: 'error'; readonly message: string };

export class CopilotMcpSignInCoordinator {
  private readonly factory: CopilotClientFactory;
  private readonly states = new Map<string, CopilotMcpSignInState>();
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private flight: Promise<void> | null = null;
  private activeReference: string | null = null;
  private cancelled = false;
  private disposed = false;

  constructor(
    private readonly host: ProviderHost,
    options: { readonly runtime?: CopilotSdkRuntime } = {},
  ) {
    this.factory = new CopilotClientFactory(host, options);
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
    if (this.flight) {
      if (this.activeReference === id) return this.flight;
      this.publish(id, { phase: 'error', message: 'Finish or cancel the current MCP sign-in first.' });
      return Promise.resolve();
    }
    const controller = new AbortController();
    this.controller = controller;
    this.activeReference = id;
    this.cancelled = false;
    const timer = window.setTimeout(() => {
      controller.abort(new Error('MCP sign-in timed out. Try again when you are ready.'));
    }, 300_000);
    this.flight = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      this.publish(id, { phase: 'starting' });
      await this.authenticate(reference, controller.signal);
      controller.signal.throwIfAborted();
      await this.host.runProviderExecutionTransition(['copilot'], async () => {});
      this.publish(id, { phase: 'connected' });
    }).catch(error => {
      this.publish(id, this.cancelled && error === controller.signal.reason
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
    if (reference && this.activeReference !== referenceId(reference)) return;
    this.cancelled = true;
    this.controller?.abort(new Error('MCP sign-in cancelled.'));
    await this.flight;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel();
    this.listeners.clear();
    this.states.clear();
  }

  private async authenticate(reference: CopilotMcpServerReference, signal: AbortSignal): Promise<void> {
    const selection = getCopilotHostResources(this.host.settings);
    if (!selection.rememberMcpSignIns) {
      throw new Error('Enable Remember MCP sign-ins to connect a server from settings.');
    }
    if (!selection.selectedMcpServers.some(ref => referenceId(ref) === referenceId(reference))) {
      throw new Error('Select this MCP server before signing in.');
    }
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
    signal.throwIfAborted();
    const client = await this.factory.createClient(identity);
    let session: CopilotSdkSession | undefined;
    let status: string | undefined;
    let changed: (() => void) | undefined;
    const failures: unknown[] = [];
    try {
      signal.throwIfAborted();
      session = await client.createSession({
        availableTools: [],
        model: model.rawId,
        onEvent: event => {
          if (event.type === 'session.mcp_server_status_changed' && event.data.serverName === reference.name) {
            status = event.data.status;
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
      signal.throwIfAborted();
      status = undefined;
      const result = await session.signInMcpServer(reference.name);
      signal.throwIfAborted();
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
      if (!signal.aborted) failures.push(error);
    }
    changed = undefined;
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
      if (outcome.kind === 'rejected') failures.push(outcome.error);
      if (outcome.kind === 'timed-out') failures.push(copilotNativeSilenceError(step));
    }
    try { await client.stop(); } catch (error) { failures.push(error); }
    if (failures.length > 0) {
      throw new Error(failures.map(describeError).join('; '), { cause: new AggregateError(failures) });
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
