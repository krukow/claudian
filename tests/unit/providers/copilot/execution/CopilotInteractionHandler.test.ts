import type {
  ProviderApprovalInteractionRequest,
  ProviderInteractionPort,
  ProviderQuestionInteractionRequest,
  ProviderToolPolicy,
} from '@/core/execution';
import type { ApprovalDecision } from '@/core/types/settings';
import {
  CopilotInteractionHandler,
  type CopilotSessionInteractionHandlers,
} from '@/providers/copilot/execution/CopilotInteractionHandler';
import type {
  CopilotSdkPermissionRequest,
  CopilotSdkUserInputRequest,
} from '@/providers/copilot/sdk/CopilotSdkPort';

interface HandlerHarness {
  readonly approvalRequests: ProviderApprovalInteractionRequest[];
  readonly dismissals: Array<{ interactionId: string; reason: string }>;
  readonly handler: CopilotSessionInteractionHandlers;
  readonly questionRequests: ProviderQuestionInteractionRequest[];
  /** Callbacks for a session the handler no longer recognizes. */
  readonly staleHandler: CopilotSessionInteractionHandlers;
}

/** Stands in for the acquired session the handler currently recognizes. */
const LIVE_SESSION_TOKEN = {};

function createHarness(options: {
  readonly answers?: Record<string, string | string[]> | null;
  readonly decision?: ApprovalDecision;
  readonly hasActiveTurn?: boolean;
  readonly toolPolicy?: ProviderToolPolicy;
} = {}): HandlerHarness {
  const approvalRequests: ProviderApprovalInteractionRequest[] = [];
  const questionRequests: ProviderQuestionInteractionRequest[] = [];
  const dismissals: Array<{ interactionId: string; reason: string }> = [];

  const interactionPort: ProviderInteractionPort = {
    askUserQuestion: async (request) => {
      questionRequests.push(request);
      return {
        answers: options.answers === undefined ? {} : options.answers,
        interactionId: request.interactionId,
      };
    },
    dismissInteraction: (interactionId, reason) => {
      dismissals.push({ interactionId, reason });
    },
    requestApproval: async (request) => {
      approvalRequests.push(request);
      return { decision: options.decision ?? 'allow', interactionId: request.interactionId };
    },
    requestPlanDecision: async request => ({
      decision: null,
      interactionId: request.interactionId,
    }),
  };

  const handler = new CopilotInteractionHandler({
    getActiveTurn: sessionToken => (
      options.hasActiveTurn === false || sessionToken !== LIVE_SESSION_TOKEN
        ? null
        : { signal: new AbortController().signal, turnId: 'turn-1' }
    ),
    getToolPolicy: () => options.toolPolicy ?? { kind: 'provider-default' },
    interactionPort,
    sessionInstanceId: 'session-instance-1',
  });

  return {
    approvalRequests,
    dismissals,
    handler: handler.bind(LIVE_SESSION_TOKEN),
    questionRequests,
    staleHandler: handler.bind({}),
  };
}

function permissionRequest(kind: string): CopilotSdkPermissionRequest {
  return { command: 'rm -rf /', kind } as unknown as CopilotSdkPermissionRequest;
}

describe('CopilotInteractionHandler approvals', () => {
  it('routes an approval to the user and maps allow to a single-use approval', async () => {
    const harness = createHarness({ decision: 'allow' });

    await expect(harness.handler.handlePermissionRequest(permissionRequest('shell')))
      .resolves.toEqual({ approvedInteractively: true, kind: 'approve-once' });
    expect(harness.approvalRequests[0]).toMatchObject({
      description: 'Copilot wants to run a shell command.',
      kind: 'approval',
      sessionInstanceId: 'session-instance-1',
      toolName: 'shell',
      turnId: 'turn-1',
    });
  });

  it('maps allow-always to a session approval', async () => {
    const harness = createHarness({ decision: 'allow-always' });

    await expect(harness.handler.handlePermissionRequest(permissionRequest('write')))
      .resolves.toEqual({ kind: 'approve-for-session' });
  });

  it.each<[ApprovalDecision, string]>([
    ['deny', 'Denied by the user.'],
    ['cancel', 'Cancelled by the user.'],
  ])('rejects when the user answers %s', async (decision, feedback) => {
    const harness = createHarness({ decision });

    await expect(harness.handler.handlePermissionRequest(permissionRequest('shell')))
      .resolves.toEqual({ feedback, kind: 'reject' });
  });

  it('rejects without prompting when no turn is accepting approvals', async () => {
    const harness = createHarness({ hasActiveTurn: false });

    const result = await harness.handler.handlePermissionRequest(permissionRequest('shell'));

    expect(result).toMatchObject({ kind: 'reject' });
    expect(harness.approvalRequests).toHaveLength(0);
  });

  it('rejects every request under a passive tool policy', async () => {
    const harness = createHarness({ toolPolicy: { kind: 'passive' } });

    const result = await harness.handler.handlePermissionRequest(permissionRequest('read'));

    expect(result).toMatchObject({ kind: 'reject' });
    expect(harness.approvalRequests).toHaveLength(0);
  });

  /**
   * The CLI's permission kinds, named independently of the provider constant. Only `read`
   * and `url` leave nothing changed behind them.
   */
  it('rejects every permission kind a read-only turn cannot allow', async () => {
    const harness = createHarness({ toolPolicy: { kind: 'read-only' } });

    for (const kind of [
      'custom-tool',
      'extension-management',
      'extension-permission-access',
      'factory',
      'hook',
      'mcp',
      'memory',
      'shell',
      'write',
      'a-kind-added-later',
    ]) {
      await expect(harness.handler.handlePermissionRequest(permissionRequest(kind)))
        .resolves.toMatchObject({ kind: 'reject' });
    }
    expect(harness.approvalRequests).toHaveLength(0);
  });

  it('still prompts for the read-only permission kinds', async () => {
    const harness = createHarness({ toolPolicy: { kind: 'read-only' } });

    for (const kind of ['read', 'url']) {
      await expect(harness.handler.handlePermissionRequest(permissionRequest(kind)))
        .resolves.toMatchObject({ kind: 'approve-once' });
    }
    expect(harness.approvalRequests).toHaveLength(2);
  });

  it('still asks the user under an unrestricted policy', async () => {
    const harness = createHarness({ toolPolicy: { kind: 'unrestricted' } });

    await harness.handler.handlePermissionRequest(permissionRequest('shell'));

    expect(harness.approvalRequests).toHaveLength(1);
  });

  it('describes every permission kind it forwards', async () => {
    const harness = createHarness();

    for (const kind of ['shell', 'write', 'read', 'mcp', 'url', 'memory']) {
      await harness.handler.handlePermissionRequest(permissionRequest(kind));
    }

    expect(harness.approvalRequests.map(request => request.description)).toEqual([
      'Copilot wants to run a shell command.',
      'Copilot wants to write files.',
      'Copilot wants to read files outside its current permission scope.',
      'Copilot wants to invoke an MCP tool.',
      'Copilot wants to access a URL.',
      'Copilot requests permission for memory.',
    ]);
  });
});

describe('CopilotInteractionHandler user questions', () => {
  const question: CopilotSdkUserInputRequest = {
    choices: ['Yes', 'No'],
    question: 'Continue?',
  };

  it('forwards the question with its choices and returns the selection', async () => {
    const harness = createHarness({ answers: { 'Continue?': 'Yes' } });

    await expect(harness.handler.handleUserInputRequest(question))
      .resolves.toEqual({ answer: 'Yes', wasFreeform: false });
    expect(harness.questionRequests[0].input).toEqual({
      questions: [{
        header: 'Copilot',
        isOther: true,
        multiSelect: false,
        options: [
          { description: '', label: 'Yes', value: 'Yes' },
          { description: '', label: 'No', value: 'No' },
        ],
        question: 'Continue?',
      }],
    });
  });

  it('reports a freeform answer that is not one of the choices', async () => {
    const harness = createHarness({ answers: { 'Continue?': 'Maybe later' } });

    await expect(harness.handler.handleUserInputRequest(question))
      .resolves.toEqual({ answer: 'Maybe later', wasFreeform: true });
  });

  it('takes the first value when the surface answers with a list', async () => {
    const harness = createHarness({ answers: { 'Continue?': ['No', 'Yes'] } });

    await expect(harness.handler.handleUserInputRequest(question))
      .resolves.toEqual({ answer: 'No', wasFreeform: false });
  });

  it('answers empty when the user dismisses the question', async () => {
    const harness = createHarness({ answers: null });

    await expect(harness.handler.handleUserInputRequest(question))
      .resolves.toEqual({ answer: '', wasFreeform: true });
  });

  it('answers empty without prompting when no turn is active', async () => {
    const harness = createHarness({ hasActiveTurn: false });

    await expect(harness.handler.handleUserInputRequest(question))
      .resolves.toEqual({ answer: '', wasFreeform: true });
    expect(harness.questionRequests).toHaveLength(0);
  });

  it('disables freeform input when the request opts out', async () => {
    const harness = createHarness({ answers: { 'Continue?': 'Yes' } });

    await harness.handler.handleUserInputRequest({ ...question, allowFreeform: false });

    expect(harness.questionRequests[0].input).toMatchObject({
      questions: [expect.objectContaining({ isOther: false })],
    });
  });
});

/**
 * A CLI session Claudian dropped can still be running. Its callbacks answer on their own
 * session's terms, so a late approval or question is refused instead of being handed to
 * whichever turn is live now.
 */
describe('CopilotInteractionHandler session scoping', () => {
  it('rejects an approval from a session it no longer recognizes', async () => {
    const harness = createHarness({ decision: 'allow' });

    await expect(harness.staleHandler.handlePermissionRequest(permissionRequest('shell')))
      .resolves.toMatchObject({ kind: 'reject' });
    expect(harness.approvalRequests).toHaveLength(0);
  });

  it('answers empty to a question from a session it no longer recognizes', async () => {
    const harness = createHarness({ answers: { 'Continue?': 'Yes' } });

    await expect(harness.staleHandler.handleUserInputRequest({
      allowFreeform: true,
      question: 'Continue?',
    } as unknown as CopilotSdkUserInputRequest))
      .resolves.toEqual({ answer: '', wasFreeform: true });
    expect(harness.questionRequests).toHaveLength(0);
  });
});
