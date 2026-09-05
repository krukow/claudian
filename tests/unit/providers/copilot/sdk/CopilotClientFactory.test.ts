import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { CopilotClientIdentity } from '@/providers/copilot/sdk/CopilotClientFactory';
import { CopilotClientFactory } from '@/providers/copilot/sdk/CopilotClientFactory';
import type {
  CopilotSdkClient,
  CopilotSdkRuntime,
} from '@/providers/copilot/sdk/CopilotSdkPort';
import { parsePathEntries } from '@/utils/path';

const VAULT_PATH = '/vault';

/** The two shapes the SDK launches: a native binary, and a script it starts through Node. */
const NATIVE_CLI = '/usr/local/bin/copilot';
const JAVASCRIPT_CLI = '/opt/npm/node_modules/@github/copilot/npm-loader.js';

function createHost(cliPath: string, settings: Record<string, unknown>): ProviderHost {
  return {
    app: { vault: { adapter: { basePath: VAULT_PATH } } },
    getResolvedProviderCliPath: async () => cliPath,
    settings,
  } as unknown as ProviderHost;
}

/** The vault-configured environment boxes a PATH entry can be typed into. */
const CONFIGURED_PATH_SETTINGS: ReadonlyArray<[string, Record<string, unknown>]> = [
  ['the shared box', { sharedEnvironmentVariables: 'PATH=/attacker/bin' }],
  ['the Copilot box', {
    providerConfigs: { copilot: { environmentVariables: 'PATH=/attacker/bin' } },
  }],
];

/**
 * The CLI launches through `process.execPath`, and resolves everything else it runs — Git,
 * a shell, the tools a turn calls — against the PATH it is handed. A PATH entry typed into
 * the vault would therefore choose the executables a signed-in CLI runs, so the runtime
 * PATH is built only from the host process and the CLI Claudian resolved.
 */
describe('CopilotClientFactory runtime PATH', () => {
  it.each(CONFIGURED_PATH_SETTINGS)(
    'never carries a PATH configured in %s to a native CLI',
    async (_name, settings) => {
      const identity = await new CopilotClientFactory(createHost(NATIVE_CLI, settings))
        .resolveIdentity(VAULT_PATH);

      expect(parsePathEntries(identity.environment.PATH)).not.toContain('/attacker/bin');
    },
  );

  /**
   * A JavaScript entry is started through Node, so a configured PATH would also choose the
   * interpreter and the modules that entry reaches for.
   */
  it.each(CONFIGURED_PATH_SETTINGS)(
    'never carries a PATH configured in %s to a JavaScript npm launcher',
    async (_name, settings) => {
      const identity = await new CopilotClientFactory(createHost(JAVASCRIPT_CLI, settings))
        .resolveIdentity(VAULT_PATH);

      expect(parsePathEntries(identity.environment.PATH)).not.toContain('/attacker/bin');
      expect(identity.environment.ELECTRON_RUN_AS_NODE).toBe('1');
    },
  );

  /**
   * Obsidian starts with a minimal PATH, so the CLI still needs the locations a GUI app
   * does not inherit — Homebrew, nvm, and the rest of the host's own resolution. Refusing
   * a configured PATH removes an attacker-chosen entry, not the discovery every install
   * depends on.
   */
  it('keeps the host process PATH the CLI is discovered through', async () => {
    const identity = await new CopilotClientFactory(
      createHost(NATIVE_CLI, { sharedEnvironmentVariables: 'PATH=/attacker/bin' }),
    ).resolveIdentity(VAULT_PATH);
    const resolved = parsePathEntries(identity.environment.PATH);

    for (const entry of parsePathEntries(process.env.PATH ?? '')) {
      expect(resolved).toContain(entry);
    }
  });

  /**
   * The allow-list still decides everything else, so refusing PATH must not refuse the
   * locale entries it names.
   */
  it('still carries the configured entries the allow-list names', async () => {
    const identity = await new CopilotClientFactory(createHost(NATIVE_CLI, {
      sharedEnvironmentVariables: 'PATH=/attacker/bin\nLANG=en_US.UTF-8',
    })).resolveIdentity(VAULT_PATH);

    expect(identity.environment.LANG).toBe('en_US.UTF-8');
  });

  /**
   * Routing and TLS trust are host settings, not vault settings: a proxy or CA typed into
   * the vault would decide where an already-signed-in CLI sends its requests and which
   * certificates it accepts.
   */
  it('never carries a configured proxy or certificate authority', async () => {
    const identity = await new CopilotClientFactory(createHost(NATIVE_CLI, {
      sharedEnvironmentVariables:
        'HTTPS_PROXY=http://attacker:8080\nNODE_EXTRA_CA_CERTS=/vault/attacker.pem',
    })).resolveIdentity(VAULT_PATH);

    expect(identity.environment.HTTPS_PROXY).not.toBe('http://attacker:8080');
    expect(identity.environment.NODE_EXTRA_CA_CERTS).not.toBe('/vault/attacker.pem');
  });
});

/** The client surface the factory drives between creating one and handing it back. */
class FakeStartedClient {
  forceStopped = 0;
  stopped = 0;

  async forceStop(): Promise<void> {
    this.forceStopped += 1;
  }

  async getAuthStatus(): Promise<{ isAuthenticated: boolean }> {
    return { isAuthenticated: true };
  }

  async stop(): Promise<Error[]> {
    this.stopped += 1;
    return [];
  }
}

const COLD_START_IDENTITY: CopilotClientIdentity = {
  baseDirectory: '/state/copilot',
  cliPath: NATIVE_CLI,
  environment: {},
  workingDirectory: VAULT_PATH,
};

/**
 * The factory bounds the create as well, so that a runtime which never answers is not
 * left holding a client nobody can reach. That bound has to be the same startup budget
 * the runtime uses, or it cuts the cold start the runtime is still waiting out.
 */
describe('CopilotClientFactory startup budget', () => {
  it('waits out a cold start that outlasts the cleanup budget', async () => {
    jest.useFakeTimers();
    try {
      const client = new FakeStartedClient();
      let finishStart!: () => void;
      const runtime: CopilotSdkRuntime = {
        createClient: () => new Promise<CopilotSdkClient>(resolve => {
          finishStart = () => { resolve(client as unknown as CopilotSdkClient); };
        }),
      };

      const creating = new CopilotClientFactory(createHost(NATIVE_CLI, {}), { runtime })
        .createClient(COLD_START_IDENTITY)
        .then(
          (started): CopilotSdkClient | Error => started,
          (error: unknown) => error as Error,
        );
      await jest.advanceTimersByTimeAsync(10_000);
      finishStart();
      await jest.advanceTimersByTimeAsync(0);

      expect(await creating).not.toBeInstanceOf(Error);
      expect(client.forceStopped).toBe(0);
      expect(client.stopped).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
