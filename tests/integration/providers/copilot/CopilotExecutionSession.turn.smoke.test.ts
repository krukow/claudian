import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type {
  ProviderExecutionEvent,
  ProviderInteractionPort,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { CopilotExecutionBackend } from '@/providers/copilot/execution/CopilotExecutionBackend';
import { CopilotCliResolver } from '@/providers/copilot/runtime/CopilotCliResolver';
import type {
  CopilotSdkClient,
  CopilotSdkClientOptions,
  CopilotSdkRuntime,
} from '@/providers/copilot/sdk/CopilotSdkPort';
import { copilotSdkRuntime } from '@/providers/copilot/sdk/CopilotSdkRuntime';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';

/**
 * A `COPILOT_HOME` the Copilot CLI has already been signed in to, which opts this in.
 *
 * The same home the keychain smoke uses: the CLI records which account a home belongs to
 * inside that home, so only the operator knows which one is signed in. Without it there
 * is nothing to run a turn as, and the suite is skipped rather than failing a machine
 * that was never signed in.
 */
const signedInHome = process.env.CLAUDIAN_COPILOT_KEYCHAIN_SMOKE_HOME?.trim();

/**
 * Runs one real turn end to end: the production execution session, the real
 * `@github/copilot-sdk`, and the user-installed `copilot` CLI.
 *
 * Nothing here is faked except where the CLI keeps its state. `CopilotClientFactory`
 * derives `COPILOT_HOME` from the vault, and a synthetic vault has never been signed in
 * to, so the runtime is wrapped to point the CLI at the home the operator opted in with.
 * Everything the turn then exercises — the client, the auth gate, session creation, the
 * event stream, and disposal — is the shipped path.
 *
 * The vault is a temporary directory holding one synthetic note, so no real note reaches
 * the CLI, and no token is read from the environment: sign-in comes from the CLI's own
 * credential store.
 */
const describeWhenSignedIn = signedInHome ? describe : describe.skip;

describeWhenSignedIn('Copilot turn against the installed CLI', () => {
  jest.setTimeout(300_000);

  let vaultPath = '';

  beforeAll(() => {
    vaultPath = mkdtempSync(path.join(__dirname, 'copilot-smoke-vault-'));
    writeFileSync(
      path.join(vaultPath, 'note.md'),
      '# Synthetic note\n\nThe passphrase is ARTICHOKE.\n',
      'utf8',
    );
  });

  afterAll(() => {
    if (vaultPath) {
      rmSync(vaultPath, { force: true, recursive: true });
    }
  });

  it('streams an answer and releases the runtime', async () => {
    const cliPath = new CopilotCliResolver().resolve(undefined, '', '');
    if (!cliPath) {
      throw new Error(
        'No `copilot` CLI was found on this host, so there is no runtime to send a turn to.',
      );
    }

    const model = await discoverFirstModel(cliPath);
    const backend = new CopilotExecutionBackend(
      createHost(vaultPath, model),
      { runtime: runtimeWithSignedInHome() },
    );
    const session = backend.createSession({
      interactionPort: refusingInteractionPort(),
      lifecycle: 'ephemeral',
      nativePersistence: 'disabled-if-supported',
      vaultWorkingDirectory: vaultPath,
    });

    const events: ProviderExecutionEvent[] = [];
    for await (const event of session.execute({
      configuration: {
        model: `copilot/${model}`,
        systemInstructions: {
          instructions: 'Answer with one word and call no tools.',
          kind: 'explicit',
        },
      },
      input: [{ text: 'Reply with the single word READY.', type: 'text' }],
      signal: new AbortController().signal,
      toolPolicy: { kind: 'passive' },
    }).events) {
      events.push(event);
    }

    const text = events
      .filter((event): event is Extract<typeof event, { type: 'text_delta' }> => (
        event.type === 'text_delta'
      ))
      .map(event => event.text)
      .join('');

    expect(events.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
    expect(text.trim()).not.toBe('');

    await expect(session.dispose()).resolves.toBeUndefined();
  });
});

/** The first model the account may use, so the turn never names one it cannot run. */
async function discoverFirstModel(cliPath: string): Promise<string> {
  const client = await copilotSdkRuntime.createClient({
    baseDirectory: signedInHome as string,
    cliPath,
    environment: { COPILOT_HOME: signedInHome as string, PATH: process.env.PATH ?? '' },
    workingDirectory: process.cwd(),
  });
  try {
    const [first] = await client.listModels();
    if (!first) {
      throw new Error('The signed-in Copilot account offers no models.');
    }
    return first.id;
  } finally {
    await client.stop().catch(() => undefined);
    await client.forceStop().catch(() => undefined);
  }
}

/** The shipped runtime, with the CLI pointed at the home the operator signed in to. */
function runtimeWithSignedInHome(): CopilotSdkRuntime {
  return {
    createClient: (options: CopilotSdkClientOptions): Promise<CopilotSdkClient> => (
      copilotSdkRuntime.createClient({
        ...options,
        baseDirectory: signedInHome as string,
        environment: { ...options.environment, COPILOT_HOME: signedInHome as string },
      })
    ),
  };
}

function createHost(vaultWorkingDirectory: string, model: string): ProviderHost {
  const settings: Record<string, unknown> = {};
  updateCopilotProviderSettings(settings, {
    discoveredModels: [{
      displayName: model,
      rawId: model,
      reasoningEfforts: [],
      supportsReasoning: false,
      supportsVision: false,
    }],
    enabled: true,
    visibleModels: [model],
  });

  return {
    app: { vault: { adapter: { basePath: vaultWorkingDirectory } } },
    getResolvedProviderCliPath: async () => (
      new CopilotCliResolver().resolve(undefined, '', '')
    ),
    settings,
  } as unknown as ProviderHost;
}

/** A passive turn asks for nothing, so every interaction that arrives is refused. */
function refusingInteractionPort(): ProviderInteractionPort {
  return {
    askUserQuestion: async request => ({ answers: {}, interactionId: request.interactionId }),
    dismissInteraction: () => {},
    requestApproval: async request => ({
      decision: 'deny',
      interactionId: request.interactionId,
    }),
    requestPlanDecision: async request => ({
      decision: null,
      interactionId: request.interactionId,
    }),
  };
}
