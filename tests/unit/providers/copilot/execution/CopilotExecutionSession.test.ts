import { AuxiliarySessionController } from '@/core/auxiliary/AuxiliarySessionController';
import type {
  ProviderApprovalInteractionRequest,
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderExecutionSession,
  ProviderInteractionPort,
  ProviderQuestionInteractionRequest,
  ProviderSessionConfig,
} from '@/core/execution';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { CopilotExecutionBackend } from '@/providers/copilot/execution/CopilotExecutionBackend';
import {
  CopilotRuntimeError,
  toCopilotSendError,
} from '@/providers/copilot/sdk/CopilotRuntimeError';
import type {
  CopilotSdkEvent,
  CopilotSdkPermissionRequest,
  CopilotSdkUserInputRequest,
} from '@/providers/copilot/sdk/CopilotSdkPort';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';

import {
  createDeferred,
  type Deferred,
  FakeCopilotSdkClient,
  FakeCopilotSdkRuntime,
  type FakeCopilotSdkSession,
} from '../sdk/FakeCopilotSdkRuntime';

const VAULT_PATH = '/vault';

function createHost(overrides: Partial<Record<string, unknown>> = {}): ProviderHost {
  const settings: Record<string, unknown> = { ...overrides };
  updateCopilotProviderSettings(settings, {
    discoveredModels: [{
      contextWindow: 200_000,
      displayName: 'GPT-5',
      rawId: 'gpt-5',
      reasoningEfforts: ['low', 'high'],
      supportsReasoning: true,
      supportsVision: false,
    }],
    enabled: true,
    visibleModels: ['gpt-5'],
  });

  return {
    app: { vault: { adapter: { basePath: VAULT_PATH } } },
    getResolvedProviderCliPath: async () => '/usr/local/bin/copilot',
    settings,
  } as unknown as ProviderHost;
}

function createSessionConfig(
  overrides: Partial<ProviderSessionConfig> = {},
): ProviderSessionConfig {
  const interactionPort: ProviderInteractionPort = {
    askUserQuestion: async request => ({ answers: {}, interactionId: request.interactionId }),
    dismissInteraction: () => {},
    requestApproval: async request => ({
      decision: 'allow',
      interactionId: request.interactionId,
    }),
    requestPlanDecision: async request => ({
      decision: null,
      interactionId: request.interactionId,
    }),
  };

  return {
    interactionPort,
    lifecycle: 'persistent',
    nativePersistence: 'provider-default',
    vaultWorkingDirectory: VAULT_PATH,
    ...overrides,
  };
}

function createRequest(
  overrides: Partial<ProviderExecutionRequest> = {},
): ProviderExecutionRequest {
  return {
    configuration: {
      model: 'copilot/gpt-5',
      systemInstructions: { kind: 'provider-default' },
    },
    input: [{ text: 'Summarize the vault.', type: 'text' }],
    signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
    ...overrides,
  } as ProviderExecutionRequest;
}

async function collect(
  events: AsyncIterable<ProviderExecutionEvent>,
): Promise<ProviderExecutionEvent[]> {
  const collected: ProviderExecutionEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function sdkEvent(type: string, data: unknown): CopilotSdkEvent {
  return {
    data,
    id: 'event-1',
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    type,
  } as unknown as CopilotSdkEvent;
}

/** Turn-flow events only; snapshot publication is asserted through `getSnapshot`. */
function turnFlow(events: readonly ProviderExecutionEvent[]): ProviderExecutionEvent[] {
  return events.filter(event => event.type !== 'session_state_changed');
}

function createRuntime(
  onSessionCreated?: (session: FakeCopilotSdkSession) => void,
  authStatus?: { isAuthenticated: boolean; statusMessage?: string },
): FakeCopilotSdkRuntime {
  return new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
    ...(authStatus ? { authStatus } : {}),
    ...(onSessionCreated ? { onSessionCreated } : {}),
  }));
}

describe('CopilotExecutionBackend', () => {
  it('creates sessions bound to the vault working directory', () => {
    const runtime = createRuntime();
    const backend = new CopilotExecutionBackend(createHost(), { runtime });

    const session = backend.createSession(createSessionConfig());

    expect(backend.providerId).toBe('copilot');
    expect(session.providerId).toBe('copilot');
    expect(session.getStatus()).toBe('idle');
  });
});

describe('CopilotExecutionSession turn lifecycle', () => {
  it.each(['inline-edit', 'instruction'] as const)(
    'uses the first enabled model for %s without a model override',
    async (owner) => {
      const host = createHost();
      updateCopilotProviderSettings(host.settings, {
        discoveredModels: ['gpt-5', 'gpt-5-mini'].map(rawId => ({
          displayName: rawId,
          rawId,
          reasoningEfforts: [],
          supportsReasoning: false,
          supportsVision: false,
        })),
        visibleModels: ['gpt-5-mini', 'gpt-5'],
      });
      const runtime = createRuntime((sdkSession) => {
        sdkSession.sendBehavior = async () => {
          sdkSession.emit(sdkEvent('assistant.message_delta', {
            deltaContent: 'Edited note.',
            messageId: 'message-1',
          }));
        };
      });
      const controller = new AuxiliarySessionController({
        backend: new CopilotExecutionBackend(host, { runtime }),
        interactionPort: createSessionConfig().interactionPort,
        lifecycleRegistry: new ProviderExecutionLifecycleRegistry(),
        vaultWorkingDirectory: VAULT_PATH,
      }, owner, { kind: 'read-only' });
      await controller.startRoot();

      try {
        const result = await controller.execute({
          prompt: 'Edit this note.',
          systemPrompt: 'Return the edited note.',
        });

        expect(result).toBe('Edited note.');
        expect(runtime.lastClient?.lastSession?.config.model).toBe('gpt-5-mini');
      } finally {
        await controller.dispose();
      }
    },
  );

  it('reports usage against the resolved default model', async () => {
    const runtime = createRuntime((sdkSession) => {
      sdkSession.sendBehavior = async () => {
        sdkSession.emit(sdkEvent('assistant.usage', {
          cacheReadTokens: 500,
          inputTokens: 2000,
          model: 'gpt-5',
        }));
      };
    });
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    try {
      const events = await collect(session.execute(createRequest({
        configuration: { systemInstructions: { kind: 'provider-default' } },
      })).events);

      expect(events.find(event => event.type === 'usage_updated')).toMatchObject({
        usage: { contextTokens: 2500, contextWindow: 200_000, percentage: 1.25 },
      });
    } finally {
      await session.dispose();
    }
  });

  it('streams a turn from start to completion', async () => {
    const runtime = createRuntime((sdkSession) => {
      sdkSession.sendBehavior = async () => {
        sdkSession.emit(sdkEvent('assistant.message_delta', {
          deltaContent: 'Done.',
          messageId: 'message-1',
        }));
      };
    });
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const events = turnFlow(await collect(session.execute(createRequest()).events));

    expect(events.map(event => event.type)).toEqual([
      'turn_started',
      'user_message_started',
      'assistant_message_started',
      'text_delta',
      'turn_completed',
    ]);
    expect(events.at(-1)).toMatchObject({ reason: 'completed' });
    expect(runtime.lastClient?.lastSession?.prompts).toEqual(['Summarize the vault.']);
    await session.dispose();
  });

  it('carries an empty allow-list into the native session for a passive turn', async () => {
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest({
      toolPolicy: { kind: 'passive' },
    })).events);

    expect(runtime.lastClient?.lastSession?.config.availableTools).toEqual([]);
    expect(runtime.lastClient?.lastSession?.config.excludedTools).toBeUndefined();
    await session.dispose();
  });

  it('carries the read-only allow-list into the native session', async () => {
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest({
      toolPolicy: { kind: 'read-only' },
    })).events);

    const config = runtime.lastClient?.lastSession?.config;
    expect(config?.availableTools).toContain('builtin:view');
    expect(config?.availableTools).not.toContain('builtin:bash');
    await session.dispose();
  });

  /**
   * The default policy leaves the CLI's own tool set alone apart from the families
   * Claudian cannot surface: a turn that started a background agent or a factory would
   * run work the user can neither watch nor stop.
   */
  it('excludes the task and factory families from a default-policy session', async () => {
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest()).events);

    const config = runtime.lastClient?.lastSession?.config;
    expect(config?.availableTools).toEqual(['builtin:*']);
    expect([...(config?.excludedTools ?? [])].sort()).toEqual([
      'factories_manage',
      'list_agents',
      'read_agent',
      'run_factory',
      'task',
      'write_agent',
    ]);
    await session.dispose();
  });

  it('starts the CLI with an isolated COPILOT_HOME outside the vault', async () => {
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest()).events);

    const [options] = runtime.clientOptions;
    expect(options.cliPath).toBe('/usr/local/bin/copilot');
    expect(options.baseDirectory).not.toContain(VAULT_PATH);
    expect(options.environment.COPILOT_HOME).toBe(options.baseDirectory);
    await session.dispose();
  });

  it('applies the model and reasoning effort for the turn', async () => {
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest({
      configuration: {
        model: 'copilot/gpt-5',
        reasoning: 'high',
        systemInstructions: { kind: 'provider-default' },
      },
    })).events);

    expect(runtime.lastClient?.lastSession?.config.model).toBe('gpt-5');
    expect(runtime.lastClient?.lastSession?.config.reasoningEffort).toBe('high');
    await session.dispose();
  });

  /**
   * Copilot advertises no image support and the CLI receives a text prompt, so an
   * attached image reaches nothing. The turn still runs, and says what it could not send:
   * answering a question about a picture the model never saw reads as a wrong answer
   * rather than a missing capability.
   */
  it('warns that an attached image was not sent, and still runs the turn', async () => {
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const events = turnFlow(await collect(session.execute(createRequest({
      input: [
        { text: 'What is in this?', type: 'text' },
        {
          image: {
            data: 'x',
            id: 'image-1',
            mediaType: 'image/png',
            name: 'chart.png',
            size: 1,
            source: 'file',
          },
          type: 'image',
        },
      ],
    })).events));

    expect(events.map(event => event.type)).toEqual([
      'turn_started',
      'user_message_started',
      'notice',
      'turn_completed',
    ]);
    expect(events[2]).toMatchObject({
      level: 'warning',
      message: expect.stringContaining('chart.png'),
    });
    expect(runtime.lastClient?.lastSession?.prompts).toEqual(['What is in this?']);
    await session.dispose();
  });

  it('fails closed when no enabled Copilot model is selected', async () => {
    const host = createHost();
    updateCopilotProviderSettings(host.settings, { visibleModels: [] });
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(host, { runtime })
      .createSession(createSessionConfig());

    const events = turnFlow(await collect(session.execute(createRequest({
      configuration: { model: '', systemInstructions: { kind: 'provider-default' } },
    })).events));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: 'configuration',
      recoverable: false,
      type: 'execution_error',
    });
    await session.dispose();
  });

  it('reports an authentication failure without starting a turn', async () => {
    const runtime = createRuntime(undefined, {
      isAuthenticated: false,
      statusMessage: 'Sign in with `copilot`.',
    });
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const events = turnFlow(await collect(session.execute(createRequest()).events));

    expect(events[0]).toMatchObject({
      category: 'authentication',
      message: expect.stringContaining('it reports: Sign in with `copilot`.'),
      type: 'execution_error',
    });
    expect(runtime.lastClient?.stopped).toBe(1);
    await session.dispose();
  });

  it('reports the authentication failure when the gated client cannot be stopped', async () => {
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      authStatus: { isAuthenticated: false, statusMessage: 'Sign in with `copilot`.' },
      stopBehavior: async () => {
        throw new Error('the CLI process would not shut down');
      },
    }));
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const events = turnFlow(await collect(session.execute(createRequest()).events));

    expect(events[0]).toMatchObject({
      category: 'authentication',
      message: expect.stringContaining('it reports: Sign in with `copilot`.'),
      type: 'execution_error',
    });
    expect(runtime.lastClient?.stopped).toBe(1);
    await session.dispose();
  });

  it('reports a transport failure raised while the turn runs', async () => {
    const runtime = createRuntime((sdkSession) => {
      sdkSession.sendBehavior = async () => {
        throw new Error('read ECONNRESET');
      };
    });
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const events = turnFlow(await collect(session.execute(createRequest()).events));

    expect(events.at(-1)).toMatchObject({
      category: 'transport',
      type: 'execution_error',
    });
    await session.dispose();
  });

  it('invalidates the session reference when the runtime lost the native session', async () => {
    const runtime = createRuntime((sdkSession) => {
      sdkSession.sendBehavior = async () => {
        throw new Error('Session copilot-session-lost does not exist');
      };
    });
    const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession(
      createSessionConfig({ resumeSeed: { providerSessionId: 'copilot-session-lost' } }),
    );

    const events = turnFlow(await collect(session.execute(createRequest()).events));

    expect(events.at(-1)).toMatchObject({
      category: 'provider-session-missing',
      type: 'execution_error',
    });
    expect(session.getSnapshot()).toMatchObject({ status: 'invalidated' });
    await session.dispose();
  });
});

describe('CopilotExecutionSession cancellation', () => {
  it('aborts the native turn and ends the run as cancelled', async () => {
    let releaseTurn = (): void => {};
    let turnStarted = (): void => {};
    const turnInFlight = new Promise<void>((resolve) => {
      turnStarted = resolve;
    });
    const runtime = createRuntime((sdkSession) => {
      sdkSession.sendBehavior = () => {
        turnStarted();
        return new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
      };
    });
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const run = session.execute(createRequest());
    await turnInFlight;

    run.cancel();
    const events = turnFlow(await collect(run.events));
    releaseTurn();

    expect(events.at(-1)).toMatchObject({ type: 'cancelled' });
    expect(runtime.lastClient?.lastSession?.aborted).toBe(1);
    await session.dispose();
  });

  it('cancels when the caller aborts the request signal', async () => {
    let releaseTurn = (): void => {};
    let turnStarted = (): void => {};
    const turnInFlight = new Promise<void>((resolve) => {
      turnStarted = resolve;
    });
    const runtime = createRuntime((sdkSession) => {
      sdkSession.sendBehavior = () => {
        turnStarted();
        return new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
      };
    });
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());
    const controller = new AbortController();

    const run = session.execute(createRequest({ signal: controller.signal }));
    await turnInFlight;

    controller.abort();
    const events = turnFlow(await collect(run.events));
    releaseTurn();

    expect(events.at(-1)).toMatchObject({ type: 'cancelled' });
    await session.dispose();
  });
});

describe('CopilotExecutionSession session reuse and resume', () => {
  it('reuses the live session across turns with the same bound inputs', async () => {
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest()).events);
    await collect(session.execute(createRequest()).events);

    expect(runtime.lastClient?.createdSessions).toHaveLength(1);
    expect(runtime.lastClient?.lastSession?.prompts).toHaveLength(2);
    await session.dispose();
  });

  it('recreates the session when a bound input changes', async () => {
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest()).events);
    await collect(session.execute(createRequest({
      toolPolicy: { kind: 'read-only' },
    })).events);

    expect(runtime.lastClient?.createdSessions.length).toBeGreaterThan(1);
    await session.dispose();
  });

  it('resumes a native session from the seed instead of creating a new one', async () => {
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession(
      createSessionConfig({ resumeSeed: { providerSessionId: 'copilot-session-existing' } }),
    );

    await collect(session.execute(createRequest()).events);

    expect(runtime.lastClient?.resumedSessionIds).toEqual(['copilot-session-existing']);
    expect(session.getSnapshot()).toMatchObject({
      providerSessionId: 'copilot-session-existing',
    });
    await session.dispose();
  });

  it('publishes the native session id on the snapshot for a new session', async () => {
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest()).events);

    expect(session.getSnapshot()).toMatchObject({
      providerId: 'copilot',
      providerSessionId: 'copilot-session-1',
    });
    await session.dispose();
  });
});

describe('CopilotExecutionSession disposal', () => {
  it('releases the client and leaves persistent native session data intact', async () => {
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest()).events);
    await session.dispose();

    expect(runtime.lastClient?.lastSession?.disconnected).toBe(1);
    expect(runtime.lastClient?.stopped).toBe(1);
    expect(runtime.lastClient?.deletedSessions).toEqual([]);
    expect(session.getStatus()).toBe('disposed');
  });

  it('deletes native data for an ephemeral session it created', async () => {
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession(
      createSessionConfig({
        lifecycle: 'ephemeral',
        nativePersistence: 'disabled-if-supported',
      }),
    );

    await collect(session.execute(createRequest()).events);
    await session.dispose();

    expect(runtime.lastClient?.deletedSessions).toEqual(['copilot-session-1']);
  });

  it('keeps native data for an ephemeral session that opted into persistence', async () => {
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession(
      createSessionConfig({ lifecycle: 'ephemeral', nativePersistence: 'enabled' }),
    );

    await collect(session.execute(createRequest()).events);
    await session.dispose();

    expect(runtime.lastClient?.deletedSessions).toEqual([]);
  });

  it('releases the runtime once however often it is disposed', async () => {
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest()).events);
    await Promise.all([session.dispose(), session.dispose()]);
    await session.dispose();

    expect(runtime.clients).toHaveLength(1);
    expect(runtime.lastClient?.stopped).toBe(1);
    expect(runtime.lastClient?.lastSession?.disconnected).toBe(1);
  });

  it('reports the same cleanup failure however often it is disposed', async () => {
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      stopBehavior: async () => {
        throw new Error('the CLI process would not shut down');
      },
    }));
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest()).events);
    const first = await disposalFailure(session);
    const second = await disposalFailure(session);

    expect(first.message).toMatch(/would not shut down/);
    expect(second.message).toBe(first.message);
    expect(runtime.lastClient?.stopped).toBe(1);
  });

  it('is idempotent and refuses further turns', async () => {
    const runtime = createRuntime();
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await session.dispose();
    await session.dispose();

    expect(() => session.execute(createRequest())).toThrow(/disposed/);
  });
});

/**
 * A cancellation and a failure recovery both release native state before they end the run
 * they belong to, and both can still be running when disposal arrives. Disposal has to
 * join whichever is in flight rather than tearing down beside it: otherwise the run ends
 * after the listeners are gone, and whatever that release could not do lands once nothing
 * is left to report it, so the caller has to dispose a second time to hear about it.
 */
describe('CopilotExecutionSession disposal during a lifecycle flight', () => {
  it('waits for a cancel already in flight and reports after the run ends', async () => {
    const sending = createDeferred();
    const blocked = createDeferred();
    const aborting = createDeferred();
    const releaseAbort = createDeferred();
    const client = new FakeCopilotSdkClient({
      onSessionCreated: (created) => {
        created.sendBehavior = async () => {
          sending.resolve();
          await blocked.promise;
        };
        created.abortBehavior = async () => {
          aborting.resolve();
          await releaseAbort.promise;
        };
      },
    });
    const runtime = new FakeCopilotSdkRuntime(() => client);
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const order: string[] = [];
    const run = session.execute(createRequest());
    const streamed = (async () => {
      for await (const event of run.events) {
        if (TERMINAL_EVENT_TYPES.includes(event.type)) order.push(event.type);
      }
    })();
    await sending.promise;
    run.cancel();
    await aborting.promise;

    const disposal = session.dispose().then(
      () => order.push('disposed'),
      () => order.push('disposed'),
    );
    await settlePendingWork();

    expect(order).toEqual([]);

    releaseAbort.resolve();
    blocked.resolve();
    await disposal;
    await streamed;

    expect(order).toEqual(['cancelled', 'disposed']);
    expect(client.stopped).toBe(1);
    expect(session.getStatus()).toBe('disposed');
  });

  /**
   * The cancel a caller already started is the cancel disposal joins. Starting a second
   * one would abort a turn that is already being stopped and end the run twice.
   */
  it('joins the cancel a second caller asked for', async () => {
    const sending = createDeferred();
    const blocked = createDeferred();
    const aborting = createDeferred();
    const releaseAbort = createDeferred();
    const client = new FakeCopilotSdkClient({
      onSessionCreated: (created) => {
        created.sendBehavior = async () => {
          sending.resolve();
          await blocked.promise;
        };
        created.abortBehavior = async () => {
          aborting.resolve();
          await releaseAbort.promise;
        };
      },
    });
    const runtime = new FakeCopilotSdkRuntime(() => client);
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const run = session.execute(createRequest());
    const collected = collect(run.events);
    await sending.promise;
    run.cancel();
    await aborting.promise;
    run.cancel();
    session.cancel();
    releaseAbort.resolve();
    blocked.resolve();
    const events = turnFlow(await collected);

    expect(client.createdSessions[0]?.aborted).toBe(1);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'cancelled' });
    await session.dispose();
  });

  /**
   * A recovery disconnect that fails while the first disposal is waiting still has that
   * disposal to report to. Letting it land after the final teardown would leave the caller
   * told nothing, and the lease reportable only to a disposal nobody makes.
   */
  it('reports a recovery failure that lands while the first disposal waits', async () => {
    const disconnecting = createDeferred();
    const releaseDisconnect = createDeferred();
    const runtime = createRuntime((created) => {
      created.sendBehavior = async () => {
        throw new Error('read ECONNRESET');
      };
      created.disconnectBehavior = async () => {
        disconnecting.resolve();
        await releaseDisconnect.promise;
        throw new Error('the runtime refused to disconnect');
      };
    });
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const order: string[] = [];
    const run = session.execute(createRequest());
    const streamed = (async () => {
      for await (const event of run.events) {
        if (TERMINAL_EVENT_TYPES.includes(event.type)) order.push(event.type);
      }
    })();
    await disconnecting.promise;

    const disposal = disposalFailure(session);
    await settlePendingWork();

    expect(order).toEqual([]);

    releaseDisconnect.resolve();
    const failure = await disposal;
    await streamed;

    expect(failure.message).toMatch(/the runtime refused to disconnect/);
    expect(order).toEqual(['execution_error']);
  });

  /**
   * A disposal that had a flight to wait for still reports everything once. A second
   * disposal repeats that report rather than resolving as if the failure were gone.
   */
  it('reports the joined failure again on a later disposal', async () => {
    const disconnecting = createDeferred();
    const releaseDisconnect = createDeferred();
    const runtime = createRuntime((created) => {
      created.sendBehavior = async () => {
        throw new Error('read ECONNRESET');
      };
      created.disconnectBehavior = async () => {
        disconnecting.resolve();
        await releaseDisconnect.promise;
        throw new Error('the runtime refused to disconnect');
      };
    });
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const collected = collect(session.execute(createRequest()).events);
    await disconnecting.promise;
    const disposal = disposalFailure(session);
    releaseDisconnect.resolve();
    const first = await disposal;
    const second = await disposalFailure(session);

    expect(first.message).toMatch(/the runtime refused to disconnect/);
    expect(second.message).toBe(first.message);
    expect(terminalEvents(turnFlow(await collected))).toHaveLength(1);
  });
});

describe('CopilotExecutionSession failure recovery', () => {
  /** Rejects the first turn the way the SDK adapter maps that failure onto the port. */
  function failingSendRuntime(message: string): FakeCopilotSdkRuntime {
    let sends = 0;
    return new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      onSessionCreated: (created) => {
        created.sendBehavior = async () => {
          sends += 1;
          if (sends === 1) throw toCopilotSendError(new Error(message), 600_000);
        };
      },
    }));
  }

  it('aborts and restarts the runtime when the turn never reaches idle', async () => {
    const runtime = failingSendRuntime('Timeout after 600000ms waiting for session.idle');
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const events = turnFlow(await collect(session.execute(createRequest()).events));
    const failed = runtime.clients[0];

    expect(events.at(-1)).toMatchObject({
      category: 'transport',
      recoverable: true,
      type: 'execution_error',
    });
    expect(String((events.at(-1) as { message: string }).message))
      .toContain('within 10 minutes');
    expect(failed?.lastSession?.aborted).toBe(1);
    expect(failed?.lastSession?.disconnected).toBe(1);
    expect(failed?.stopped).toBe(1);
    await session.dispose();
  });

  it('resumes the native session on a fresh client after a transport failure',
    async () => {
      const runtime = failingSendRuntime('read ECONNRESET');
      const session = new CopilotExecutionBackend(createHost(), { runtime })
        .createSession(createSessionConfig());

      await collect(session.execute(createRequest()).events);
      const retry = turnFlow(await collect(session.execute(createRequest()).events));

      expect(runtime.clients).toHaveLength(2);
      expect(runtime.clients[1]?.resumedSessionIds).toEqual(['copilot-session-1']);
      expect(retry.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
      await session.dispose();
    });

  it('keeps the live session and the client after a plain provider failure', async () => {
    const runtime = failingSendRuntime('the model refused the request');
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest()).events);
    await collect(session.execute(createRequest()).events);

    expect(runtime.clients).toHaveLength(1);
    expect(runtime.clients[0]?.createdSessions).toHaveLength(1);
    expect(runtime.clients[0]?.stopped).toBe(0);
    await session.dispose();
  });

  it('ignores events from a session a failed turn dropped', async () => {
    let dropped: FakeCopilotSdkSession | undefined;
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      onSessionCreated: (created) => {
        created.sendBehavior = async () => {
          if (created.prompts.length === 1 && !dropped) {
            dropped = created;
            throw toCopilotSendError(new Error('read ECONNRESET'), 600_000);
          }
        };
      },
    }));
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest()).events);
    const run = session.execute(createRequest());
    const collected = collect(run.events);
    dropped?.emit(sdkEvent('assistant.message_delta', { delta: 'stale' }));
    const events = turnFlow(await collected);

    expect(events.some(event => event.type === 'text_delta')).toBe(false);
    await session.dispose();
  });

  it('keeps streaming events from a live session reused by a later turn', async () => {
    const runtime = createRuntime((sdkSession) => {
      sdkSession.sendBehavior = async () => {
        sdkSession.emit(sdkEvent('assistant.message_delta', {
          deltaContent: `turn-${sdkSession.prompts.length}`,
          messageId: `message-${sdkSession.prompts.length}`,
        }));
      };
    });
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest()).events);
    const second = turnFlow(await collect(session.execute(createRequest()).events));

    expect(runtime.lastClient?.createdSessions).toHaveLength(1);
    expect(second).toContainEqual(expect.objectContaining({
      text: 'turn-2',
      type: 'text_delta',
    }));
    await session.dispose();
  });
});

describe('CopilotExecutionSession cleanup outcomes', () => {
  it('reports what disposal could not release, after releasing the rest', async () => {
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      stopBehavior: async () => {
        throw new Error('the CLI process would not shut down');
      },
    }));
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest()).events);

    await expect(session.dispose()).rejects.toThrow(/would not shut down/);
    expect(runtime.lastClient?.lastSession?.disconnected).toBe(1);
    expect(session.getStatus()).toBe('disposed');
  });

  it('reports every failed cleanup step in one disposal failure', async () => {
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      onSessionCreated: (created) => {
        created.disconnectBehavior = async () => {
          throw new Error('disconnect refused');
        };
      },
      stopBehavior: async () => {
        throw new Error('stop refused');
      },
    }));
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    await collect(session.execute(createRequest()).events);
    const failure = await session.dispose().then(
      () => new Error('disposal unexpectedly succeeded'),
      (error: unknown) => error as Error,
    );

    expect(failure.message).toContain('disconnect refused');
    expect(failure.message).toContain('stop refused');
  });

  it('treats an already-deleted ephemeral session as clean', async () => {
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      deleteSessionBehavior: async () => 'missing',
    }));
    const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession(
      createSessionConfig({
        lifecycle: 'ephemeral',
        nativePersistence: 'disabled-if-supported',
      }),
    );

    await collect(session.execute(createRequest()).events);

    await expect(session.dispose()).resolves.toBeUndefined();
  });

  it('retries a failed ephemeral deletion through the next client', async () => {
    let deletions = 0;
    let cliPath = '/usr/local/bin/copilot';
    const host = createHost();
    Object.assign(host, { getResolvedProviderCliPath: async () => cliPath });
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      deleteSessionBehavior: async () => {
        deletions += 1;
        if (deletions === 1) throw new Error('the session store was busy');
        return 'deleted';
      },
    }));
    const session = new CopilotExecutionBackend(host, { runtime }).createSession(
      createSessionConfig({
        lifecycle: 'ephemeral',
        nativePersistence: 'disabled-if-supported',
      }),
    );

    await collect(session.execute(createRequest()).events);
    cliPath = '/opt/homebrew/bin/copilot';
    await collect(session.execute(createRequest()).events);

    expect(runtime.clients[0]?.deletedSessions).toEqual([]);
    expect(runtime.clients[1]?.deletedSessions).toEqual(['copilot-session-1']);
    await expect(session.dispose()).resolves.toBeUndefined();
  });

  it('reports an ephemeral deletion that never succeeds', async () => {
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      deleteSessionBehavior: async () => {
        throw new Error('the session store was busy');
      },
    }));
    const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession(
      createSessionConfig({
        lifecycle: 'ephemeral',
        nativePersistence: 'disabled-if-supported',
      }),
    );

    await collect(session.execute(createRequest()).events);

    await expect(session.dispose()).rejects.toThrow(/session store was busy/);
  });
});

describe('CopilotExecutionSession lifecycle fencing', () => {
  it('stops a client that finishes starting after disposal', async () => {
    const starting = createDeferred();
    const release = createDeferred();
    const client = new FakeCopilotSdkClient();
    const runtime = new FakeCopilotSdkRuntime(async () => {
      starting.resolve();
      await release.promise;
      return client;
    });
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const run = session.execute(createRequest());
    const collected = collect(run.events);
    await starting.promise;
    const disposal = session.dispose();
    release.resolve();
    await disposal;

    expect(client.stopped).toBe(1);
    expect(client.createdSessions).toEqual([]);
    expect(session.getStatus()).toBe('disposed');
    expect(turnFlow(await collected).at(-1)).toMatchObject({ type: 'cancelled' });
  });

  it('disconnects a native session created after disposal', async () => {
    const creating = createDeferred();
    const release = createDeferred();
    const client = new FakeCopilotSdkClient({
      sessionGate: async () => {
        creating.resolve();
        await release.promise;
      },
    });
    const runtime = new FakeCopilotSdkRuntime(() => client);
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const run = session.execute(createRequest());
    const collected = collect(run.events);
    await creating.promise;
    const disposal = session.dispose();
    release.resolve();
    await disposal;

    expect(client.lastSession?.prompts).toEqual([]);
    expect(client.lastSession?.disconnected).toBe(1);
    expect(client.stopped).toBe(1);
    expect(session.getStatus()).toBe('disposed');
    expect(turnFlow(await collected).at(-1)).toMatchObject({ type: 'cancelled' });
  });

  it('deletes an ephemeral native session created after disposal', async () => {
    const creating = createDeferred();
    const release = createDeferred();
    const client = new FakeCopilotSdkClient({
      sessionGate: async () => {
        creating.resolve();
        await release.promise;
      },
    });
    const runtime = new FakeCopilotSdkRuntime(() => client);
    const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession(
      createSessionConfig({
        lifecycle: 'ephemeral',
        nativePersistence: 'disabled-if-supported',
      }),
    );

    const run = session.execute(createRequest());
    const collected = collect(run.events);
    await creating.promise;
    const disposal = session.dispose();
    release.resolve();
    await disposal;

    expect(client.deletedSessions).toEqual(['copilot-session-1']);
    expect(client.stopped).toBe(1);
    expect(turnFlow(await collected).at(-1)).toMatchObject({ type: 'cancelled' });
  });

  it('keeps the disposed status when a late turn settles', async () => {
    const starting = createDeferred();
    const release = createDeferred();
    const client = new FakeCopilotSdkClient();
    const runtime = new FakeCopilotSdkRuntime(async () => {
      starting.resolve();
      await release.promise;
      return client;
    });
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());
    const statuses: string[] = [];
    session.onEvent(event => {
      if (event.type === 'session_state_changed') statuses.push(event.snapshot.status);
    });

    session.execute(createRequest());
    await starting.promise;
    const disposal = session.dispose();
    release.resolve();
    await disposal;
    await Promise.resolve();

    expect(session.getStatus()).toBe('disposed');
    expect(statuses.filter(status => status !== 'disposed')).toEqual([]);
  });

  it('stops a client that finishes starting after the turn was cancelled', async () => {
    const starting = createDeferred();
    const release = createDeferred();
    const stopped = createDeferred();
    const client = new FakeCopilotSdkClient({ stopBehavior: async () => stopped.resolve() });
    const runtime = new FakeCopilotSdkRuntime(async () => {
      starting.resolve();
      await release.promise;
      return client;
    });
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const run = session.execute(createRequest());
    const collected = collect(run.events);
    await starting.promise;
    run.cancel();
    release.resolve();
    await collected;
    await stopped.promise;

    expect(client.stopped).toBe(1);
    expect(client.createdSessions).toEqual([]);
    expect(session.getStatus()).toBe('idle');

    await session.dispose();

    expect(client.stopped).toBe(1);
  });
});

/** The failure a disposal reported, so repeated disposals can be compared. */
async function disposalFailure(session: ProviderExecutionSession): Promise<Error> {
  return session.dispose().then(
    () => new Error('disposal unexpectedly succeeded'),
    (error: unknown) => error as Error,
  );
}

/** Lets a pending task that is not waiting on anything settle before the assertion. */
async function settlePendingWork(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('CopilotExecutionSession failure recovery cleanup', () => {
  it('reports the turn failure when the reset disconnect rejects', async () => {
    const runtime = createRuntime((created) => {
      created.sendBehavior = async () => {
        throw new Error('Session copilot-session-1 does not exist');
      };
      created.disconnectBehavior = async () => {
        throw new Error('the runtime refused to disconnect');
      };
    });
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const events = turnFlow(await collect(session.execute(createRequest()).events));

    expect(events.filter(event => event.type === 'execution_error')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      category: 'provider-session-missing',
      recoverable: true,
      type: 'execution_error',
    });
    expect(session.getSnapshot()).toMatchObject({ status: 'invalidated' });
    await expect(session.dispose()).rejects.toThrow(/refused to disconnect/);
  });

  it('reports an ephemeral deletion left unresolved with no client to retry it', async () => {
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      deleteSessionBehavior: async () => {
        throw new Error('the session store was busy');
      },
      onSessionCreated: (created) => {
        created.sendBehavior = async () => {
          throw new Error('read ECONNRESET');
        };
      },
    }));
    const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession(
      createSessionConfig({
        lifecycle: 'ephemeral',
        nativePersistence: 'disabled-if-supported',
      }),
    );

    await collect(session.execute(createRequest()).events);

    expect(runtime.clients).toHaveLength(1);
    await expect(session.dispose()).rejects.toThrow(/copilot-session-1/);
  });
});

describe('CopilotExecutionSession late native cleanup', () => {
  it('deletes and stops around a late session whose disconnect rejects', async () => {
    const creating = createDeferred();
    const release = createDeferred();
    const client = new FakeCopilotSdkClient({
      onSessionCreated: (created) => {
        created.disconnectBehavior = async () => {
          throw new Error('the late session refused to disconnect');
        };
      },
      sessionGate: async () => {
        creating.resolve();
        await release.promise;
      },
    });
    const runtime = new FakeCopilotSdkRuntime(() => client);
    const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession(
      createSessionConfig({
        lifecycle: 'ephemeral',
        nativePersistence: 'disabled-if-supported',
      }),
    );

    const run = session.execute(createRequest());
    const collected = collect(run.events);
    await creating.promise;
    const disposal = session.dispose();
    release.resolve();

    await expect(disposal).rejects.toThrow(/refused to disconnect/);
    expect(client.deletedSessions).toEqual(['copilot-session-1']);
    expect(client.stopped).toBe(1);
    expect(turnFlow(await collected).at(-1)).toMatchObject({ type: 'cancelled' });
  });

  it('reports a late ephemeral session it could neither delete nor leave behind', async () => {
    const creating = createDeferred();
    const release = createDeferred();
    const client = new FakeCopilotSdkClient({
      deleteSessionBehavior: async () => {
        throw new Error('the session store was busy');
      },
      sessionGate: async () => {
        creating.resolve();
        await release.promise;
      },
    });
    const runtime = new FakeCopilotSdkRuntime(() => client);
    const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession(
      createSessionConfig({
        lifecycle: 'ephemeral',
        nativePersistence: 'disabled-if-supported',
      }),
    );

    const run = session.execute(createRequest());
    const collected = collect(run.events);
    await creating.promise;
    const disposal = session.dispose();
    release.resolve();

    await expect(disposal).rejects.toThrow(/session store was busy/);
    expect(client.stopped).toBe(1);
    expect(turnFlow(await collected).at(-1)).toMatchObject({ type: 'cancelled' });
  });

  it('waits for the acquisition a cancelled turn left behind before disposing', async () => {
    const started = [createDeferred(), createDeferred()];
    const release = [createDeferred(), createDeferred()];
    const clients = [new FakeCopilotSdkClient(), new FakeCopilotSdkClient()];
    let creations = 0;
    const runtime = new FakeCopilotSdkRuntime(async () => {
      const index = creations++;
      started[index]?.resolve();
      await release[index]?.promise;
      return clients[index] as FakeCopilotSdkClient;
    });
    const host = createHost();
    let cliPath = '/usr/local/bin/copilot';
    Object.assign(host, { getResolvedProviderCliPath: async () => cliPath });
    const session = new CopilotExecutionBackend(host, { runtime })
      .createSession(createSessionConfig());

    const first = session.execute(createRequest());
    const firstEvents = collect(first.events);
    await started[0]?.promise;
    first.cancel();
    await firstEvents;

    cliPath = '/opt/homebrew/bin/copilot';
    const second = session.execute(createRequest());
    const secondEvents = collect(second.events);
    await started[1]?.promise;
    release[0]?.resolve();
    await settlePendingWork();

    let disposed = false;
    const disposal = session.dispose().then(
      () => { disposed = true; },
      () => { disposed = true; },
    );
    await settlePendingWork();

    expect(disposed).toBe(false);

    release[1]?.resolve();
    await disposal;
    await secondEvents;

    expect(clients[0]?.stopped).toBe(1);
    expect(clients[1]?.stopped).toBe(1);
    expect(session.getStatus()).toBe('disposed');
  });
});

/**
 * Holds the first turn open so cancellation lands mid-send, and lets a later turn on the
 * same native session complete.
 */
function blockFirstSend(
  sending: Deferred<void>,
  blocked: Deferred<void>,
): () => Promise<void> {
  let sends = 0;
  return async () => {
    sends += 1;
    if (sends > 1) return;
    sending.resolve();
    await blocked.promise;
  };
}

describe('CopilotExecutionSession terminal events', () => {
  it('ends a cancelled run once when its turn then fails', async () => {
    const sending = createDeferred();
    const failSend = createDeferred();
    const client = new FakeCopilotSdkClient({
      onSessionCreated: (created) => {
        created.sendBehavior = async () => {
          sending.resolve();
          await failSend.promise;
          throw new Error('read ECONNRESET');
        };
      },
    });
    const runtime = new FakeCopilotSdkRuntime(() => client);
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const run = session.execute(createRequest());
    const collected = collect(run.events);
    await sending.promise;
    run.cancel();
    failSend.resolve();
    const events = turnFlow(await collected);

    expect(events.filter(event => (
      event.type === 'cancelled'
      || event.type === 'execution_error'
      || event.type === 'turn_completed'
    ))).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'cancelled' });
    await session.dispose();
  });
});

describe('CopilotExecutionSession cancellation outcomes', () => {
  it('drops a live session whose abort rejected instead of reusing it', async () => {
    const sending = createDeferred();
    const blocked = createDeferred();
    const holdFirstTurn = blockFirstSend(sending, blocked);
    const client = new FakeCopilotSdkClient({
      onSessionCreated: (created) => {
        created.sendBehavior = holdFirstTurn;
        if (created.sessionId !== 'copilot-session-1') return;
        created.abortBehavior = async () => {
          throw new Error('the runtime refused the abort');
        };
      },
    });
    const runtime = new FakeCopilotSdkRuntime(() => client);
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const run = session.execute(createRequest());
    const cancelled = collect(run.events);
    await sending.promise;
    run.cancel();

    expect(turnFlow(await cancelled).at(-1)).toMatchObject({ type: 'cancelled' });

    const retry = turnFlow(await collect(session.execute(createRequest()).events));

    expect(retry.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
    expect(client.createdSessions).toHaveLength(2);
    expect(client.createdSessions[0]?.prompts).toHaveLength(1);
    blocked.resolve();
    await session.dispose();
  });

  it('drops a live session whose abort never answered instead of reusing it', async () => {
    jest.useFakeTimers();
    try {
      const sending = createDeferred();
      const blocked = createDeferred();
      const holdFirstTurn = blockFirstSend(sending, blocked);
      const client = new FakeCopilotSdkClient({
        onSessionCreated: (created) => {
          created.sendBehavior = holdFirstTurn;
          if (created.sessionId !== 'copilot-session-1') return;
          created.abortBehavior = () => new Promise<void>(() => {});
        },
      });
      const runtime = new FakeCopilotSdkRuntime(() => client);
      const session = new CopilotExecutionBackend(createHost(), { runtime })
        .createSession(createSessionConfig());

      const run = session.execute(createRequest());
      const cancelled = collect(run.events);
      await sending.promise;
      run.cancel();
      await jest.advanceTimersByTimeAsync(5_000);

      expect(turnFlow(await cancelled).at(-1)).toMatchObject({ type: 'cancelled' });

      const retry = turnFlow(await collect(session.execute(createRequest()).events));

      expect(retry.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
      expect(client.createdSessions).toHaveLength(2);
      blocked.resolve();
      await session.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps reusing a live session whose abort was acknowledged', async () => {
    const sending = createDeferred();
    const blocked = createDeferred();
    const holdFirstTurn = blockFirstSend(sending, blocked);
    const client = new FakeCopilotSdkClient({
      onSessionCreated: (created) => {
        created.sendBehavior = holdFirstTurn;
      },
    });
    const runtime = new FakeCopilotSdkRuntime(() => client);
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const run = session.execute(createRequest());
    const cancelled = collect(run.events);
    await sending.promise;
    run.cancel();
    await cancelled;
    await collect(session.execute(createRequest()).events);

    expect(client.createdSessions).toHaveLength(1);
    expect(client.createdSessions[0]?.disconnected).toBe(0);
    blocked.resolve();
    await session.dispose();
  });
});

/**
 * Wedges the first native session's shutdown, and optionally its abort, so a runtime that
 * stopped answering can be observed at each call site while later sessions still settle.
 */
function wedgeFirstSessionShutdown(options: { readonly abort?: boolean } = {}): (
  session: FakeCopilotSdkSession,
) => void {
  let sessions = 0;
  return (created) => {
    sessions += 1;
    if (sessions > 1) return;
    if (options.abort) created.abortBehavior = () => new Promise<void>(() => {});
    created.disconnectBehavior = () => new Promise<void>(() => {});
  };
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

/**
 * A native shutdown that stopped answering is bounded exactly like an abort: it cannot
 * hold cancellation, failure recovery, the release of a session no turn owns, or disposal
 * open, and what it could not do is reported rather than dropped.
 */
describe('CopilotExecutionSession bounded native shutdown', () => {
  it('cancels a turn whose disconnect never answers', async () => {
    await withFakeTimers(async () => {
      const sending = createDeferred();
      const blocked = createDeferred();
      const holdFirstTurn = blockFirstSend(sending, blocked);
      const wedgeShutdown = wedgeFirstSessionShutdown({ abort: true });
      const client = new FakeCopilotSdkClient({
        onSessionCreated: (created) => {
          created.sendBehavior = holdFirstTurn;
          wedgeShutdown(created);
        },
      });
      const runtime = new FakeCopilotSdkRuntime(() => client);
      const session = new CopilotExecutionBackend(createHost(), { runtime })
        .createSession(createSessionConfig());

      const run = session.execute(createRequest());
      const cancelled = collect(run.events);
      await sending.promise;
      run.cancel();
      await jest.advanceTimersByTimeAsync(10_000);

      expect(turnFlow(await cancelled).filter(event => event.type === 'cancelled'))
        .toHaveLength(1);
      expect(client.createdSessions[0]?.disconnected).toBe(1);

      const retry = turnFlow(await collect(session.execute(createRequest()).events));

      expect(retry.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
      blocked.resolve();
      const disposal = disposalFailure(session);
      await jest.advanceTimersByTimeAsync(10_000);

      expect((await disposal).message).toMatch(/did not answer/);
    });
  });

  it('reports the turn failure when the reset disconnect never answers', async () => {
    await withFakeTimers(async () => {
      const runtime = createRuntime((created) => {
        created.sendBehavior = async () => {
          throw new Error('Session copilot-session-1 does not exist');
        };
        created.disconnectBehavior = () => new Promise<void>(() => {});
      });
      const session = new CopilotExecutionBackend(createHost(), { runtime })
        .createSession(createSessionConfig());

      const collected = collect(session.execute(createRequest()).events);
      await jest.advanceTimersByTimeAsync(10_000);
      const events = turnFlow(await collected);

      expect(events.filter(event => event.type === 'execution_error')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        category: 'provider-session-missing',
        type: 'execution_error',
      });
      const disposal = disposalFailure(session);
      await jest.advanceTimersByTimeAsync(10_000);

      expect((await disposal).message).toMatch(/did not answer/);
    });
  });

  it('releases a session no turn owns whose disconnect never answers', async () => {
    await withFakeTimers(async () => {
      const creating = createDeferred();
      const release = createDeferred();
      const client = new FakeCopilotSdkClient({
        onSessionCreated: wedgeFirstSessionShutdown(),
        sessionGate: async () => {
          creating.resolve();
          await release.promise;
        },
      });
      const runtime = new FakeCopilotSdkRuntime(() => client);
      const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession(
        createSessionConfig({
          lifecycle: 'ephemeral',
          nativePersistence: 'disabled-if-supported',
        }),
      );

      const run = session.execute(createRequest());
      const collected = collect(run.events);
      await creating.promise;
      const disposal = disposalFailure(session);
      release.resolve();
      await jest.advanceTimersByTimeAsync(10_000);

      expect((await disposal).message).toMatch(/did not answer/);
      expect(client.deletedSessions).toEqual(['copilot-session-1']);
      expect(client.stopped).toBe(1);
      expect(turnFlow(await collected).at(-1)).toMatchObject({ type: 'cancelled' });
    });
  });

  it('finishes disposal when the teardown disconnect never answers', async () => {
    await withFakeTimers(async () => {
      const runtime = createRuntime((created) => {
        created.disconnectBehavior = () => new Promise<void>(() => {});
      });
      const session = new CopilotExecutionBackend(createHost(), { runtime })
        .createSession(createSessionConfig());

      await collect(session.execute(createRequest()).events);
      const disposal = disposalFailure(session);
      await jest.advanceTimersByTimeAsync(10_000);

      expect((await disposal).message).toMatch(/did not answer/);
      expect(runtime.lastClient?.stopped).toBe(1);
      expect(session.getStatus()).toBe('disposed');
    });
  });
});

/**
 * A native session Claudian dropped can still be running, so its callbacks stay bound to
 * the session that was created with them. A late approval or question is answered on that
 * session's terms and never attaches to the turn that replaced it.
 */
describe('CopilotExecutionSession session-scoped interactions', () => {
  it('refuses an approval from a session a failed disconnect dropped', async () => {
    const sending = createDeferred();
    const blocked = createDeferred();
    const holdFirstTurn = blockFirstSend(sending, blocked);
    const client = new FakeCopilotSdkClient({
      onSessionCreated: (created) => {
        created.sendBehavior = holdFirstTurn;
        if (created.sessionId !== 'copilot-session-1') return;
        created.abortBehavior = async () => {
          throw new Error('the runtime refused the abort');
        };
        created.disconnectBehavior = async () => {
          throw new Error('the runtime refused to disconnect');
        };
      },
    });
    const runtime = new FakeCopilotSdkRuntime(() => client);
    const approvals: ProviderApprovalInteractionRequest[] = [];
    const questions: ProviderQuestionInteractionRequest[] = [];
    const config = createSessionConfig();
    const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession({
      ...config,
      interactionPort: {
        ...config.interactionPort,
        askUserQuestion: async (request) => {
          questions.push(request);
          return { answers: { 'Continue?': 'Yes' }, interactionId: request.interactionId };
        },
        requestApproval: async (request) => {
          approvals.push(request);
          return { decision: 'allow', interactionId: request.interactionId };
        },
      },
    });

    const run = session.execute(createRequest());
    const cancelled = collect(run.events);
    await sending.promise;
    run.cancel();
    await cancelled;

    const secondTurn = collect(session.execute(createRequest()).events);
    const dropped = client.createdSessions[0] as FakeCopilotSdkSession;

    await expect(dropped.requestPermission(
      { command: 'rm -rf /', kind: 'shell' } as unknown as CopilotSdkPermissionRequest,
    )).resolves.toMatchObject({ kind: 'reject' });
    await expect(dropped.requestUserInput(
      { allowFreeform: true, question: 'Continue?' } as unknown as CopilotSdkUserInputRequest,
    )).resolves.toEqual({ answer: '', wasFreeform: true });

    expect(approvals).toEqual([]);
    expect(questions).toEqual([]);
    expect(turnFlow(await secondTurn).at(-1)).toMatchObject({
      reason: 'completed',
      type: 'turn_completed',
    });
    blocked.resolve();
    await expect(session.dispose()).rejects.toThrow(/refused to disconnect/);
  });

  it('routes an approval from the session the live turn owns', async () => {
    const approvals: ProviderApprovalInteractionRequest[] = [];
    const client = new FakeCopilotSdkClient({
      onSessionCreated: (created) => {
        created.sendBehavior = async () => {
          await created.requestPermission(
            { command: 'ls', kind: 'shell' } as unknown as CopilotSdkPermissionRequest,
          );
        };
      },
    });
    const runtime = new FakeCopilotSdkRuntime(() => client);
    const config = createSessionConfig();
    const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession({
      ...config,
      interactionPort: {
        ...config.interactionPort,
        requestApproval: async (request) => {
          approvals.push(request);
          return { decision: 'allow', interactionId: request.interactionId };
        },
      },
    });

    await collect(session.execute(createRequest()).events);

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ toolName: 'shell' });
    await session.dispose();
  });

  /**
   * Dismissal is addressed by interaction id, and the coordinator that issued those ids
   * owns it: it dismisses everything the turn raised when the turn is cancelled and again
   * when it ends. A dismissal from here can only name an id the provider issued, and it
   * has none to name — the interaction handler generates one per request and hands it
   * straight to the port.
   */
  it('dismisses no interaction it did not issue when a turn is cancelled', async () => {
    const issued: string[] = [];
    const dismissed: string[] = [];
    const raised = createDeferred();
    const client = new FakeCopilotSdkClient({
      onSessionCreated: (created) => {
        created.sendBehavior = async () => {
          await created.requestPermission(
            { command: 'ls', kind: 'shell' } as unknown as CopilotSdkPermissionRequest,
          );
        };
      },
    });
    const runtime = new FakeCopilotSdkRuntime(() => client);
    const config = createSessionConfig();
    const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession({
      ...config,
      interactionPort: {
        ...config.interactionPort,
        dismissInteraction: (interactionId) => {
          dismissed.push(interactionId);
        },
        requestApproval: async (request) => {
          issued.push(request.interactionId);
          raised.resolve();
          return new Promise(() => {});
        },
      },
    });

    const run = session.execute(createRequest());
    const collected = collect(run.events);
    await raised.promise;
    run.cancel();

    expect(turnFlow(await collected).at(-1)).toMatchObject({ type: 'cancelled' });
    expect(issued).toHaveLength(1);
    for (const interactionId of dismissed) {
      expect(issued).toContain(interactionId);
    }
    await session.dispose();
  });
});

/** Every event that ends a run. Exactly one of these may reach a run's consumer. */
const TERMINAL_EVENT_TYPES = ['cancelled', 'execution_error', 'turn_completed'];

function terminalEvents(events: readonly ProviderExecutionEvent[]): ProviderExecutionEvent[] {
  return events.filter(event => TERMINAL_EVENT_TYPES.includes(event.type));
}

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

/**
 * A runtime that answers a release long after the budget elapsed has no caller left to
 * report to. The run it belonged to has already ended — exactly once — and the late answer
 * must not surface as a rejection nobody handled.
 */
describe('CopilotExecutionSession late native answers', () => {
  it('ends a cancelled run once and absorbs a disconnect that rejects afterwards', async () => {
    await withoutUnhandledRejections(async () => {
      let collected: ProviderExecutionEvent[] = [];
      let failure!: Error;

      await withFakeTimers(async () => {
        const sending = createDeferred();
        const blocked = createDeferred();
        const holdFirstTurn = blockFirstSend(sending, blocked);
        let sessions = 0;
        const client = new FakeCopilotSdkClient({
          onSessionCreated: (created) => {
            created.sendBehavior = holdFirstTurn;
            sessions += 1;
            if (sessions > 1) return;
            created.abortBehavior = () => new Promise<void>(() => {});
            created.disconnectBehavior = () => new Promise<void>((_resolve, reject) => {
              window.setTimeout(() => {
                reject(new Error('the runtime gave up on the disconnect'));
              }, 60_000);
            });
          },
        });
        const runtime = new FakeCopilotSdkRuntime(() => client);
        const session = new CopilotExecutionBackend(createHost(), { runtime })
          .createSession(createSessionConfig());

        const run = session.execute(createRequest());
        const events = collect(run.events);
        await sending.promise;
        run.cancel();
        await jest.advanceTimersByTimeAsync(10_000);
        collected = turnFlow(await events);

        blocked.resolve();
        const disposal = disposalFailure(session);
        await jest.advanceTimersByTimeAsync(120_000);
        failure = await disposal;
      });

      expect(terminalEvents(collected)).toHaveLength(1);
      expect(collected.at(-1)).toMatchObject({ type: 'cancelled' });
      expect(failure.message).toMatch(/did not answer/);
      expect(failure.message).not.toMatch(/gave up on the disconnect/);
    });
  });

  it('ends a failed turn once when its recovery disconnect answers afterwards', async () => {
    await withoutUnhandledRejections(async () => {
      let collected: ProviderExecutionEvent[] = [];

      await withFakeTimers(async () => {
        const runtime = createRuntime((created) => {
          created.sendBehavior = async () => {
            throw new Error('Session copilot-session-1 does not exist');
          };
          created.disconnectBehavior = () => new Promise<void>((_resolve, reject) => {
            window.setTimeout(() => reject(new Error('too late')), 60_000);
          });
        });
        const session = new CopilotExecutionBackend(createHost(), { runtime })
          .createSession(createSessionConfig());

        const events = collect(session.execute(createRequest()).events);
        await jest.advanceTimersByTimeAsync(10_000);
        collected = turnFlow(await events);

        const disposal = disposalFailure(session);
        await jest.advanceTimersByTimeAsync(120_000);
        await disposal;
      });

      expect(terminalEvents(collected)).toHaveLength(1);
      expect(collected.at(-1)).toMatchObject({ type: 'execution_error' });
    });
  });
});

/** A native call that never answers at all. */
function neverAnswers(): Promise<void> {
  return new Promise<void>(() => {});
}

/**
 * Acquiring native state is bounded exactly like releasing it. A CLI that never answers
 * the authentication gate, a client start, a session creation or resume, or a per-turn
 * model change cannot hold the turn open, and it cannot hold cancellation or disposal
 * open behind it. Whatever the CLI hands back afterwards is released where it arrives,
 * because the run that asked for it has already ended.
 */
describe('CopilotExecutionSession bounded native acquisition', () => {
  it('fails a turn whose authentication gate never answers, and abandons the client',
    async () => {
      await withFakeTimers(async () => {
        const client = new FakeCopilotSdkClient({ authStatusBehavior: neverAnswers });
        const runtime = new FakeCopilotSdkRuntime(() => client);
        const session = new CopilotExecutionBackend(createHost(), { runtime })
          .createSession(createSessionConfig());

        const collected = collect(session.execute(createRequest()).events);
        await jest.advanceTimersByTimeAsync(30_000);
        const events = turnFlow(await collected);

        expect(terminalEvents(events)).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({
          category: 'transport',
          type: 'execution_error',
        });
        expect(events.at(-1)).toMatchObject({ message: expect.stringMatching(/did not answer/) });
        expect(client.stopped).toBe(1);
        expect(client.forceStopped).toBe(1);
        expect(client.createdSessions).toEqual([]);

        await session.dispose();

        expect(session.getStatus()).toBe('disposed');
      });
    });

  it('cancels and disposes a turn whose authentication gate never answers', async () => {
    await withFakeTimers(async () => {
      const gated = createDeferred();
      const client = new FakeCopilotSdkClient({
        authStatusBehavior: () => {
          gated.resolve();
          return new Promise<void>(() => {});
        },
      });
      const runtime = new FakeCopilotSdkRuntime(() => client);
      const session = new CopilotExecutionBackend(createHost(), { runtime })
        .createSession(createSessionConfig());

      const run = session.execute(createRequest());
      const collected = collect(run.events);
      await gated.promise;
      run.cancel();
      await jest.advanceTimersByTimeAsync(30_000);
      const events = turnFlow(await collected);

      expect(terminalEvents(events)).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'cancelled' });

      await session.dispose();

      expect(session.getStatus()).toBe('disposed');
      expect(client.stopped).toBe(1);
      expect(client.forceStopped).toBe(1);
    });
  });

  it('cancels and disposes a turn whose client never finishes starting', async () => {
    await withFakeTimers(async () => {
      const starting = createDeferred();
      const runtime = new FakeCopilotSdkRuntime(() => {
        starting.resolve();
        return new Promise<FakeCopilotSdkClient>(() => {});
      });
      const session = new CopilotExecutionBackend(createHost(), { runtime })
        .createSession(createSessionConfig());

      const run = session.execute(createRequest());
      const collected = collect(run.events);
      await starting.promise;
      run.cancel();
      await jest.advanceTimersByTimeAsync(30_000);

      expect(turnFlow(await collected).at(-1)).toMatchObject({ type: 'cancelled' });

      await session.dispose();

      expect(session.getStatus()).toBe('disposed');
    });
  });

  /**
   * The SDK boundary owns the deadline on a create or a resume: it stops and kills the CLI
   * that went silent before rejecting, which only the owner of that client can do. What
   * reaches this layer is therefore a transport failure about a process that is already
   * gone, and the response to it is the ordinary one — drop the client, so the next turn
   * starts a fresh CLI rather than sending into one that stopped answering.
   */
  it('drops the client when the SDK reports a create it had to end', async () => {
    const client = new FakeCopilotSdkClient({
      sessionGate: async () => {
        throw new CopilotRuntimeError(
          'transport',
          'Copilot did not open a session within 60 seconds. The CLI was terminated; '
          + 'send the message again to start a fresh one.',
        );
      },
    });
    const runtime = new FakeCopilotSdkRuntime(() => client);
    const session = new CopilotExecutionBackend(createHost(), { runtime })
      .createSession(createSessionConfig());

    const events = turnFlow(await collect(session.execute(createRequest()).events));

    expect(terminalEvents(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      category: 'transport',
      message: expect.stringContaining('The CLI was terminated'),
      type: 'execution_error',
    });
    expect(client.stopped).toBe(1);
    expect(client.createdSessions).toEqual([]);

    await expect(session.dispose()).resolves.toBeUndefined();

    expect(session.getStatus()).toBe('disposed');
    expect(client.stopped).toBe(1);
  });

  it('reports a resume the SDK could not complete against the seeded session', async () => {
    const client = new FakeCopilotSdkClient({
      sessionGate: async () => {
        throw new CopilotRuntimeError(
          'transport',
          'Copilot did not resume the session within 60 seconds. The CLI was terminated.',
        );
      },
    });
    const runtime = new FakeCopilotSdkRuntime(() => client);
    const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession(
      createSessionConfig({ resumeSeed: { providerSessionId: 'copilot-session-kept' } }),
    );

    const events = turnFlow(await collect(session.execute(createRequest()).events));

    expect(terminalEvents(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      category: 'transport',
      type: 'execution_error',
    });
    expect(client.resumedSessionIds).toEqual(['copilot-session-kept']);
    expect(client.stopped).toBe(1);
    expect(client.createdSessions).toEqual([]);

    await expect(session.dispose()).resolves.toBeUndefined();

    expect(session.getStatus()).toBe('disposed');
    expect(client.stopped).toBe(1);
  });

  /**
   * A session the CLI hands back once the turn that asked for it has been cancelled
   * belongs to nobody, so it is released where it arrives rather than left running. The
   * ephemeral data Claudian created for it is accounted for first, and a deletion that
   * fails reaches the caller through the disposal that drains the acquisition — the only
   * disposal a lifecycle lease ever waits on is the first one.
   */
  it('reports a lease from a session the CLI hands back after the turn was cancelled',
    async () => {
      await withoutUnhandledRejections(async () => {
        const creating = createDeferred();
        const arriving = createDeferred();
        const client = new FakeCopilotSdkClient({
          deleteSessionBehavior: async () => {
            throw new Error('the session store was busy');
          },
          sessionGate: () => {
            creating.resolve();
            return arriving.promise;
          },
        });
        const runtime = new FakeCopilotSdkRuntime(() => client);
        const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession(
          createSessionConfig({
            lifecycle: 'ephemeral',
            nativePersistence: 'disabled-if-supported',
          }),
        );

        const run = session.execute(createRequest());
        const collected = collect(run.events);
        await creating.promise;
        run.cancel();
        const disposal = disposalFailure(session);
        arriving.resolve();

        expect((await disposal).message).toMatch(
          /deleting the ephemeral session copilot-session-1.*session store was busy/,
        );
        expect(client.createdSessions[0]?.disconnected).toBe(1);
        expect(client.createdSessions[0]?.prompts).toEqual([]);
        expect(client.stopped).toBe(1);
        expect(session.getStatus()).toBe('disposed');
        expect(turnFlow(await collected).at(-1)).toMatchObject({ type: 'cancelled' });
      });
    });

  /**
   * A model change the runtime never acknowledged says nothing about what the next prompt
   * would run as, so the live session is dropped rather than reused.
   */
  it('drops a live session whose model change never answers', async () => {
    await withFakeTimers(async () => {
      const client = new FakeCopilotSdkClient({
        onSessionCreated: (created) => {
          if (created.sessionId !== 'copilot-session-1') return;
          created.setModelBehavior = neverAnswers;
        },
      });
      const runtime = new FakeCopilotSdkRuntime(() => client);
      const session = new CopilotExecutionBackend(createHost(), { runtime })
        .createSession(createSessionConfig());

      await collect(session.execute(createRequest()).events);
      const collected = collect(session.execute(createRequest()).events);
      await jest.advanceTimersByTimeAsync(30_000);
      const events = turnFlow(await collected);

      expect(terminalEvents(events)).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        category: 'transport',
        type: 'execution_error',
      });
      expect(client.createdSessions[0]?.disconnected).toBe(1);

      const retry = turnFlow(await collect(session.execute(createRequest()).events));

      expect(retry.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
      expect(client.createdSessions).toHaveLength(2);
      await session.dispose();
    });
  });
});

/**
 * Deleting the ephemeral data Claudian created is a native call like any other, so a CLI
 * that stops answering it cannot hold teardown short of the shutdown that follows it. The
 * lease is accounted for exactly as a refused deletion is — carried to the next client, or
 * reported when there is none — and the CLI is still stopped either way.
 */
describe('CopilotExecutionSession bounded ephemeral deletion', () => {
  it('stops the CLI and reports the lease when the deletion never answers', async () => {
    await withFakeTimers(async () => {
      const client = new FakeCopilotSdkClient({ deleteSessionBehavior: neverAnswers });
      const runtime = new FakeCopilotSdkRuntime(() => client);
      const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession(
        createSessionConfig({
          lifecycle: 'ephemeral',
          nativePersistence: 'disabled-if-supported',
        }),
      );

      await collect(session.execute(createRequest()).events);
      const disposal = disposalFailure(session);
      await jest.advanceTimersByTimeAsync(30_000);

      expect((await disposal).message)
        .toMatch(/deleting the ephemeral session copilot-session-1.*did not answer/);
      expect(client.stopped).toBe(1);
      expect(client.createdSessions[0]?.disconnected).toBe(1);
      expect(session.getStatus()).toBe('disposed');
    });
  });

  it('carries a deletion that never answers to the next client', async () => {
    await withFakeTimers(async () => {
      let cliPath = '/usr/local/bin/copilot';
      const host = createHost();
      Object.assign(host, { getResolvedProviderCliPath: async () => cliPath });
      let clients = 0;
      const runtime = new FakeCopilotSdkRuntime(() => {
        clients += 1;
        return new FakeCopilotSdkClient(
          clients === 1 ? { deleteSessionBehavior: neverAnswers } : {},
        );
      });
      const session = new CopilotExecutionBackend(host, { runtime }).createSession(
        createSessionConfig({
          lifecycle: 'ephemeral',
          nativePersistence: 'disabled-if-supported',
        }),
      );

      await collect(session.execute(createRequest()).events);
      cliPath = '/opt/homebrew/bin/copilot';
      const retried = collect(session.execute(createRequest()).events);
      await jest.advanceTimersByTimeAsync(30_000);

      expect(turnFlow(await retried).at(-1))
        .toMatchObject({ reason: 'completed', type: 'turn_completed' });
      expect(runtime.clients[0]?.deletedSessions).toEqual([]);
      expect(runtime.clients[0]?.stopped).toBe(1);
      expect(runtime.clients[1]?.deletedSessions).toEqual(['copilot-session-1']);

      await session.dispose();
    });
  });

  /**
   * A deletion that goes silent while a run is being released must not produce a second
   * ending for that run, or a second disposed snapshot for the session.
   */
  it('ends a released run once while its ephemeral deletion never answers', async () => {
    await withFakeTimers(async () => {
      const creating = createDeferred();
      const release = createDeferred();
      const client = new FakeCopilotSdkClient({
        deleteSessionBehavior: neverAnswers,
        sessionGate: async () => {
          creating.resolve();
          await release.promise;
        },
      });
      const runtime = new FakeCopilotSdkRuntime(() => client);
      const session = new CopilotExecutionBackend(createHost(), { runtime }).createSession(
        createSessionConfig({
          lifecycle: 'ephemeral',
          nativePersistence: 'disabled-if-supported',
        }),
      );

      const run = session.execute(createRequest());
      const collected = collect(run.events);
      await creating.promise;
      const disposal = disposalFailure(session);
      release.resolve();
      await jest.advanceTimersByTimeAsync(30_000);
      const published = await collected;

      expect((await disposal).message).toMatch(/did not answer/);
      expect(terminalEvents(published)).toHaveLength(1);
      expect(published.at(-1)).toMatchObject({ type: 'cancelled' });
      expect(client.stopped).toBe(1);
      expect(session.getStatus()).toBe('disposed');
    });
  });
});
