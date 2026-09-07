import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as CopilotSdk from '@github/copilot-sdk';

import { CopilotCliResolver } from '@/providers/copilot/runtime/CopilotCliResolver';
import { buildCopilotRuntimeEnvironment } from '@/providers/copilot/runtime/CopilotRuntimeEnvironment';
import type {
  CopilotSdkClient,
  CopilotSdkPermissionRequest,
  CopilotSdkPermissionResult,
  CopilotSdkSessionConfig,
} from '@/providers/copilot/sdk/CopilotSdkPort';
import { copilotSdkRuntime } from '@/providers/copilot/sdk/CopilotSdkRuntime';

import { type LocalModelServer, startLocalModelServer } from './native-fixtures/LocalModelServer';

let mockModelProvider: CopilotSdk.SessionConfig['provider'];

// Only the external model endpoint is replaced; SDK transport and native sessions stay real.
jest.mock('@github/copilot-sdk', () => {
  const actual = jest.requireActual<typeof CopilotSdk>('@github/copilot-sdk');
  return {
    ...actual,
    CopilotClient: class extends actual.CopilotClient {
      override createSession(config: CopilotSdk.SessionConfig) {
        return super.createSession(mockModelProvider
          ? { ...config, provider: mockModelProvider }
          : config);
      }

      override resumeSession(sessionId: string, config: CopilotSdk.ResumeSessionConfig) {
        return super.resumeSession(sessionId, mockModelProvider
          ? { ...config, provider: mockModelProvider }
          : config);
      }
    },
  };
});

// An explicit path keeps npm's development-only bundled CLI out of this native check.
const configuredCliPath = process.env.CLAUDIAN_COPILOT_RESOURCE_SMOKE_CLI_PATH?.trim() ?? '';
const describeWithCli = configuredCliPath ? describe : describe.skip;
const fixtureScript = path.join(__dirname, 'native-fixtures', 'ResourceMcpServer.mjs');

describeWithCli('Copilot native resource isolation', () => {
  jest.setTimeout(90_000);

  let root = '';
  let vault = '';
  let home = '';
  let nativeCliPath = '';
  let client: CopilotSdkClient | undefined;
  let modelServer: LocalModelServer | undefined;

  beforeEach(() => {
    const cliPath = new CopilotCliResolver().resolve(undefined, configuredCliPath, '');
    if (!cliPath) {
      throw new Error('The configured Copilot smoke CLI could not be resolved.');
    }
    nativeCliPath = cliPath;
    root = mkdtempSync(path.join(os.tmpdir(), 'claudian-resource-smoke-'));
    vault = path.join(root, 'vault');
    home = path.join(root, 'home');
    mkdirSync(vault);
    mkdirSync(home);
  });

  async function startClient(): Promise<CopilotSdkClient> {
    client = await copilotSdkRuntime.createClient({
      baseDirectory: home,
      cliPath: nativeCliPath,
      environment: {
        ...buildCopilotRuntimeEnvironment({
          baseDirectory: home,
          cliPath: nativeCliPath,
          providerEnvironment: {},
          trustedPath: path.dirname(process.execPath),
        }),
        COPILOT_AUTO_UPDATE: 'false',
        COPILOT_DISABLE_KEYTAR: '1',
        HOME: home,
        NO_COLOR: '1',
        USERPROFILE: home,
      },
      workingDirectory: vault,
    });
    return client;
  }

  async function useLocalModel(toolCallName?: string): Promise<LocalModelServer> {
    const started = await startLocalModelServer(toolCallName);
    modelServer = started;
    mockModelProvider = {
      apiKey: 'synthetic-only',
      baseUrl: started.baseUrl,
      type: 'openai',
      wireApi: 'completions',
    };
    return started;
  }

  afterEach(async () => {
    const cleanup = await Promise.allSettled([client?.stop(), modelServer?.close()]);
    client = undefined;
    modelServer = undefined;
    mockModelProvider = undefined;
    const failures: unknown[] = cleanup.flatMap(result => (
      result.status === 'rejected' ? [result.reason] : []
    ));
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Native resource smoke cleanup failed.');
    }
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = '';
    }
  });

  it('starts only the selected server, not home or workspace MCP definitions', async () => {
    const selectedMarker = path.join(root, 'selected.started');
    const homeMarker = path.join(root, 'home.started');
    const workspaceMarker = path.join(root, 'workspace.started');
    writeFileSync(path.join(home, 'mcp-config.json'), JSON.stringify({
      mcpServers: { 'unselected-home': fixtureServer(homeMarker, vault) },
    }));
    writeFileSync(path.join(vault, '.mcp.json'), JSON.stringify({
      mcpServers: { 'unselected-workspace': fixtureServer(workspaceMarker, vault) },
    }));

    const config = {
      ...sessionConfig(vault),
      resources: {
        mcpServers: { selected: fixtureServer(selectedMarker, vault) },
        skillDirectories: [],
      },
    };
    const started = await startClient();
    await started.createSession(config);
    await waitForMarker(selectedMarker);

    expect(existsSync(homeMarker)).toBe(false);
    expect(existsSync(workspaceMarker)).toBe(false);
    expect(existsSync(selectedMarker)).toBe(true);
  });

  it('lists only the selected skill package without enabling MCP servers', async () => {
    const skillsRoot = path.join(root, 'skills');
    const selectedPath = writeSkillPackage(skillsRoot, 'native-selected');
    writeSkillPackage(skillsRoot, 'native-sibling');
    writeSkillPackage(path.join(vault, '.github', 'skills'), 'native-workspace');
    writeSkillPackage(path.join(home, 'skills'), 'native-home');
    writeSkillPackage(path.join(home, '.agents', 'skills'), 'native-personal');
    const homeMarker = path.join(root, 'home.started');
    writeFileSync(path.join(home, 'mcp-config.json'), JSON.stringify({
      mcpServers: { 'unselected-home': fixtureServer(homeMarker, vault) },
    }));

    const started = await startClient();
    const session = await started.createSession({
      ...sessionConfig(vault),
      resources: {
        mcpServers: {},
        skillDirectories: [path.dirname(selectedPath)],
      },
    });
    const commands = await session.listSkillCommands();

    expect(commands.map(command => command.name)).toEqual(['native-selected']);
    expect(existsSync(homeMarker)).toBe(false);
  });

  it('keeps a resource-free session free of home MCP and skill configuration', async () => {
    const homeMarker = path.join(root, 'home.started');
    writeFileSync(path.join(home, 'mcp-config.json'), JSON.stringify({
      mcpServers: { 'unselected-home': fixtureServer(homeMarker, vault) },
    }));
    writeSkillPackage(path.join(home, 'skills'), 'native-home');
    writeSkillPackage(path.join(vault, '.github', 'skills'), 'native-workspace');

    const started = await startClient();
    const session = await started.createSession(sessionConfig(vault));

    expect(await session.listSkillCommands()).toEqual([]);
    expect(existsSync(homeMarker)).toBe(false);
  });

  it('clears and replaces selected MCP servers on cold resume', async () => {
    const localModel = await useLocalModel();
    const firstMarker = path.join(root, 'first.started');
    const replacementMarker = path.join(root, 'replacement.started');
    const homeMarker = path.join(root, 'home.started');
    writeFileSync(path.join(home, 'mcp-config.json'), JSON.stringify({
      mcpServers: { 'unselected-home': fixtureServer(homeMarker, vault) },
    }));
    const output: string[] = [];
    const config: CopilotSdkSessionConfig = {
      ...sessionConfig(vault),
      model: 'gpt-4o',
      onEvent: (event) => {
        if (event.type === 'assistant.message') {
          output.push(event.data.content);
        }
      },
    };
    const first = await startClient();
    const session = await first.createSession({
      ...config,
      resources: {
        mcpServers: { first: fixtureServer(firstMarker, vault) },
        skillDirectories: [],
      },
    });
    await session.send('Return the synthetic completion exactly.');
    expect(output).toEqual(['Synthetic local completion.']);
    expect(existsSync(firstMarker)).toBe(true);
    expect(readFileSync(firstMarker, 'utf8')).toBe('started\n');
    await first.stop();
    client = undefined;

    const second = await startClient();
    await second.resumeSession(session.sessionId, config);
    await second.stop();
    client = undefined;
    expect(readFileSync(firstMarker, 'utf8')).toBe('started\n');
    expect(existsSync(homeMarker)).toBe(false);

    const third = await startClient();
    await third.resumeSession(session.sessionId, {
      ...config,
      resources: {
        mcpServers: { replacement: fixtureServer(replacementMarker, vault) },
        skillDirectories: [],
      },
    });
    await waitForMarker(replacementMarker);
    expect(readFileSync(firstMarker, 'utf8')).toBe('started\n');
    expect(readFileSync(replacementMarker, 'utf8')).toBe('started\n');
    expect(existsSync(homeMarker)).toBe(false);
    expect(localModel.completionRequests).toHaveLength(1);
  });

  it('persists a native session through the full production adapter', async () => {
    const localModel = await useLocalModel();
    const config = { ...sessionConfig(vault), model: 'gpt-4o' };
    const first = await startClient();
    const session = await first.createSession(config);
    await session.send('Return the synthetic completion exactly.');
    await first.stop();
    client = undefined;

    const second = await startClient();
    const resumed = await second.resumeSession(session.sessionId, config);

    expect(resumed.sessionId).toBe(session.sessionId);
    expect(localModel.completionRequests).toHaveLength(1);
  });

  it.each([
    { decision: 'approve-once', marker: 'started\nwrite_note\n' },
    { decision: 'reject', marker: 'started\n' },
  ] as const)('honors $decision for a selected native MCP tool', async ({ decision, marker }) => {
    const localModel = await useLocalModel('selected-write_note');
    const selectedMarker = path.join(root, 'selected.started');
    const permissions: CopilotSdkPermissionRequest[] = [];
    const started = await startClient();
    const session = await started.createSession({
      ...sessionConfig(vault),
      availableTools: ['builtin:view'],
      model: 'gpt-4o',
      onPermissionRequest: async (request): Promise<CopilotSdkPermissionResult> => {
        permissions.push(request);
        return { kind: decision };
      },
      resources: {
        mcpServers: {
          selected: { ...fixtureServer(selectedMarker, vault), tools: ['write_note'] },
        },
        skillDirectories: [],
      },
    });
    await session.send('Use the selected server to update the synthetic note.');

    expect(session.resourceDiagnostics).toEqual([]);
    expect(permissions).toEqual([
      expect.objectContaining({
        kind: 'mcp', serverName: 'selected', toolName: 'selected-write_note',
      }),
    ]);
    expect(readFileSync(selectedMarker, 'utf8')).toBe(marker);
    const request = JSON.parse(localModel.completionRequests[0]) as {
      tools: Array<{ function: { name: string } }>;
    };
    expect(request.tools.map(tool => tool.function.name).sort())
      .toEqual(['selected-write_note', 'view']);
  });

  it('submits the native skill expansion rather than plain slash text', async () => {
    const localModel = await useLocalModel();
    const skillPath = writeSkillPackage(path.join(root, 'skills'), 'native-selected');
    const started = await startClient();
    const session = await started.createSession({
      ...sessionConfig(vault),
      model: 'gpt-4o',
      resources: { mcpServers: {}, skillDirectories: [path.dirname(skillPath)] },
    });
    const invocation = await session.invokeSkillCommand('native-selected', 'synthetic argument');
    if (invocation.kind !== 'prompt') {
      throw new Error('The selected skill did not return an agent prompt.');
    }
    await session.send(invocation.prompt);

    expect(invocation.displayPrompt).toContain('/native-selected');
    expect(localModel.completionRequests).toHaveLength(1);
    expect(localModel.completionRequests[0]).toContain('answer with the single word FIXTURE');
    expect(localModel.completionRequests[0]).toContain('synthetic argument');
  });
});

function sessionConfig(workingDirectory: string): CopilotSdkSessionConfig {
  return {
    availableTools: [],
    model: 'gpt-5.4-mini',
    onEvent: () => {},
    onPermissionRequest: async () => ({ kind: 'reject' }),
    onUserInputRequest: async () => {
      throw new Error('The metadata smoke must not request user input.');
    },
    systemMessage: { content: 'Synthetic metadata inspection only.', mode: 'replace' },
    workingDirectory,
  };
}

function fixtureServer(marker: string, workingDirectory: string) {
  return {
    args: [fixtureScript],
    command: process.execPath,
    env: { CLAUDIAN_SMOKE_MARKER: marker },
    tools: ['read_note'],
    type: 'stdio' as const,
    workingDirectory,
  };
}

function writeSkillPackage(root: string, name: string): string {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  const skillPath = path.join(directory, 'SKILL.md');
  writeFileSync(skillPath, [
    '---',
    `name: ${name}`,
    'description: A synthetic native resource fixture.',
    '---',
    '',
    'When invoked, answer with the single word FIXTURE.',
    '',
  ].join('\n'));
  return skillPath;
}

async function waitForMarker(marker: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(marker) && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
}
