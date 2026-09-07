import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { CopilotClientFactory } from '../sdk/CopilotClientFactory';
import type { CopilotSdkRuntime } from '../sdk/CopilotSdkPort';
import { CopilotExecutionSession } from './CopilotExecutionSession';

export interface CopilotExecutionBackendOptions {
  /** Injected in tests so the SDK and the `copilot` CLI stay the only mocked boundary. */
  readonly runtime?: CopilotSdkRuntime;
}

export class CopilotExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'copilot' as const;
  private readonly clientFactory: CopilotClientFactory;

  constructor(
    plugin: ProviderHost,
    options: CopilotExecutionBackendOptions = {},
  ) {
    this.clientFactory = new CopilotClientFactory(plugin, {
      ...(options.runtime ? { runtime: options.runtime } : {}),
    });
    this.plugin = plugin;
  }

  private readonly plugin: ProviderHost;

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new CopilotExecutionSession(this.plugin, config, {
      clientFactory: this.clientFactory,
    });
  }
}
