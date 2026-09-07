import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { SlashCommand } from '@/core/types';
import { getVaultPath } from '@/utils/path';

import { getCopilotHostResources } from '../resources/CopilotHostResources';
import { resolveCopilotSelectedResources } from '../resources/CopilotResourceResolver';
import { CopilotClientFactory } from '../sdk/CopilotClientFactory';
import { copilotNativeSilenceError, settleNativeWithin } from '../sdk/CopilotNativeBudget';
import { copilotConfigurationError } from '../sdk/CopilotRuntimeError';
import type { CopilotSdkClient, CopilotSdkRuntime } from '../sdk/CopilotSdkPort';
import { getCopilotProviderSettings, getEnabledCopilotModels } from '../settings';

export interface CopilotCommandMetadataProbeOptions {
  readonly clientFactory?: CopilotClientFactory;
  readonly runtime?: CopilotSdkRuntime;
}

/**
 * Lists the commands the selected skills register, on a runtime of its own.
 *
 * The chat session cannot answer this: it exists only while a conversation is open, and
 * asking it would tie a settings-time listing to whichever turn happens to be running.
 * So a client and a session are started for the listing and released again, and the
 * native session this created is deleted — it is Claudian's own lease, not user history.
 *
 * The probe session carries the selected skills and nothing else: no MCP server, and no
 * tool at all, because listing commands never runs one.
 */
export class CopilotCommandMetadataProbe {
  private readonly clientFactory: CopilotClientFactory;
  private disposed = false;
  /** Serializes loads, so a second refresh never starts a second CLI beside the first. */
  private inFlight: Promise<SlashCommand[]> | null = null;

  constructor(
    private readonly host: ProviderHost,
    options: CopilotCommandMetadataProbeOptions = {},
  ) {
    this.clientFactory = options.clientFactory ?? new CopilotClientFactory(host, {
      ...(options.runtime ? { runtime: options.runtime } : {}),
    });
  }

  async load(signal?: AbortSignal): Promise<SlashCommand[]> {
    if (this.disposed) {
      throw new Error('Copilot command discovery is disposed.');
    }
    signal?.throwIfAborted();
    this.inFlight = (this.inFlight ?? Promise.resolve([])).then(
      () => this.loadCommands(signal),
      () => this.loadCommands(signal),
    );
    return this.inFlight;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.inFlight;
  }

  private async loadCommands(signal?: AbortSignal): Promise<SlashCommand[]> {
    const resolution = await resolveCopilotSelectedResources(
      { ...getCopilotHostResources(this.host.settings), selectedMcpServers: [] },
    );
    if (resolution.problems.length > 0) {
      throw copilotConfigurationError(resolution.problems.join('\n'));
    }
    const skillDirectories = resolution.resources?.skillDirectories ?? [];
    if (skillDirectories.length === 0) {
      return [];
    }
    signal?.throwIfAborted();

    const [model] = getEnabledCopilotModels(getCopilotProviderSettings(this.host.settings));
    if (!model) {
      throw copilotConfigurationError(
        'Enable a Copilot model before loading the skills it can run.',
      );
    }
    const workingDirectory = getVaultPath(this.host.app) ?? process.cwd();
    const client = await this.clientFactory.createClient(
      await this.clientFactory.resolveIdentity(workingDirectory),
    );
    try {
      signal?.throwIfAborted();
      return await this.listThroughSession(
        client,
        skillDirectories,
        model.rawId,
        workingDirectory,
        signal,
      );
    } finally {
      await client.stop();
    }
  }

  private async listThroughSession(
    client: CopilotSdkClient,
    skillDirectories: readonly string[],
    model: string,
    workingDirectory: string,
    signal?: AbortSignal,
  ): Promise<SlashCommand[]> {
    const session = await client.createSession({
      availableTools: [],
      model,
      onEvent: () => {},
      onPermissionRequest: async () => ({
        feedback: 'Claudian is listing skills and runs no tool.',
        kind: 'reject',
      }),
      onUserInputRequest: async () => ({ answer: '', wasFreeform: true }),
      resources: { mcpServers: {}, skillDirectories },
      systemMessage: { content: 'Listing Copilot skills.', mode: 'replace' },
      workingDirectory,
    });
    const failures: unknown[] = [];
    let commands: readonly SlashCommand[] = [];
    try {
      signal?.throwIfAborted();
      const listed = await session.listSkillCommands();
      signal?.throwIfAborted();
      commands = listed.map(command => ({
        ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
        ...(command.description ? { description: command.description } : {}),
        content: '',
        id: `copilot-skill-${command.name}`,
        kind: 'skill' as const,
        name: command.name,
        source: 'sdk' as const,
        userInvocable: true,
      }));
    } catch (error) {
      failures.push(error);
    }
    for (const [step, release] of [
      ['disconnecting the skill metadata session', () => session.disconnect()],
      ['deleting the skill metadata session', async () => {
        await client.deleteSession(session.sessionId);
      }],
    ] as const) {
      const outcome = await settleNativeWithin(release());
      if (outcome.kind === 'rejected') {
        failures.push(outcome.error);
      } else if (outcome.kind === 'timed-out') {
        failures.push(copilotNativeSilenceError(step));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Could not complete the Copilot skill metadata session.');
    }
    return [...commands];
  }
}
