import type { CopilotClientOptions, SessionConfig } from '@github/copilot-sdk';

import type {
  CopilotSdkClient,
  CopilotSdkSession,
  CopilotSdkSessionConfig,
} from '@/providers/copilot/sdk/CopilotSdkPort';
import { copilotSdkRuntime } from '@/providers/copilot/sdk/CopilotSdkRuntime';

/** The SDK session surface the wrapper drives, with only the turn controls under test. */
class FakeSdkCopilotSession {
  aborted = 0;
  disconnected = 0;

  constructor(readonly sessionId: string) {}

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
    createSession?: () => Promise<FakeSdkCopilotSession>;
    disconnect?: () => Promise<void>;
    resumeSession?: () => Promise<FakeSdkCopilotSession>;
    start?: () => Promise<void>;
    stop?: () => Promise<Error[]>;
    forceStop?: () => Promise<void>;
  } = {};

  forceStopped = 0;
  started = 0;
  stopped = 0;
  readonly sessionConfigs: SessionConfig[] = [];

  constructor(readonly options: CopilotClientOptions) {
    FakeSdkCopilotClient.instances.push(this);
  }

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
  FakeSdkCopilotClient.behavior = {};
});

/**
 * `mode: 'empty'` is what makes the SDK's ambient CLI behaviour opt-in rather than
 * inherited. Without it the client defaults to `copilot-cli`, where a session picks up
 * the coding agent's own tools, instruction discovery, and cross-session capabilities —
 * everything Claudian switches off one flag at a time would depend on that list staying
 * complete as the CLI grows.
 *
 * Empty mode is also a contract: the SDK refuses a client with no persistence location of
 * its own and a session with no explicit tool list, so both are stated here rather than
 * left to a later layer.
 */
describe('copilotSdkRuntime client construction', () => {
  it('constructs the client in empty mode against the CLI it was handed', async () => {
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
      mode: 'empty',
      workingDirectory: '/vault',
    });
  });

  /**
   * An empty `baseDirectory` passes the SDK's own check, which only tests that one was
   * supplied, and then leaves `COPILOT_HOME` unset — so the CLI writes this vault's agent
   * state into the user's shared `~/.copilot`. No CLI is started for it.
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
