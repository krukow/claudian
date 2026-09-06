import type {
  CopilotSdkClient,
  CopilotSdkClientOptions,
  CopilotSdkEvent,
  CopilotSdkModel,
  CopilotSdkPermissionRequest,
  CopilotSdkPermissionResult,
  CopilotSdkRuntime,
  CopilotSdkSession,
  CopilotSdkSessionConfig,
  CopilotSdkSessionDeletion,
  CopilotSdkUserInputRequest,
  CopilotSdkUserInputResponse,
} from '@/providers/copilot/sdk/CopilotSdkPort';

/**
 * A fake `@github/copilot-sdk` runtime. Production modules only ever see the SDK port,
 * so this plus a fake CLI path is the entire mocked boundary for Copilot tests.
 */
export class FakeCopilotSdkSession implements CopilotSdkSession {
  aborted = 0;
  disconnected = 0;
  readonly prompts: string[] = [];
  readonly modelChanges: Array<{ model: string; reasoningEffort?: string }> = [];
  sendBehavior: (prompt: string) => Promise<void> = async () => {};
  abortBehavior: () => Promise<void> = async () => {};
  disconnectBehavior: () => Promise<void> = async () => {};
  setModelBehavior: () => Promise<void> = async () => {};

  constructor(
    readonly sessionId: string,
    readonly config: CopilotSdkSessionConfig,
  ) {}

  emit(event: CopilotSdkEvent): void {
    this.config.onEvent(event);
  }

  requestPermission(
    request: CopilotSdkPermissionRequest,
  ): Promise<CopilotSdkPermissionResult> {
    return this.config.onPermissionRequest(request);
  }

  requestUserInput(
    request: CopilotSdkUserInputRequest,
  ): Promise<CopilotSdkUserInputResponse> {
    return this.config.onUserInputRequest(request);
  }

  async send(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    await this.sendBehavior(prompt);
  }

  async abort(): Promise<void> {
    this.aborted += 1;
    await this.abortBehavior();
  }

  async setModel(model: string, reasoningEffort?: string): Promise<void> {
    this.modelChanges.push({
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    await this.setModelBehavior();
  }

  async disconnect(): Promise<void> {
    this.disconnected += 1;
    await this.disconnectBehavior();
  }
}

export interface FakeCopilotSdkClientOptions {
  readonly authStatus?: { isAuthenticated: boolean; statusMessage?: string };
  /** Held before the authentication status is answered, to wedge the auth gate. */
  readonly authStatusBehavior?: () => Promise<void>;
  readonly models?: readonly CopilotSdkModel[];
  /** Wires each session as it is created, before the first prompt is sent. */
  readonly onSessionCreated?: (session: FakeCopilotSdkSession) => void;
  /** Held before a created or resumed session is handed back, to order lifecycle races. */
  readonly sessionGate?: () => Promise<void>;
  readonly deleteSessionBehavior?: (
    providerSessionId: string,
  ) => Promise<CopilotSdkSessionDeletion | void>;
  readonly stopBehavior?: (attempt: number) => Promise<void>;
  readonly forceStopBehavior?: (attempt: number) => Promise<void>;
}

export class FakeCopilotSdkClient implements CopilotSdkClient {
  readonly createdSessions: FakeCopilotSdkSession[] = [];
  readonly deletedSessions: string[] = [];
  readonly resumedSessionIds: string[] = [];
  forceStopped = 0;
  stopped = 0;
  private sessionCounter = 0;
  /** Settles every request still waiting when the CLI's connection goes down. */
  private readonly disconnection = createDeferred<never>();

  constructor(private readonly options: FakeCopilotSdkClientOptions = {}) {
    void this.disconnection.promise.catch(() => undefined);
  }

  get lastSession(): FakeCopilotSdkSession | undefined {
    return this.createdSessions.at(-1);
  }

  async getAuthStatus(): Promise<{ isAuthenticated: boolean; statusMessage?: string }> {
    await this.options.authStatusBehavior?.();
    return this.options.authStatus ?? { isAuthenticated: true };
  }

  async listModels(): Promise<readonly CopilotSdkModel[]> {
    return this.options.models ?? [];
  }

  async createSession(config: CopilotSdkSessionConfig): Promise<CopilotSdkSession> {
    this.sessionCounter += 1;
    const session = new FakeCopilotSdkSession(
      `copilot-session-${this.sessionCounter}`,
      config,
    );
    await this.awaitSessionGate();
    return this.register(session);
  }

  async resumeSession(
    providerSessionId: string,
    config: CopilotSdkSessionConfig,
  ): Promise<CopilotSdkSession> {
    this.resumedSessionIds.push(providerSessionId);
    const session = new FakeCopilotSdkSession(providerSessionId, config);
    await this.awaitSessionGate();
    return this.register(session);
  }

  /**
   * Holds a create or resume behind the gate the test controls, and refuses it when the
   * client is stopped while it is still waiting.
   *
   * The SDK rejects every request still outstanding when the JSON-RPC connection closes,
   * so a session is handed back only while the CLI is still up. A fake that produced one
   * anyway would let a test assert cleanup production can never be asked to perform.
   */
  private async awaitSessionGate(): Promise<void> {
    const gate = this.options.sessionGate?.();
    if (gate) await Promise.race([gate, this.disconnection.promise]);
  }

  private register(session: FakeCopilotSdkSession): FakeCopilotSdkSession {
    this.createdSessions.push(session);
    this.options.onSessionCreated?.(session);
    return session;
  }

  async deleteSession(providerSessionId: string): Promise<CopilotSdkSessionDeletion> {
    const outcome = await this.options.deleteSessionBehavior?.(providerSessionId);
    this.deletedSessions.push(providerSessionId);
    return outcome ?? 'deleted';
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    try {
      await this.options.stopBehavior?.(this.stopped);
    } finally {
      this.closeConnection();
    }
  }

  async forceStop(): Promise<void> {
    this.forceStopped += 1;
    try {
      await this.options.forceStopBehavior?.(this.forceStopped);
    } finally {
      this.closeConnection();
    }
  }

  private closeConnection(): void {
    this.disconnection.reject(new Error('the Copilot CLI connection was closed'));
  }
}

export class FakeCopilotSdkRuntime implements CopilotSdkRuntime {
  readonly clients: FakeCopilotSdkClient[] = [];
  readonly clientOptions: CopilotSdkClientOptions[] = [];

  constructor(
    private readonly createClientImpl: (
      options: CopilotSdkClientOptions,
    ) => FakeCopilotSdkClient | Promise<FakeCopilotSdkClient> = () => (
      new FakeCopilotSdkClient()
    ),
  ) {}

  get lastClient(): FakeCopilotSdkClient | undefined {
    return this.clients.at(-1);
  }

  async createClient(options: CopilotSdkClientOptions): Promise<CopilotSdkClient> {
    this.clientOptions.push(options);
    const client = await this.createClientImpl(options);
    this.clients.push(client);
    return client;
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** Externally settled promise, used to order lifecycle races deterministically. */
export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, reject, resolve };
}
