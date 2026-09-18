import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { getVaultPath } from '@/utils/path';

import { computeCopilotEnvironmentHash } from '../env/CopilotSettingsReconciler';
import { type CopilotDiscoveredModel, encodeCopilotModelId } from '../models';
import { CopilotModelDiscoveryService } from '../runtime/CopilotModelDiscoveryService';
import { CopilotClientFactory, type CopilotClientIdentity } from '../sdk/CopilotClientFactory';
import { copilotConfigurationError, describeError } from '../sdk/CopilotRuntimeError';
import type { CopilotSdkRuntime } from '../sdk/CopilotSdkPort';
import { getCopilotProviderSettings, updateCopilotProviderSettings } from '../settings';

export type CopilotConnectionState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'checking' | 'discovering' | 'saving' }
  | { readonly phase: 'signing-in'; readonly authorizationUrl?: string }
  | {
      readonly phase: 'choose-model';
      readonly models: readonly CopilotDiscoveredModel[];
      readonly recommendedModel: string;
    }
  | { readonly phase: 'connected'; readonly model: string }
  | { readonly phase: 'error'; readonly message: string };

export interface CopilotConnectionOptions {
  readonly login: {
    signIn(
      identity: CopilotClientIdentity,
      signal: AbortSignal,
      onAuthorizationUrl?: (url: string) => void,
    ): Promise<void>;
  };
  readonly runtime?: CopilotSdkRuntime;
}

export class CopilotConnectionCoordinator {
  private readonly factory: CopilotClientFactory;
  private readonly discovery: CopilotModelDiscoveryService;
  private readonly listeners = new Set<(state: CopilotConnectionState) => void>();
  private current: CopilotConnectionState = { phase: 'idle' };
  private controller: AbortController | null = null;
  private flight: Promise<void> | null = null;
  private selectionEnvironment: string | null = null;
  private cancellationRevision = 0;
  private disposed = false;

  constructor(
    private readonly host: ProviderHost,
    private readonly options: CopilotConnectionOptions,
  ) {
    const runtimeOptions = options.runtime ? { runtime: options.runtime } : {};
    this.factory = new CopilotClientFactory(host, runtimeOptions);
    this.discovery = new CopilotModelDiscoveryService(host, runtimeOptions);
  }

  get state(): CopilotConnectionState {
    return this.current;
  }

  subscribe(listener: (state: CopilotConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => { this.listeners.delete(listener); };
  }

  connect(): Promise<void> {
    if (this.flight && this.controller?.signal.aborted) {
      const revision = this.cancellationRevision;
      return this.flight.then(() => {
        if (revision === this.cancellationRevision && !this.disposed) {
          return this.connect();
        }
      });
    }
    return this.run(async signal => {
      this.selectionEnvironment = null;
      this.publish({ phase: 'checking' });
      const environment = computeCopilotEnvironmentHash(this.host.settings);
      const workingDirectory = getVaultPath(this.host.app);
      if (!workingDirectory) {
        throw copilotConfigurationError('Open a local vault before connecting Copilot.');
      }
      const identity = await this.factory.resolveIdentity(workingDirectory);
      signal.throwIfAborted();
      const auth = await this.factory.getAuthStatus(identity);
      signal.throwIfAborted();
      this.assertEnvironment(environment);
      if (!auth.isAuthenticated) {
        this.publish({ phase: 'signing-in' });
        await this.options.login.signIn(identity, signal, authorizationUrl => {
          if (!signal.aborted) {
            this.publish({ authorizationUrl, phase: 'signing-in' });
          }
        });
      }
      signal.throwIfAborted();
      this.assertEnvironment(environment);
      this.publish({ phase: 'discovering' });
      const catalog = await this.discovery.discoverModels();
      signal.throwIfAborted();
      this.assertEnvironment(environment);
      if (catalog.kind === 'failed') {
        throw new Error(catalog.message);
      }
      const models = catalog.models;
      const preferred = getCopilotProviderSettings(this.host.settings).visibleModels[0];
      const recommended = models.find(model => model.rawId === preferred)
        ?? models.find(model => model.rawId !== 'auto')
        ?? models[0];
      if (!recommended) {
        throw new Error('This account offers no Copilot models. Check your subscription and organization policy.');
      }
      this.selectionEnvironment = environment;
      this.publish({
        models,
        phase: 'choose-model',
        recommendedModel: recommended.rawId,
      });
    });
  }

  async confirmModel(rawId: string): Promise<boolean> {
    const selection = this.current;
    const environment = this.selectionEnvironment;
    let committed = false;
    await this.run(async signal => {
      if (
        selection.phase !== 'choose-model'
        || !selection.models.some(model => model.rawId === rawId)
        || environment === null
      ) {
        throw copilotConfigurationError('Choose one of the discovered Copilot models.');
      }
      const intent = this.host.chatModelSelection.beginIntent();
      this.publish({ phase: 'saving' });
      await this.host.mutateSettings(settings => {
        signal.throwIfAborted();
        this.assertEnvironment(environment);
        const current = getCopilotProviderSettings(settings);
        updateCopilotProviderSettings(settings, {
          discoveredModels: [...selection.models],
          environmentHash: environment,
          visibleModels: [rawId, ...current.visibleModels.filter(id => id !== rawId)],
        });
        ProviderSettingsCoordinator.applyProviderEnablement(settings, 'copilot', true);
        const snapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, 'copilot');
        ProviderSettingsCoordinator.applyModelSelection(snapshot, 'copilot', encodeCopilotModelId(rawId));
        ProviderSettingsCoordinator.commitProviderSettingsSnapshot(settings, 'copilot', snapshot);
      });
      committed = true;
      this.host.notifyProviderChatOptionsChanged('copilot');
      const selected = await this.host.chatModelSelection.commitIntent(
        intent,
        { model: encodeCopilotModelId(rawId), providerId: 'copilot' },
        () => {
          const settings = getCopilotProviderSettings(this.host.settings);
          return !this.disposed
            && computeCopilotEnvironmentHash(this.host.settings) === environment
            && settings.enabled
            && settings.visibleModels.includes(rawId);
        },
      );
      if (!selected) {
        throw new Error('Copilot was enabled, but the chat model changed while saving. Choose your model again.');
      }
      if (!signal.aborted) {
        this.publish({ model: rawId, phase: 'connected' });
      }
    });
    return committed;
  }

  async cancel(): Promise<void> {
    this.cancellationRevision += 1;
    this.controller?.abort(new Error('Copilot connection cancelled.'));
    await this.flight;
    this.selectionEnvironment = null;
    if (!this.disposed) {
      this.publish({ phase: 'idle' });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel();
    this.listeners.clear();
  }

  private run(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('Copilot connection is disposed.'));
    }
    if (this.flight) {
      return this.flight;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.flight = operation(controller.signal)
      .catch(error => {
        if (!controller.signal.aborted) {
          this.publish({ message: describeError(error), phase: 'error' });
        }
      })
      .finally(() => {
        this.controller = null;
        this.flight = null;
      });
    return this.flight;
  }

  private assertEnvironment(expected: string): void {
    if (computeCopilotEnvironmentHash(this.host.settings) !== expected) {
      throw new Error('Copilot settings changed during connection. Select Connect Copilot to try again.');
    }
  }

  private publish(state: CopilotConnectionState): void {
    this.current = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
