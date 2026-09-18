import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CopilotCliResolver } from '@/providers/copilot/runtime/CopilotCliResolver';
import { buildCopilotRuntimeEnvironment } from '@/providers/copilot/runtime/CopilotRuntimeEnvironment';
import type { CopilotSdkClient, CopilotSdkSessionConfig } from '@/providers/copilot/sdk/CopilotSdkPort';
import { copilotSdkRuntime } from '@/providers/copilot/sdk/CopilotSdkRuntime';

import { type OAuthMcpFixture, startOAuthMcpServer } from './native-fixtures/OAuthMcpServer';

const configuredCli = process.env.CLAUDIAN_COPILOT_RESOURCE_SMOKE_CLI_PATH?.trim() ?? '';
const describeNative = configuredCli ? describe : describe.skip;

describeNative('Copilot native selected MCP sign-in', () => {
  jest.setTimeout(120_000);
  let root = '';
  let fixture: OAuthMcpFixture | undefined;
  let client: CopilotSdkClient | undefined;

  afterEach(async () => {
    await client?.stop();
    await fixture?.close();
    client = undefined;
    fixture = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('signs in one selected loopback server and reuses its native cache on a new client', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'claudian-mcp-oauth-'));
    const home = path.join(root, 'home');
    const vault = path.join(root, 'vault');
    mkdirSync(home);
    mkdirSync(vault);
    fixture = await startOAuthMcpServer();
    const cliPath = new CopilotCliResolver().resolve(undefined, configuredCli, '');
    if (!cliPath) throw new Error('Configured native CLI could not be resolved.');
    const clientOptions = {
      baseDirectory: home,
      cliPath,
      environment: {
        ...buildCopilotRuntimeEnvironment({
          baseDirectory: home, cliPath, providerEnvironment: {},
          trustedPath: path.dirname(process.execPath),
        }),
        HOME: home,
        USERPROFILE: home,
        COPILOT_DISABLE_KEYTAR: '1',
      },
      workingDirectory: vault,
    };
    let connected = false;
    const config: CopilotSdkSessionConfig = {
      availableTools: [],
      model: 'gpt-5-mini',
      onEvent: event => {
        if (event.type === 'session.mcp_server_status_changed'
          && event.data.serverName === 'protected-fixture'
          && event.data.status === 'connected') connected = true;
      },
      onPermissionRequest: async () => ({ kind: 'reject' }),
      onUserInputRequest: async () => { throw new Error('The fixture cannot answer user questions.'); },
      resources: {
        mcpServers: { 'protected-fixture': { type: 'http', url: fixture.url } },
        mcpOAuthTokenStorage: 'persistent',
        skillDirectories: [],
      },
      systemMessage: { mode: 'replace', content: 'Synthetic MCP authentication only.' },
      workingDirectory: vault,
    };
    client = await copilotSdkRuntime.createClient(clientOptions);
    const session = await client.createSession(config);
    expect(await session.checkMcpServer('protected-fixture')).toEqual({ phase: 'needs-auth' });
    const login = await session.signInMcpServer('protected-fixture');
    if (!login.authorizationUrl) throw new Error('The fresh fixture did not request authorization.');
    expect(connected).toBe(false);
    await fixture.approve(login.authorizationUrl);
    const deadline = Date.now() + 15_000;
    while (!connected && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
    expect(connected).toBe(true);
    expect(fixture.tokenExchanges).toBe(1);
    expect(await session.checkMcpServer('protected-fixture')).toEqual({
      phase: 'connected', toolCount: 1,
    });
    await client.stop();
    client = undefined;

    client = await copilotSdkRuntime.createClient(clientOptions);
    const next = await client.createSession(config);
    expect(next.resourceDiagnostics).toEqual([]);
    expect(await next.checkMcpServer('protected-fixture')).toEqual({
      phase: 'connected', toolCount: 1,
    });
    expect(await next.signInMcpServer('protected-fixture')).toEqual({});
    expect(fixture.tokenExchanges).toBe(1);
  });
});
