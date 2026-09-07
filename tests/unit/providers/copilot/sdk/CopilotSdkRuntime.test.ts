import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CopilotClientOptions, SessionConfig } from '@github/copilot-sdk';

import type {
  CopilotSdkClient,
  CopilotSdkSession,
  CopilotSdkSessionConfig,
} from '@/providers/copilot/sdk/CopilotSdkPort';
import { copilotSdkRuntime } from '@/providers/copilot/sdk/CopilotSdkRuntime';

/** The SDK session surface the wrapper drives, with only the turn controls under test. */
class FakeSdkCopilotSession {
  static readonly instances: FakeSdkCopilotSession[] = [];
  aborted = 0;
  disconnected = 0;
  readonly disabledSkills: string[] = [];
  readonly invocations: Array<{ input?: string; name: string }> = [];
  readonly optionUpdates: Array<Record<string, unknown>> = [];
  serverListings = 0;
  readonly toolListings: string[] = [];

  constructor(readonly sessionId: string) {
    FakeSdkCopilotSession.instances.push(this);
  }

  readonly rpc = {
    commands: {
      invoke: async (params: { input?: string; name: string }) => {
        this.invocations.push(params);
        return FakeSdkCopilotClient.behavior.invokeCommand?.(params)
          ?? { displayPrompt: `/${params.name}`, kind: 'agent-prompt', prompt: 'expanded' };
      },
      list: async () => ({ commands: FakeSdkCopilotClient.behavior.commands ?? [] }),
    },
    mcp: {
      list: async () => {
        this.serverListings += 1;
        return FakeSdkCopilotClient.behavior.listServers?.(this.serverListings)
          ?? { servers: [] };
      },
      listTools: async (params: { serverName: string }) => {
        this.toolListings.push(params.serverName);
        return FakeSdkCopilotClient.behavior.listTools?.(params.serverName)
          ?? { tools: [] };
      },
    },
    options: {
      update: async (params: Record<string, unknown>) => {
        this.optionUpdates.push(params);
        await FakeSdkCopilotClient.behavior.updateOptions?.();
      },
    },
    skills: {
      disable: async (params: { name: string }) => {
        this.disabledSkills.push(params.name);
        await FakeSdkCopilotClient.behavior.disableSkill?.();
      },
      ensureLoaded: async () => { await FakeSdkCopilotClient.behavior.ensureSkills?.(); },
      list: async () => {
        await FakeSdkCopilotClient.behavior.listSkills?.();
        return { skills: FakeSdkCopilotClient.behavior.skills ?? [] };
      },
    },
  };

  async abort(): Promise<void> {
    this.aborted += 1;
    await FakeSdkCopilotClient.behavior.abort?.();
  }

  async disconnect(): Promise<void> {
    this.disconnected += 1;
    await FakeSdkCopilotClient.behavior.disconnect?.();
  }
}

/**
 * The real `@github/copilot-sdk` client, restated with only the shutdown surface these
 * tests exercise. `stop` resolves with the errors it could not recover from instead of
 * rejecting, which is the behaviour the wrapper has to account for.
 */
class FakeSdkCopilotClient {
  static readonly instances: FakeSdkCopilotClient[] = [];
  static behavior: {
    abort?: () => Promise<void>;
    commands?: Array<{ description?: string; kind: string; name: string }>;
    createSession?: () => Promise<FakeSdkCopilotSession>;
    deleteSession?: () => Promise<void>;
    disconnect?: () => Promise<void>;
    disableSkill?: () => Promise<void>;
    discoverMcp?: () => Promise<{ servers: Array<{ name: string }> }>;
    ensureSkills?: () => Promise<void>;
    invokeCommand?: (params: { input?: string; name: string }) => Promise<unknown>;
    listServers?: (attempt: number) => Promise<{
      host?: { failedServers?: Record<string, { message: string }> };
      servers: Array<{ error?: string; name: string; status: string }>;
    }>;
    listTools?: (serverName: string) => Promise<{ tools: Array<{ name: string }> }>;
    listSkills?: () => Promise<void>;
    resumeSession?: () => Promise<FakeSdkCopilotSession>;
    skills?: Array<{
      commandName?: string;
      name: string;
      path?: string;
      userInvocable?: boolean;
    }>;
    start?: () => Promise<void>;
    stop?: () => Promise<Error[]>;
    forceStop?: () => Promise<void>;
    updateOptions?: () => Promise<void>;
  } = {};

  forceStopped = 0;
  started = 0;
  stopped = 0;
  readonly discoveryRequests: Array<{ workingDirectory?: string }> = [];
  readonly sessionConfigs: SessionConfig[] = [];
  readonly deletedSessions: string[] = [];

  constructor(readonly options: CopilotClientOptions) {
    FakeSdkCopilotClient.instances.push(this);
  }

  readonly rpc = {
    mcp: {
      discover: async (params: { workingDirectory?: string }) => {
        this.discoveryRequests.push(params);
        return (await FakeSdkCopilotClient.behavior.discoverMcp?.()) ?? { servers: [] };
      },
    },
  };

  async start(): Promise<void> {
    this.started += 1;
    await FakeSdkCopilotClient.behavior.start?.();
  }

  async getAuthStatus(): Promise<{ isAuthenticated: boolean }> {
    return { isAuthenticated: true };
  }

  async createSession(config: SessionConfig): Promise<FakeSdkCopilotSession> {
    this.sessionConfigs.push(config);
    return (await FakeSdkCopilotClient.behavior.createSession?.())
      ?? new FakeSdkCopilotSession('copilot-session-1');
  }

  async resumeSession(
    sessionId: string,
    config: SessionConfig,
  ): Promise<FakeSdkCopilotSession> {
    this.sessionConfigs.push(config);
    return (await FakeSdkCopilotClient.behavior.resumeSession?.())
      ?? new FakeSdkCopilotSession(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deletedSessions.push(sessionId);
    await FakeSdkCopilotClient.behavior.deleteSession?.();
  }

  async stop(): Promise<Error[]> {
    this.stopped += 1;
    return (await FakeSdkCopilotClient.behavior.stop?.()) ?? [];
  }

  async forceStop(): Promise<void> {
    this.forceStopped += 1;
    await FakeSdkCopilotClient.behavior.forceStop?.();
  }
}

jest.mock('@/providers/copilot/sdk/copilotSdkModule', () => ({
  CopilotClient: FakeSdkCopilotClient,
  RuntimeConnection: { forStdio: (options: unknown) => options },
}));

/** A native call that never answers, used to prove the budget bounds it. */
function neverAnswers<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** Runs the body with fake timers, restoring real ones however it ends. */
async function withFakeTimers(body: () => Promise<void>): Promise<void> {
  jest.useFakeTimers();
  try {
    await body();
  } finally {
    jest.useRealTimers();
  }
}

async function createClient(): Promise<CopilotSdkClient> {
  return copilotSdkRuntime.createClient({
    baseDirectory: '/state/copilot',
    cliPath: '/usr/local/bin/copilot',
    environment: {},
    workingDirectory: '/vault',
  });
}

async function createSession(): Promise<CopilotSdkSession> {
  const client = await createClient();
  return client.createSession(sessionConfig());
}

function sessionConfig(
  overrides: Partial<CopilotSdkSessionConfig> = {},
): CopilotSdkSessionConfig {
  return {
    availableTools: [],
    model: 'gpt-5',
    onEvent: () => {},
    onPermissionRequest: async () => ({ kind: 'deny' } as never),
    onUserInputRequest: async () => ({} as never),
    systemMessage: { content: 'system', mode: 'replace' },
    workingDirectory: '/vault',
    ...overrides,
  } satisfies CopilotSdkSessionConfig;
}

beforeEach(() => {
  FakeSdkCopilotClient.instances.length = 0;
  FakeSdkCopilotSession.instances.length = 0;
  FakeSdkCopilotClient.behavior = {};
});

/**
 * The client is constructed in the SDK's `copilot-cli` defaulting mode, because
 * `mode: 'empty'` is the one thing that puts `COPILOT_DISABLE_KEYTAR=1` into the spawned
 * CLI's environment. With the keychain shut off the CLI never opens its credential store,
 * so the sign-in the user already performed is invisible to it and only the `gh` CLI or an
 * explicit token could answer the auth gate — neither of which Claudian promises or owns.
 *
 * Losing empty mode also loses every default it was supplying, so each of them is stated
 * here instead. The two contracts it enforced are stated too: a persistence location of
 * Claudian's own, checked in `createClient`, and an explicit tool list, required by the
 * port.
 */
describe('copilotSdkRuntime client construction', () => {
  it('constructs a keychain-capable client against the CLI it was handed', async () => {
    await copilotSdkRuntime.createClient({
      baseDirectory: '/state/copilot',
      cliPath: '/usr/local/bin/copilot',
      environment: { COPILOT_HOME: '/state/copilot' },
      workingDirectory: '/vault',
    });
    const options = FakeSdkCopilotClient.instances[0]?.options;

    expect(options).toMatchObject({
      baseDirectory: '/state/copilot',
      connection: { env: { COPILOT_HOME: '/state/copilot' }, path: '/usr/local/bin/copilot' },
      enableRemoteSessions: false,
      mode: 'copilot-cli',
      useLoggedInUser: true,
      workingDirectory: '/vault',
    });
  });

  /**
   * The mode that disables the keychain must not come back by accident, and Claudian owns
   * no credential of its own to fall back on: no token is ever handed to the SDK, so the
   * CLI's own sign-in is the only thing that can answer the auth gate.
   */
  it('never selects the mode that shuts the CLI out of its keychain', async () => {
    await createClient();
    const options = FakeSdkCopilotClient.instances[0]?.options;

    expect(options?.mode).not.toBe('empty');
    expect(options?.gitHubToken).toBeUndefined();
  });

  /**
   * An empty `baseDirectory` passes the SDK's own check, which only tests that one was
   * supplied, and then leaves `COPILOT_HOME` unset — so the CLI writes this vault's agent
   * state into the user's shared `~/.copilot`. No CLI is started for it.
   *
   * Outside empty mode the SDK makes no persistence check at all, so this is now the only
   * one there is.
   */
  it('refuses a client with no data directory of its own', async () => {
    await expect(copilotSdkRuntime.createClient({
      baseDirectory: '',
      cliPath: '/usr/local/bin/copilot',
      environment: {},
      workingDirectory: '/vault',
    })).rejects.toThrow(/COPILOT_HOME/);
    expect(FakeSdkCopilotClient.instances).toEqual([]);
  });

  /**
   * The SDK spawns the CLI with the vault as its working directory, so a relative
   * `baseDirectory` is resolved against vault content: this vault's agent state would be
   * written into the notes `COPILOT_HOME` exists to keep it out of, and would be indexed,
   * synced, and shared with them. The last place that can tell is here, before a CLI is
   * started against it.
   */
  it.each(['state/copilot', './state/copilot', '../state', 'copilot'])(
    'refuses the relative data directory %j',
    async (baseDirectory) => {
      await expect(copilotSdkRuntime.createClient({
        baseDirectory,
        cliPath: '/usr/local/bin/copilot',
        environment: {},
        workingDirectory: '/vault',
      })).rejects.toThrow(/COPILOT_HOME/);
      expect(FakeSdkCopilotClient.instances).toEqual([]);
    },
  );

  it('opts every created and resumed session into an explicit tool list', async () => {
    const client = await createClient();
    await client.createSession(sessionConfig());
    await client.resumeSession(
      'copilot-session-1',
      sessionConfig({ availableTools: ['builtin:view'] }),
    );

    expect(FakeSdkCopilotClient.instances[0]?.sessionConfigs.map(
      config => config.availableTools,
    )).toEqual([[], ['builtin:view']]);
  });

  /**
   * The SDK refuses a session that named no tools, so the port requires the list rather
   * than leaving a later consumer free to omit it and find out at runtime. This only
   * compiles while `availableTools` is a mandatory key.
   */
  it('leaves no consumer able to omit the tool list', () => {
    const mandatory: MandatoryKey<CopilotSdkSessionConfig> = 'availableTools';

    expect(mandatory).toBe('availableTools');
  });
});

/**
 * What `mode: 'empty'` was supplying on Claudian's behalf, quoted from the SDK's own
 * `configDefaultsForMode`, `experimentalModeForMode`, and `updateSessionOptionsForMode`,
 * plus the discovery sources those defaults leave to the session.
 *
 * Outside empty mode none of it is supplied, and the runtime's own defaults are the
 * opposite for several: session telemetry is on, the embedding cache is shared on disk,
 * MCP OAuth tokens are written to the OS keychain, and the commit co-author trailer is
 * added. So every entry is now sent by Claudian with each create and resume.
 */
const COPILOT_SESSION_FLOOR: Readonly<Record<string, unknown>> = {
  coauthorEnabled: false,
  customAgentsLocalOnly: true,
  embeddingCacheStorage: 'in-memory',
  enableConfigDiscovery: false,
  enableExperimentalMode: false,
  enableFileHooks: false,
  enableHostGitOperations: false,
  enableMcpApps: false,
  enableOnDemandInstructionDiscovery: false,
  enableSessionStore: false,
  enableSessionTelemetry: false,
  enableSkills: false,
  includeSubAgentStreamingEvents: false,
  infiniteSessions: { enabled: false },
  manageScheduleEnabled: false,
  mcpOAuthTokenStorage: 'in-memory',
  mcpServers: {},
  memory: { enabled: false },
  pluginDirectories: [],
  remoteSession: 'off',
  skipCustomInstructions: true,
  skipEmbeddingRetrieval: true,
};

/** The floor fields a caller must not be able to reach, and so weaken, through the port. */
type CopilotSessionFloorField =
  | 'clientName'
  | 'coauthorEnabled'
  | 'configDirectory'
  | 'customAgents'
  | 'customAgentsLocalOnly'
  | 'embeddingCacheStorage'
  | 'enableConfigDiscovery'
  | 'enableExperimentalMode'
  | 'enableFileHooks'
  | 'enableHostGitOperations'
  | 'enableMcpApps'
  | 'enableOnDemandInstructionDiscovery'
  | 'enableSessionStore'
  | 'enableSessionTelemetry'
  | 'enableSkills'
  | 'gitHubToken'
  | 'hooks'
  | 'infiniteSessions'
  | 'instructionDirectories'
  | 'manageScheduleEnabled'
  | 'mcpOAuthTokenStorage'
  | 'mcpServers'
  | 'memory'
  | 'pluginDirectories'
  | 'remoteSession'
  | 'skillDirectories'
  | 'skipCustomInstructions'
  | 'skipEmbeddingRetrieval';

describe('copilotSdkRuntime session floor', () => {
  it.each([
    ['a created session', async (client: CopilotSdkClient) => {
      await client.createSession(sessionConfig());
    }],
    ['a resumed session', async (client: CopilotSdkClient) => {
      await client.resumeSession('copilot-session-1', sessionConfig());
    }],
  ])('states every capability empty mode used to default for %s', async (_name, open) => {
    const client = await createClient();
    await open(client);
    const config = FakeSdkCopilotClient.instances[0]?.sessionConfigs[0];

    expect(config).toMatchObject(COPILOT_SESSION_FLOOR);
  });

  /**
   * Empty mode stripped the runtime's `environment_context` section from every system
   * message it did not fully replace, so the host the CLI runs on never reached the
   * prompt. `append` no longer does that on its own, so the removal is asked for by name.
   */
  it('keeps the host out of an appended system message', async () => {
    const client = await createClient();
    await client.createSession(sessionConfig({
      systemMessage: { content: 'claudian', mode: 'append' },
    }));

    expect(FakeSdkCopilotClient.instances[0]?.sessionConfigs[0]?.systemMessage).toEqual({
      content: 'claudian',
      mode: 'customize',
      sections: { environment_context: { action: 'remove' } },
    });
  });

  /** A replaced system message has no runtime sections left to strip. */
  it('sends a replaced system message as it was given', async () => {
    const client = await createClient();
    await client.createSession(sessionConfig({
      systemMessage: { content: 'claudian', mode: 'replace' },
    }));

    expect(FakeSdkCopilotClient.instances[0]?.sessionConfigs[0]?.systemMessage).toEqual({
      content: 'claudian',
      mode: 'replace',
    });
  });

  /**
   * The floor is Claudian's, not the caller's: a later execution layer chooses tools, a
   * model, and directories, and cannot reach any switch that would let a session read the
   * user's global Copilot configuration or act outside the vault. This only compiles while
   * none of those fields exists on the port.
   */
  it('leaves no consumer able to weaken the floor', () => {
    type NoFloorFieldIsReachable =
      Extract<keyof CopilotSdkSessionConfig, CopilotSessionFloorField> extends never
        ? true
        : false;
    const proven: NoFloorFieldIsReachable = true;

    expect(proven).toBe(true);
  });
});

/** The keys of `T` a caller has to supply, as opposed to those it may leave out. */
type MandatoryKey<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];

describe('copilotSdkRuntime client shutdown', () => {
  it('reports a clean shutdown without forcing the process down', async () => {
    const client = await createClient();

    await expect(client.stop()).resolves.toBeUndefined();
    expect(FakeSdkCopilotClient.instances[0]?.stopped).toBe(1);
    expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(0);
  });

  it('forces the process down and surfaces the errors a stop reported', async () => {
    FakeSdkCopilotClient.behavior.stop = async () => [
      new Error('a session would not close'),
      new Error('the connection stayed open'),
    ];
    const client = await createClient();

    await expect(client.stop()).rejects.toThrow(/a session would not close/);
    expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(1);
  });

  it('reports every error a stop left behind', async () => {
    FakeSdkCopilotClient.behavior.stop = async () => [
      new Error('a session would not close'),
      new Error('the connection stayed open'),
    ];
    const client = await createClient();
    const failure = await client.stop().then(
      () => new Error('the stop unexpectedly succeeded'),
      (error: unknown) => error as Error,
    );

    expect(failure.message).toContain('a session would not close');
    expect(failure.message).toContain('the connection stayed open');
  });

  it('forces the process down when the graceful stop rejects', async () => {
    FakeSdkCopilotClient.behavior.stop = async () => {
      throw new Error('the CLI never answered the shutdown');
    };
    const client = await createClient();

    await expect(client.stop()).rejects.toThrow(/never answered the shutdown/);
    expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(1);
  });

  it('reports the graceful failure when the forced stop fails too', async () => {
    FakeSdkCopilotClient.behavior.stop = async () => {
      throw new Error('the CLI never answered the shutdown');
    };
    FakeSdkCopilotClient.behavior.forceStop = async () => {
      throw new Error('the process could not be killed');
    };
    const client = await createClient();

    await expect(client.stop()).rejects.toThrow(/never answered the shutdown/);
  });

  it('forces down a client nobody can be told about when its start fails', async () => {
    FakeSdkCopilotClient.behavior.start = async () => {
      throw new Error('the CLI refused the handshake');
    };

    await expect(createClient()).rejects.toThrow(/refused the handshake/);
    expect(FakeSdkCopilotClient.instances[0]?.stopped).toBe(1);
    expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(1);
  });

  it('keeps the start failure when the abandoned client cannot be stopped', async () => {
    FakeSdkCopilotClient.behavior.start = async () => {
      throw new Error('the CLI refused the handshake');
    };
    FakeSdkCopilotClient.behavior.stop = async () => {
      throw new Error('the shutdown failed too');
    };
    FakeSdkCopilotClient.behavior.forceStop = async () => {
      throw new Error('the process could not be killed');
    };

    await expect(createClient()).rejects.toThrow(/refused the handshake/);
    expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(1);
  });
});

/**
 * A shutdown is a native call like an abort or a disconnect: the CLI answers, or it does
 * not. A `stop` that never answers would hold cancellation, failure recovery, disposal,
 * or the model-discovery probe open for as long as the CLI stays silent, so it runs under
 * the same budget every other release does.
 */
describe('copilotSdkRuntime shutdown budget', () => {
  it('forces the process down when the graceful stop never answers', async () => {
    await withFakeTimers(async () => {
      FakeSdkCopilotClient.behavior.stop = () => neverAnswers<Error[]>();
      const client = await createClient();

      const stopping = client.stop().then(
        () => new Error('the stop unexpectedly succeeded'),
        (error: unknown) => error as Error,
      );
      await jest.advanceTimersByTimeAsync(10_000);

      expect((await stopping).message).toMatch(/did not shut down within/);
      expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(1);
    });
  });

  it('reports the shutdown when the forced stop never answers either', async () => {
    await withFakeTimers(async () => {
      FakeSdkCopilotClient.behavior.stop = () => neverAnswers<Error[]>();
      FakeSdkCopilotClient.behavior.forceStop = () => neverAnswers<void>();
      const client = await createClient();

      const stopping = client.stop().then(
        () => new Error('the stop unexpectedly succeeded'),
        (error: unknown) => error as Error,
      );
      await jest.advanceTimersByTimeAsync(30_000);

      expect((await stopping).message).toMatch(/did not shut down within/);
    });
  });

  it('bounds a forced stop asked for on its own', async () => {
    await withFakeTimers(async () => {
      FakeSdkCopilotClient.behavior.forceStop = () => neverAnswers<void>();
      const client = await createClient();

      const forcing = client.forceStop().then(
        () => new Error('the forced stop unexpectedly succeeded'),
        (error: unknown) => error as Error,
      );
      await jest.advanceTimersByTimeAsync(10_000);

      expect((await forcing).message).toMatch(/did not shut down within/);
    });
  });

  /**
   * A client whose start failed is handed to nobody, so nothing can check on it later.
   * A shutdown that never answers must not hold client creation open instead.
   */
  it('abandons a client whose start failed and whose stop never answers', async () => {
    await withFakeTimers(async () => {
      FakeSdkCopilotClient.behavior.start = async () => {
        throw new Error('the CLI refused the handshake');
      };
      FakeSdkCopilotClient.behavior.stop = () => neverAnswers<Error[]>();
      FakeSdkCopilotClient.behavior.forceStop = () => neverAnswers<void>();

      const creating = createClient().then(
        () => new Error('the client unexpectedly started'),
        (error: unknown) => error as Error,
      );
      await jest.advanceTimersByTimeAsync(30_000);

      expect((await creating).message).toMatch(/refused the handshake/);
      expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(1);
    });
  });

  /**
   * A CLI that answers after the budget has elapsed has no caller left to tell. The
   * answer is absorbed rather than replacing the failure the caller was already given,
   * and rather than surfacing as an unhandled rejection.
   */
  it('absorbs a shutdown that answers after the budget', async () => {
    await withoutUnhandledRejections(async () => {
      await withFakeTimers(async () => {
        let rejectStop!: (error: unknown) => void;
        FakeSdkCopilotClient.behavior.stop = () => new Promise<Error[]>((_resolve, reject) => {
          rejectStop = reject;
        });
        const client = await createClient();

        const stopping = client.stop().then(
          () => new Error('the stop unexpectedly succeeded'),
          (error: unknown) => error as Error,
        );
        await jest.advanceTimersByTimeAsync(10_000);
        const failure = await stopping;
        rejectStop(new Error('the CLI answered far too late'));
        await jest.advanceTimersByTimeAsync(10_000);

        expect(failure.message).toMatch(/did not shut down within/);
        expect(failure.message).not.toMatch(/far too late/);
      });
    });
  });

  /**
   * The escalation is what actually ends the process, so it must be attempted, and
   * attempted once: a second kill for the same shutdown would be a second thing to report
   * about a runtime the caller was already told about.
   */
  it('escalates a shutdown that never answers exactly once', async () => {
    await withoutUnhandledRejections(async () => {
      await withFakeTimers(async () => {
        FakeSdkCopilotClient.behavior.stop = () => neverAnswers<Error[]>();
        const client = await createClient();

        const stopping = client.stop().then(() => undefined, () => undefined);
        await jest.advanceTimersByTimeAsync(30_000);
        await stopping;

        expect(FakeSdkCopilotClient.instances[0]?.stopped).toBe(1);
        expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(1);
      });
    });
  });

  /**
   * A client whose start failed is abandoned, so its late shutdown answer has nowhere to
   * go and must not surface as a rejection nobody handled.
   */
  it('absorbs the late answer of an abandoned client', async () => {
    await withoutUnhandledRejections(async () => {
      await withFakeTimers(async () => {
        let rejectStop!: (error: unknown) => void;
        FakeSdkCopilotClient.behavior.start = async () => {
          throw new Error('the CLI refused the handshake');
        };
        FakeSdkCopilotClient.behavior.stop = () => new Promise<Error[]>((_resolve, reject) => {
          rejectStop = reject;
        });
        FakeSdkCopilotClient.behavior.forceStop = () => neverAnswers<void>();

        const creating = createClient().then(
          () => new Error('the client unexpectedly started'),
          (error: unknown) => error as Error,
        );
        await jest.advanceTimersByTimeAsync(30_000);
        const failure = await creating;
        rejectStop(new Error('the CLI answered far too late'));
        await jest.advanceTimersByTimeAsync(10_000);

        expect(failure.message).toMatch(/refused the handshake/);
      });
    });
  });
});

/**
 * The start is the one native call made on the raw SDK client, before any caller has been
 * handed the wrapper around it. A bound outside this module cannot reach that client, so
 * a start that never answers has to be ended here or the CLI it spawned outlives the
 * vault with nothing left that could stop it.
 *
 * It is bounded on its own deadline rather than the one every release shares. Spawning a
 * CLI, waiting for its server, and agreeing a protocol version is not the same kind of
 * wait as letting go of a runtime that is already running, and `@github/copilot-sdk`
 * allows thirty seconds for its own half of it.
 */
describe('copilotSdkRuntime startup budget', () => {
  /**
   * A cold CLI on a slow disk routinely takes longer than any release is allowed to. The
   * budget that ends a start has to outlast that, or the first launch of the day is
   * reported as a CLI that went silent while it was still coming up.
   */
  it('waits out a cold start that outlasts the cleanup budget', async () => {
    await withoutUnhandledRejections(async () => {
      await withFakeTimers(async () => {
        let finishStart!: () => void;
        FakeSdkCopilotClient.behavior.start = () => new Promise<void>(resolve => {
          finishStart = resolve;
        });

        const creating = createClient().then(
          (client): CopilotSdkClient | Error => client,
          (error: unknown) => error as Error,
        );
        await jest.advanceTimersByTimeAsync(10_000);
        finishStart();
        await jest.advanceTimersByTimeAsync(0);

        expect(await creating).not.toBeInstanceOf(Error);
        expect(FakeSdkCopilotClient.instances[0]?.stopped).toBe(0);
        expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(0);
      });
    });
  });

  /** The startup budget is the SDK's own cold-start allowance, and it ends there. */
  it('holds a start open until the startup budget elapses', async () => {
    await withoutUnhandledRejections(async () => {
      await withFakeTimers(async () => {
        FakeSdkCopilotClient.behavior.start = () => neverAnswers<void>();
        let settled = false;

        const creating = createClient()
          .then(
            () => new Error('the client unexpectedly started'),
            (error: unknown) => error as Error,
          )
          .finally(() => { settled = true; });
        await jest.advanceTimersByTimeAsync(29_999);

        expect(settled).toBe(false);

        await jest.advanceTimersByTimeAsync(1);

        expect((await creating).message).toMatch(/did not answer within 30 seconds/);
      });
    });
  });

  /**
   * Raising the startup budget must not raise the one a release runs on: a runtime that
   * stopped answering a shutdown still has to be killed on the shorter deadline.
   */
  it('leaves the cleanup budget on its own deadline', async () => {
    await withoutUnhandledRejections(async () => {
      await withFakeTimers(async () => {
        FakeSdkCopilotClient.behavior.stop = () => neverAnswers<Error[]>();
        const client = await createClient();

        const stopping = client.stop().then(() => undefined, () => undefined);
        await jest.advanceTimersByTimeAsync(5_000);

        expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(1);

        await stopping;
      });
    });
  });

  it('terminates a client whose start never answers', async () => {
    await withoutUnhandledRejections(async () => {
      await withFakeTimers(async () => {
        FakeSdkCopilotClient.behavior.start = () => neverAnswers<void>();

        const creating = createClient().then(
          () => new Error('the client unexpectedly started'),
          (error: unknown) => error as Error,
        );
        await jest.advanceTimersByTimeAsync(30_000);

        expect((await creating).message).toMatch(/did not answer within/);
        expect(FakeSdkCopilotClient.instances[0]?.stopped).toBe(1);
        expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(1);
      });
    });
  });

  /**
   * A start that answers once the budget has elapsed has no caller left to hand a client
   * to: the one that asked was already told the CLI went silent. It must not surface as a
   * rejection nobody handled, and must not produce a client after the process was killed.
   */
  it('absorbs a start that answers after the budget', async () => {
    await withoutUnhandledRejections(async () => {
      await withFakeTimers(async () => {
        let rejectStart!: (error: unknown) => void;
        FakeSdkCopilotClient.behavior.start = () => new Promise<void>((_resolve, reject) => {
          rejectStart = reject;
        });

        const creating = createClient().then(
          () => new Error('the client unexpectedly started'),
          (error: unknown) => error as Error,
        );
        await jest.advanceTimersByTimeAsync(30_000);
        const failure = await creating;
        rejectStart(new Error('the CLI answered far too late'));
        await jest.advanceTimersByTimeAsync(10_000);

        expect(failure.message).toMatch(/did not answer within/);
        expect(failure.message).not.toMatch(/far too late/);
        expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(1);
      });
    });
  });
});

/**
 * Opening a session is a native acquisition from a runtime that is already up, so it runs
 * on the same budget every release does. A CLI that never answers one would otherwise hold
 * the turn that asked for it open for as long as it stays silent, and hold whatever is
 * queued behind that turn open with it.
 *
 * The client is the wrapper's own, and a CLI that stopped answering here cannot be asked
 * anything else, so the runtime ends it rather than handing back a client whose next call
 * would wait out the same silence.
 */
describe('copilotSdkRuntime session budget', () => {
  it('ends the CLI when a new session never arrives', async () => {
    await withoutUnhandledRejections(async () => {
      await withFakeTimers(async () => {
        FakeSdkCopilotClient.behavior.createSession = () =>
          neverAnswers<FakeSdkCopilotSession>();
        const client = await createClient();

        const opening = client.createSession(sessionConfig()).then(
          () => new Error('the session unexpectedly opened'),
          (error: unknown) => error as Error,
        );
        await jest.advanceTimersByTimeAsync(5_000);

        expect((await opening).message)
          .toMatch(/did not open a session within 5 seconds.*terminated/);
        expect(FakeSdkCopilotClient.instances[0]?.stopped).toBe(1);
        expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(1);
      });
    });
  });

  it('ends the CLI when a resumed session never arrives', async () => {
    await withoutUnhandledRejections(async () => {
      await withFakeTimers(async () => {
        FakeSdkCopilotClient.behavior.resumeSession = () =>
          neverAnswers<FakeSdkCopilotSession>();
        const client = await createClient();

        const resuming = client.resumeSession('copilot-session-1', sessionConfig()).then(
          () => new Error('the session unexpectedly resumed'),
          (error: unknown) => error as Error,
        );
        await jest.advanceTimersByTimeAsync(5_000);

        expect((await resuming).message)
          .toMatch(/did not resume the session within 5 seconds.*terminated/);
        expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(1);
      });
    });
  });

  /**
   * A session that arrives once the budget has elapsed has no caller left to hand it to,
   * and the CLI holding it has already been killed. Leaving it connected would keep a
   * session Claudian never returned open on a runtime nothing owns.
   */
  it('disconnects a session that arrives after the budget', async () => {
    await withoutUnhandledRejections(async () => {
      await withFakeTimers(async () => {
        const late = new FakeSdkCopilotSession('copilot-session-late');
        let deliver!: (session: FakeSdkCopilotSession) => void;
        FakeSdkCopilotClient.behavior.createSession = () => (
          new Promise<FakeSdkCopilotSession>((resolve) => { deliver = resolve; })
        );
        const client = await createClient();

        const opening = client.createSession(sessionConfig()).then(
          () => new Error('the session unexpectedly opened'),
          (error: unknown) => error as Error,
        );
        await jest.advanceTimersByTimeAsync(5_000);
        const failure = await opening;
        deliver(late);
        await jest.advanceTimersByTimeAsync(0);

        expect(failure.message).toMatch(/did not open a session/);
        expect(late.disconnected).toBe(1);
      });
    });
  });

  /**
   * The release of a late session runs on a CLI that was already terminated, so it fails
   * far more often than it succeeds. Nothing is listening for either outcome by then.
   */
  it('absorbs a late session whose release fails', async () => {
    await withoutUnhandledRejections(async () => {
      await withFakeTimers(async () => {
        const late = new FakeSdkCopilotSession('copilot-session-late');
        let deliver!: (session: FakeSdkCopilotSession) => void;
        FakeSdkCopilotClient.behavior.createSession = () => (
          new Promise<FakeSdkCopilotSession>((resolve) => { deliver = resolve; })
        );
        FakeSdkCopilotClient.behavior.disconnect = async () => {
          throw new Error('the connection was already gone');
        };
        const client = await createClient();

        const opening = client.createSession(sessionConfig()).then(
          () => new Error('the session unexpectedly opened'),
          (error: unknown) => error as Error,
        );
        await jest.advanceTimersByTimeAsync(5_000);
        const failure = await opening;
        deliver(late);
        await jest.advanceTimersByTimeAsync(0);

        expect(failure.message).not.toMatch(/already gone/);
        expect(late.disconnected).toBe(1);
      });
    });
  });

  /**
   * A CLI that rejects after the budget has no caller left either, and its rejection must
   * not replace the failure the caller was already given.
   */
  it('absorbs a session request that fails after the budget', async () => {
    await withoutUnhandledRejections(async () => {
      await withFakeTimers(async () => {
        let refuse!: (error: unknown) => void;
        FakeSdkCopilotClient.behavior.createSession = () => (
          new Promise<FakeSdkCopilotSession>((_resolve, reject) => { refuse = reject; })
        );
        const client = await createClient();

        const opening = client.createSession(sessionConfig()).then(
          () => new Error('the session unexpectedly opened'),
          (error: unknown) => error as Error,
        );
        await jest.advanceTimersByTimeAsync(5_000);
        const failure = await opening;
        refuse(new Error('the CLI answered far too late'));
        await jest.advanceTimersByTimeAsync(5_000);

        expect(failure.message).toMatch(/did not open a session/);
        expect(failure.message).not.toMatch(/far too late/);
      });
    });
  });

  it('leaves a CLI that answered within the budget running', async () => {
    await withFakeTimers(async () => {
      const client = await createClient();

      const session = await client.createSession(sessionConfig());
      await jest.advanceTimersByTimeAsync(30_000);

      expect(session.sessionId).toBe('copilot-session-1');
      expect(FakeSdkCopilotClient.instances[0]?.stopped).toBe(0);
      expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(0);
    });
  });
});

/** Records rejections Node had no handler for while the body ran. */
async function withoutUnhandledRejections(body: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const record = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', record);
  try {
    await body();
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', record);
  }

  expect(unhandled).toEqual([]);
}

describe('copilotSdkRuntime turn aborts', () => {
  /**
   * The SDK resolves an abort once the runtime acknowledges it, and rejects when the
   * session is disconnected or the connection failed. That difference decides whether the
   * caller may reuse the session, so it is reported rather than flattened here.
   */
  it('reports an abort the runtime never acknowledged', async () => {
    FakeSdkCopilotClient.behavior.abort = async () => {
      throw new Error('the session connection was closed');
    };
    const session = await createSession();

    await expect(session.abort()).rejects.toThrow(/session connection was closed/);
  });

  it('resolves an abort the runtime acknowledged', async () => {
    const session = await createSession();

    await expect(session.abort()).resolves.toBeUndefined();
  });
});

/**
 * MCP servers and skills reach a session only because a caller named them.
 *
 * The CLI reads its own home's MCP configuration whether or not a session states a map,
 * and starts what it finds there, so the exclusion list is what actually keeps an
 * unselected server from being launched and authenticated. Skills are the same shape:
 * pointing the runtime at a package directory loads that package, and everything else the
 * runtime would load is disabled before a turn can reach it.
 */
describe('copilotSdkRuntime session resources', () => {
  const notesServer = { command: '/usr/bin/notes-mcp' } as const;

  function resourceConfig(
    overrides: Partial<CopilotSdkSessionConfig['resources'] & object> = {},
  ): CopilotSdkSessionConfig {
    return sessionConfig({
      availableTools: ['builtin:read'],
      resources: {
        mcpServers: { notes: notesServer },
        skillDirectories: ['/skills/review'],
        ...overrides,
      },
    });
  }

  it.each(['ensureSkills', 'listSkills', 'disableSkill', 'updateOptions', 'listTools'] as const)(
    'bounds a silent %s during resource preparation and stops the CLI',
    async (step) => {
      await withFakeTimers(async () => {
        FakeSdkCopilotClient.behavior.skills = [{ name: 'builtin-unselected' }];
        FakeSdkCopilotClient.behavior.listTools = async () => ({ tools: [{ name: 'read' }] });
        FakeSdkCopilotClient.behavior[step] = () => neverAnswers<never>();
        const client = await createClient();
        let outcome: CopilotSdkSession | unknown;
        const opening = client.createSession(resourceConfig()).then(
          session => { outcome = session; },
          error => { outcome = error; },
        );
        await jest.advanceTimersByTimeAsync(40_000);

        expect(outcome).toBeInstanceOf(Error);
        expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(1);
        await opening;
      });
    },
  );

  it('does not silently continue when MCP connection-state discovery fails', async () => {
    FakeSdkCopilotClient.behavior.listServers = async () => {
      throw new Error('MCP state unavailable');
    };
    const client = await createClient();

    await expect(client.createSession(resourceConfig())).rejects.toThrow('MCP state unavailable');
    expect(FakeSdkCopilotSession.instances[0]?.toolListings).toEqual([]);
  });

  it('preserves transport recovery and the causes when setup and cleanup all time out', async () => {
    await withFakeTimers(async () => {
      FakeSdkCopilotClient.behavior.ensureSkills = () => neverAnswers<void>();
      FakeSdkCopilotClient.behavior.disconnect = () => neverAnswers<void>();
      FakeSdkCopilotClient.behavior.deleteSession = () => neverAnswers<void>();
      const client = await createClient();
      const opening = client.createSession(resourceConfig()).then(
        () => undefined, (error: unknown) => error,
      );
      await jest.advanceTimersByTimeAsync(40_000);

      expect(await opening).toMatchObject({
        category: 'transport',
        message: expect.stringMatching(/preparing selected Copilot resources[\s\S]*disconnecting[\s\S]*deleting/),
        nativeReset: 'client',
      });
      expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(1);
    });
  });

  it.each([false, true])('only deletes unpublished sessions after setup failure (resume=%s)',
    async (resuming) => {
      FakeSdkCopilotClient.behavior.ensureSkills = async () => {
        throw new Error('Skill metadata unavailable');
      };
      const client = await createClient();
      const opening = resuming
        ? client.resumeSession('existing-history', resourceConfig())
        : client.createSession(resourceConfig());

      await expect(opening).rejects.toThrow('Skill metadata unavailable');
      expect(FakeSdkCopilotClient.instances[0]?.deletedSessions)
        .toEqual(resuming ? [] : ['copilot-session-1']);
      expect(FakeSdkCopilotSession.instances[0]?.disconnected).toBe(1);
    });

  it('does not continue resource setup when a timed-out skill load eventually resolves', async () => {
    await withFakeTimers(async () => {
      let deliver!: () => void;
      FakeSdkCopilotClient.behavior.ensureSkills = () => new Promise<void>(resolve => {
        deliver = resolve;
      });
      FakeSdkCopilotClient.behavior.skills = [{ name: 'unselected' }];
      const client = await createClient();
      const opening = client.createSession(resourceConfig()).then(
        () => undefined, (error: unknown) => error,
      );
      await jest.advanceTimersByTimeAsync(40_000);
      expect(await opening).toBeInstanceOf(Error);
      deliver();
      await jest.advanceTimersByTimeAsync(1);

      expect(FakeSdkCopilotSession.instances[0]?.disabledSkills).toEqual([]);
      expect(FakeSdkCopilotSession.instances[0]?.optionUpdates).toEqual([]);
    });
  });

  it('disables every ambient server a resource-free session did not ask for', async () => {
    FakeSdkCopilotClient.behavior.discoverMcp = async () => ({
      servers: [{ name: 'home-server' }, { name: 'plugin-server' }],
    });
    const client = await createClient();
    await client.createSession(sessionConfig());
    const config = FakeSdkCopilotClient.instances[0]?.sessionConfigs[0];

    expect(FakeSdkCopilotClient.instances[0]?.discoveryRequests).toEqual([
      { workingDirectory: '/vault' },
    ]);
    expect(config).toMatchObject({
      disabledMcpServers: ['home-server', 'plugin-server'],
      enableSkills: false,
      mcpServers: {},
    });
  });

  it('keeps a selected server out of the exclusion list on create and resume', async () => {
    FakeSdkCopilotClient.behavior.discoverMcp = async () => ({
      servers: [{ name: 'notes' }, { name: 'home-server' }],
    });
    const client = await createClient();
    await client.createSession(resourceConfig());
    await client.resumeSession('copilot-session-1', resourceConfig());

    for (const config of FakeSdkCopilotClient.instances[0]?.sessionConfigs ?? []) {
      expect(config).toMatchObject({
        disabledMcpServers: ['home-server'],
        enableSkills: true,
        mcpServers: { notes: notesServer },
        skillDirectories: ['/skills/review'],
      });
    }
  });

  /**
   * Without the enumeration there is no exclusion list, and the session would start
   * whatever the CLI's home holds. That is the one thing this layer promises it does not
   * do, so no session is opened at all.
   */
  it('opens no session when the ambient servers cannot be enumerated', async () => {
    FakeSdkCopilotClient.behavior.discoverMcp = async () => {
      throw new Error('mcp discovery is unavailable');
    };
    const client = await createClient();

    await expect(client.createSession(sessionConfig())).rejects.toThrow(/mcp discovery/);
    expect(FakeSdkCopilotClient.instances[0]?.sessionConfigs).toEqual([]);
  });

  it('disables every skill the caller did not select, including builtins', async () => {
    FakeSdkCopilotClient.behavior.skills = [
      {
        commandName: 'review',
        name: 'review',
        path: '/skills/review/SKILL.md',
        userInvocable: true,
      },
      { name: 'sibling', path: '/skills/sibling/SKILL.md', userInvocable: true },
      { name: 'github-pr-media', userInvocable: false },
    ];
    const client = await createClient();
    await client.createSession(resourceConfig());

    expect(FakeSdkCopilotSession.instances[0]?.disabledSkills)
      .toEqual(['sibling', 'github-pr-media']);
  });

  it('allows only the tools a selected server actually offers', async () => {
    FakeSdkCopilotClient.behavior.listTools = async () => ({
      tools: [{ name: 'search' }, { name: 'delete' }],
    });
    const client = await createClient();
    const session = await client.createSession(sessionConfig({
      availableTools: ['builtin:read'],
      resources: {
        mcpServers: { notes: { ...notesServer, tools: ['search'] } },
        skillDirectories: [],
      },
    }));

    expect(session.resourceDiagnostics).toEqual([]);
    expect(FakeSdkCopilotSession.instances[0]?.optionUpdates).toEqual([
      { availableTools: ['builtin:read', 'mcp:notes-search'] },
    ]);
  });

  it('reports a selected server that never connected', async () => {
    FakeSdkCopilotClient.behavior.listTools = async () => {
      throw new Error('server notes is not connected');
    };
    const client = await createClient();
    const session = await client.createSession(sessionConfig({
      availableTools: ['builtin:read'],
      resources: { mcpServers: { notes: notesServer }, skillDirectories: [] },
    }));

    expect(session.resourceDiagnostics).toEqual([expect.stringContaining('notes')]);
  });

  it('lists the commands of the selected skills only', async () => {
    FakeSdkCopilotClient.behavior.skills = [
      {
        commandName: 'review',
        name: 'review',
        path: '/skills/review/SKILL.md',
        userInvocable: true,
      },
      { name: 'sibling', path: '/skills/sibling/SKILL.md', userInvocable: true },
    ];
    FakeSdkCopilotClient.behavior.commands = [
      { description: 'Review a note', kind: 'skill', name: 'review' },
      { kind: 'skill', name: 'sibling' },
      { kind: 'builtin', name: 'clear' },
    ];
    const client = await createClient();
    const session = await client.createSession(resourceConfig());

    expect(await session.listSkillCommands()).toEqual([
      { description: 'Review a note', name: 'review' },
    ]);
  });

  it('returns the prompt a skill command produced instead of sending it', async () => {
    FakeSdkCopilotClient.behavior.invokeCommand = async () => ({
      displayPrompt: '/review this note',
      kind: 'agent-prompt',
      notice: 'Review skill loaded',
      prompt: 'Follow the review skill for this note.',
    });
    const client = await createClient();
    const session = await client.createSession(resourceConfig());

    expect(await session.invokeSkillCommand('review', 'this note')).toEqual({
      displayPrompt: '/review this note',
      kind: 'prompt',
      notice: 'Review skill loaded',
      prompt: 'Follow the review skill for this note.',
    });
  });
});

/**
 * A selected MCP server is a process the runtime is still starting when the session opens.
 *
 * Its tools can only be asked for once it has connected, so the connection state decides
 * what happens: a server still coming up is waited for on the startup budget, because
 * connecting one is cold work like starting the CLI, and a server the runtime has already
 * given up on is reported rather than waited out.
 */
describe('copilotSdkRuntime selected server connections', () => {
  function connectingConfig(): CopilotSdkSessionConfig {
    return sessionConfig({
      availableTools: ['builtin:read'],
      resources: {
        mcpServers: { notes: { command: '/usr/bin/notes-mcp' } },
        skillDirectories: [],
      },
    });
  }

  it('waits for a server that is still connecting, then allows its tools', async () => {
    await withFakeTimers(async () => {
      FakeSdkCopilotClient.behavior.listServers = async attempt => ({
        servers: [{ name: 'notes', status: attempt < 3 ? 'pending' : 'connected' }],
      });
      FakeSdkCopilotClient.behavior.listTools = async () => ({ tools: [{ name: 'search' }] });
      const client = await createClient();

      const opening = client.createSession(connectingConfig());
      await jest.advanceTimersByTimeAsync(2_000);
      const session = await opening;

      expect(session.resourceDiagnostics).toEqual([]);
      expect(FakeSdkCopilotSession.instances[0]?.optionUpdates).toEqual([
        { availableTools: ['builtin:read', 'mcp:notes-search'] },
      ]);
    });
  });

  it('reports a server the runtime could not connect, and asks it for nothing', async () => {
    FakeSdkCopilotClient.behavior.listServers = async () => ({
      servers: [{ error: 'spawn ENOENT', name: 'notes', status: 'failed' }],
    });
    const client = await createClient();

    const session = await client.createSession(connectingConfig());

    expect(session.resourceDiagnostics).toEqual([
      expect.stringContaining('spawn ENOENT'),
    ]);
    expect(FakeSdkCopilotSession.instances[0]?.toolListings).toEqual([]);
    expect(FakeSdkCopilotSession.instances[0]?.optionUpdates).toEqual([]);
  });

  it('reports a server that is waiting for authentication', async () => {
    FakeSdkCopilotClient.behavior.listServers = async () => ({
      servers: [{ name: 'notes', status: 'needs-auth' }],
    });
    const client = await createClient();

    const session = await client.createSession(connectingConfig());

    expect(session.resourceDiagnostics).toEqual([expect.stringContaining('needs-auth')]);
    expect(FakeSdkCopilotSession.instances[0]?.toolListings).toEqual([]);
  });

  it('stops waiting for a server that never finishes connecting', async () => {
    await withFakeTimers(async () => {
      FakeSdkCopilotClient.behavior.listServers = async () => ({
        servers: [{ name: 'notes', status: 'pending' }],
      });
      const client = await createClient();

      const opening = client.createSession(connectingConfig()).then(
        () => new Error('The pending server unexpectedly became ready.'),
        (error: unknown) => error,
      );
      await jest.advanceTimersByTimeAsync(31_000);
      const failure = await opening;

      expect(failure).toMatchObject({ category: 'transport' });
      expect(FakeSdkCopilotSession.instances[0]?.toolListings).toEqual([]);
      expect(FakeSdkCopilotClient.instances[0]?.forceStopped).toBe(1);
    });
  });
});

/**
 * Connection state is what decides whether to wait, not whether the session may ask. A
 * runtime that has not reported a server leaves the tool listing as the authority, which answers
 * for a connected server and fails loudly for one that is not.
 */
describe('copilotSdkRuntime unreported server state', () => {
  it('still asks a selected server for its tools', async () => {
    FakeSdkCopilotClient.behavior.listServers = async () => ({ servers: [] });
    FakeSdkCopilotClient.behavior.listTools = async () => ({ tools: [{ name: 'search' }] });
    const client = await createClient();

    const session = await client.createSession(sessionConfig({
      availableTools: ['builtin:read'],
      resources: {
        mcpServers: { notes: { command: '/usr/bin/notes-mcp' } },
        skillDirectories: [],
      },
    }));

    expect(session.resourceDiagnostics).toEqual([]);
    expect(FakeSdkCopilotSession.instances[0]?.optionUpdates).toEqual([
      { availableTools: ['builtin:read', 'mcp:notes-search'] },
    ]);
  });
});

/**
 * Selecting a server says which servers a session may reach, never that a session has
 * tools. `availableTools: []` is the port's deny-all, and a resources map does not widen
 * it: the metadata probe and any other tool-free caller connect their selected servers
 * and are granted none of their tools.
 */
describe('copilotSdkRuntime deny-all sessions with resources', () => {
  it('grants no MCP tool to a session that allows no tool', async () => {
    FakeSdkCopilotClient.behavior.listTools = async () => ({ tools: [{ name: 'search' }] });
    const client = await createClient();

    const session = await client.createSession(sessionConfig({
      availableTools: [],
      resources: {
        mcpServers: { notes: { command: '/usr/bin/notes-mcp' } },
        skillDirectories: [],
      },
    }));

    expect(FakeSdkCopilotClient.instances[0]?.sessionConfigs[0]).toMatchObject({
      availableTools: [],
      mcpServers: { notes: { command: '/usr/bin/notes-mcp' } },
    });
    expect(FakeSdkCopilotSession.instances[0]?.optionUpdates).toEqual([]);
    expect(FakeSdkCopilotSession.instances[0]?.toolListings).toEqual([]);
    expect(session.resourceDiagnostics).toEqual([]);
  });

  it('still reports a selected server that cannot be reached', async () => {
    FakeSdkCopilotClient.behavior.listServers = async () => ({
      servers: [{ error: 'spawn ENOENT', name: 'notes', status: 'failed' }],
    });
    const client = await createClient();

    const session = await client.createSession(sessionConfig({
      availableTools: [],
      resources: {
        mcpServers: { notes: { command: '/usr/bin/notes-mcp' } },
        skillDirectories: [],
      },
    }));

    expect(session.resourceDiagnostics).toEqual([expect.stringContaining('spawn ENOENT')]);
  });
});

/**
 * A selected skill directory and the path the runtime reports for it can be two spellings
 * of one place: macOS reaches every temporary directory through `/var`, a link to
 * `/private/var`, and a vault on an external disk or a synced folder is commonly a link
 * itself. Comparing spellings alone would disable the very skill that was selected.
 */
describe('copilotSdkRuntime skills reached through a link', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'copilot-skill-link-'));
    mkdirSync(path.join(root, 'real', 'review'), { recursive: true });
    mkdirSync(path.join(root, 'real', 'sibling'), { recursive: true });
    writeFileSync(path.join(root, 'real', 'review', 'SKILL.md'), '---\nname: review\n---\n');
    writeFileSync(path.join(root, 'real', 'sibling', 'SKILL.md'), '---\nname: sibling\n---\n');
    symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'dir');
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it('keeps the selected skill when the runtime reports its resolved path', async () => {
    const resolvedRoot = realpathSync(path.join(root, 'real'));
    FakeSdkCopilotClient.behavior.skills = [
      {
        commandName: 'review',
        name: 'review',
        path: path.join(resolvedRoot, 'review', 'SKILL.md'),
        userInvocable: true,
      },
      {
        name: 'sibling',
        path: path.join(resolvedRoot, 'sibling', 'SKILL.md'),
        userInvocable: true,
      },
    ];
    FakeSdkCopilotClient.behavior.commands = [
      { kind: 'skill', name: 'review' },
      { kind: 'skill', name: 'sibling' },
    ];
    const client = await createClient();

    const session = await client.createSession(sessionConfig({
      resources: {
        mcpServers: {},
        skillDirectories: [path.join(root, 'link', 'review')],
      },
    }));

    expect(FakeSdkCopilotSession.instances[0]?.disabledSkills).toEqual(['sibling']);
    expect(await session.listSkillCommands()).toEqual([{ name: 'review' }]);
  });
});
