import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getVaultPath } from '../../../utils/path';
import {
  type CopilotDiscoveredModel,
  normalizeCopilotDiscoveredModels,
} from '../models';
import { CopilotClientFactory } from '../sdk/CopilotClientFactory';
import { acquireNativeWithin, copilotNativeSilenceError } from '../sdk/CopilotNativeBudget';
import { describeError, toCopilotRuntimeError } from '../sdk/CopilotRuntimeError';
import type {
  CopilotSdkClient,
  CopilotSdkModel,
  CopilotSdkRuntime,
} from '../sdk/CopilotSdkPort';

export type CopilotModelDiscoveryResult =
  | { readonly kind: 'loaded'; readonly models: CopilotDiscoveredModel[] }
  | { readonly kind: 'failed'; readonly message: string };

export interface CopilotModelDiscoveryServiceOptions {
  readonly runtime?: CopilotSdkRuntime;
}

/**
 * Discovers the models the signed-in account may use.
 *
 * Discovery owns its own short-lived client so it never contends with, or outlives, a
 * chat session. Models the account's policy disables are dropped, because an enabled
 * model in settings must be one the user can actually select.
 */
export class CopilotModelDiscoveryService {
  private readonly clientFactory: CopilotClientFactory;

  constructor(
    private readonly host: ProviderHost,
    options: CopilotModelDiscoveryServiceOptions = {},
  ) {
    this.clientFactory = new CopilotClientFactory(host, {
      ...(options.runtime ? { runtime: options.runtime } : {}),
    });
  }

  async discoverModels(): Promise<CopilotModelDiscoveryResult> {
    const workingDirectory = getVaultPath(this.host.app) ?? process.cwd();
    let client;
    try {
      client = await this.clientFactory.createClient(
        await this.clientFactory.resolveIdentity(workingDirectory),
      );
    } catch (error) {
      return { kind: 'failed', message: describeError(error) };
    }

    try {
      const models = await this.listModels(client);
      return {
        kind: 'loaded',
        models: normalizeCopilotDiscoveredModels(
          models.filter(isSelectableModel).map(toDiscoveredModelInput),
        ),
      };
    } catch (error) {
      return { kind: 'failed', message: describeError(error) };
    } finally {
      await stopProbeClient(client);
    }
  }

  /**
   * Reads the catalog under the shared native release budget.
   *
   * The probe holds the Discover button open until it returns, so a CLI that goes silent
   * on the catalog must not hold it open for as long as it stays silent. Silence is
   * reported as the transport failure it is and the probe's client is shut down either
   * way, so a failed discovery never leaves a CLI running behind it.
   */
  private async listModels(client: CopilotSdkClient): Promise<readonly CopilotSdkModel[]> {
    const outcome = await acquireNativeWithin(client.listModels());
    switch (outcome.kind) {
      case 'settled':
        return outcome.value;
      case 'rejected':
        throw toCopilotRuntimeError(outcome.error, 'provider');
      case 'timed-out':
        throw copilotNativeSilenceError('listing the Copilot models');
    }
  }
}

/**
 * Shuts the probe's own client down. Its stop already escalates to a forced one, and this
 * client is discarded either way, so a shutdown failure must not replace the catalog the
 * account just answered with or the diagnostic explaining why it did not.
 */
async function stopProbeClient(client: CopilotSdkClient): Promise<void> {
  try {
    await client.stop();
  } catch {
    // Nothing owns this client after the probe, so there is no caller to report it to.
  }
}

function isSelectableModel(model: CopilotSdkModel): boolean {
  const policy = (model as { policy?: { state?: unknown } }).policy;
  return policy?.state !== 'disabled';
}

function toDiscoveredModelInput(model: CopilotSdkModel): Record<string, unknown> {
  const capabilities = (model as {
    capabilities?: {
      limits?: { max_context_window_tokens?: unknown };
      supports?: { reasoningEffort?: unknown; vision?: unknown };
    };
  }).capabilities;

  return {
    defaultReasoningEffort: (model as { defaultReasoningEffort?: unknown })
      .defaultReasoningEffort,
    id: model.id,
    maxContextWindowTokens: capabilities?.limits?.max_context_window_tokens,
    name: model.name,
    supportedReasoningEfforts: capabilities?.supports?.reasoningEffort
      ? (model as { supportedReasoningEfforts?: unknown }).supportedReasoningEfforts
      : [],
    supportsVision: capabilities?.supports?.vision === true,
  };
}
