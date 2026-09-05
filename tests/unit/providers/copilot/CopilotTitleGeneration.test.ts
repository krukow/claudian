import { TitleGenerationService } from '@/core/auxiliary/TitleGenerationService';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { TitleGenerationResult } from '@/core/providers/types';
import { CopilotExecutionBackend } from '@/providers/copilot/execution/CopilotExecutionBackend';
import { copilotProviderRegistration } from '@/providers/copilot/registration';
import type { CopilotSdkEvent } from '@/providers/copilot/sdk/CopilotSdkPort';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';

import {
  FakeCopilotSdkClient,
  FakeCopilotSdkRuntime,
} from './sdk/FakeCopilotSdkRuntime';

const VAULT_PATH = '/vault';

function createHost(settings: Record<string, unknown>): ProviderHost {
  return {
    app: { vault: { adapter: { basePath: VAULT_PATH } } },
    getResolvedProviderCliPath: async () => '/usr/local/bin/copilot',
    settings,
  } as unknown as ProviderHost;
}

function createSettings(
  visibleModels: readonly string[],
  titleGenerationModel: string,
): Record<string, unknown> {
  const settings: Record<string, unknown> = { titleGenerationModel };
  updateCopilotProviderSettings(settings, {
    discoveredModels: ['gpt-5-mini', 'gpt-5'].map(rawId => ({
      displayName: rawId,
      rawId,
      reasoningEfforts: [],
      supportsReasoning: false,
      supportsVision: false,
    })),
    enabled: true,
    visibleModels: [...visibleModels],
  });
  return settings;
}

function titleEvent(text: string): CopilotSdkEvent {
  return {
    data: { deltaContent: text, messageId: 'message-1' },
    id: 'event-1',
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    type: 'assistant.message_delta',
  } as unknown as CopilotSdkEvent;
}

/** Titles one conversation through the shared service, on a fake Copilot runtime. */
async function generateTitle(settings: Record<string, unknown>): Promise<{
  readonly client: FakeCopilotSdkClient;
  readonly result: TitleGenerationResult;
}> {
  const client = new FakeCopilotSdkClient({
    onSessionCreated: (created) => {
      created.sendBehavior = async () => { created.emit(titleEvent('Vault cleanup plan')); };
    },
  });
  const runtime = new FakeCopilotSdkRuntime(() => client);
  const host = createHost(settings);
  const service = new TitleGenerationService({
    backend: new CopilotExecutionBackend(host, { runtime }),
    interactionPort: {
      askUserQuestion: jest.fn(),
      dismissInteraction: jest.fn(),
      requestApproval: jest.fn(),
      requestPlanDecision: jest.fn(),
    },
    lifecycleRegistry: new ProviderExecutionLifecycleRegistry(),
    resolveModel: () => copilotProviderRegistration.resolveTitleGenerationModel?.(host),
    vaultWorkingDirectory: VAULT_PATH,
  });

  let result!: TitleGenerationResult;
  await service.generateTitle('conversation-1', 'Tidy up my vault', async (_id, outcome) => {
    result = outcome;
  });
  return { client, result };
}

/** Auto must reach the CLI as an enabled model, resolved by the execution boundary. */
describe('Copilot title generation', () => {
  it('titles a conversation with the first enabled model when the setting is Auto',
    async () => {
      const { client, result } = await generateTitle(
        createSettings(['gpt-5-mini', 'gpt-5'], ''),
      );

      expect(result).toEqual({ success: true, title: 'Vault cleanup plan' });
      expect(client.createdSessions[0]?.config.model).toBe('gpt-5-mini');
    });

  it('titles a conversation with the selection the user made', async () => {
    const { client, result } = await generateTitle(
      createSettings(['gpt-5-mini', 'gpt-5'], 'copilot/gpt-5'),
    );

    expect(result).toEqual({ success: true, title: 'Vault cleanup plan' });
    expect(client.createdSessions[0]?.config.model).toBe('gpt-5');
  });

  /**
   * A selection the user has since hidden is still a Copilot selection, so the turn stays
   * with Copilot rather than being handed to a provider that owns none of it. It is not a
   * model a turn may run with, though, so it resolves to the one the chat selector would
   * default to: the first enabled model.
   */
  it('titles with the first enabled model when the selection is hidden', async () => {
    const { client, result } = await generateTitle(
      createSettings(['gpt-5-mini'], 'copilot/gpt-5'),
    );

    expect(result).toEqual({ success: true, title: 'Vault cleanup plan' });
    expect(client.createdSessions[0]?.config.model).toBe('gpt-5-mini');
  });

  it('titles with the first enabled model when the catalog dropped the selection',
    async () => {
      const { client, result } = await generateTitle(
        createSettings(['gpt-5-mini', 'gpt-5'], 'copilot/retired-model'),
      );

      expect(result).toEqual({ success: true, title: 'Vault cleanup plan' });
      expect(client.createdSessions[0]?.config.model).toBe('gpt-5-mini');
    });

  /**
   * With nothing enabled there is no model to title with, and no provider default to
   * reach for. The turn reports that rather than running one the user never turned on.
   */
  it('reports the missing model instead of titling with an unenabled one', async () => {
    const { client, result } = await generateTitle(createSettings([], ''));

    expect(result).toMatchObject({
      error: expect.stringContaining('Select an enabled Copilot model'),
      success: false,
    });
    expect(client.createdSessions).toEqual([]);
  });
});
