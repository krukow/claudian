import { randomUUID } from 'node:crypto';

import type { ProviderInteractionPort } from '../../../core/execution';
import type { ProviderToolPolicy } from '../../../core/execution';
import type {
  CopilotSdkPermissionPrompt,
  CopilotSdkPermissionRequest,
  CopilotSdkPermissionResult,
  CopilotSdkUserInputRequest,
  CopilotSdkUserInputResponse,
} from '../sdk/CopilotSdkPort';
import type { CopilotPermissionMode } from '../settings';
import { COPILOT_READ_ONLY_PERMISSION_KINDS } from './CopilotBuiltinTools';

export interface CopilotInteractionHandlerOptions {
  readonly interactionPort: ProviderInteractionPort;
  readonly sessionInstanceId: string;
  /**
   * Turn context for the run the named native session is currently serving, or null when
   * that session no longer owns a run: a session Claudian dropped, or one whose run has
   * ended, has no turn to attach an approval or a question to.
   */
  readonly getActiveTurn: (
    sessionToken: object,
  ) => { readonly signal: AbortSignal; readonly turnId: string } | null;
  readonly getToolPolicy: () => ProviderToolPolicy | null;
  readonly getPermissionMode?: () => CopilotPermissionMode;
}

/** The pair of native callbacks one acquired session is wired with. */
export interface CopilotSessionInteractionHandlers {
  readonly handlePermissionRequest: (
    request: CopilotSdkPermissionRequest,
    prompt?: CopilotSdkPermissionPrompt,
  ) => Promise<CopilotSdkPermissionResult>;
  readonly handleUserInputRequest: (
    request: CopilotSdkUserInputRequest,
  ) => Promise<CopilotSdkUserInputResponse>;
}

/**
 * Routes Copilot's approval and question requests to the Claudian interaction surface.
 *
 * The policy is fail-closed at both ends: a request that arrives with no live turn, or
 * one the active tool policy forbids, is rejected without ever reaching the user, and an
 * approval is granted by a human or an explicit native judge recommendation. Native
 * Allow all handles automatic grants itself; any remaining callback still asks a human.
 *
 * Handlers are bound per acquired session rather than shared, because a CLI session
 * Claudian dropped can still be running. Its late approval must be refused on its own
 * terms instead of being answered by whichever turn happens to be live.
 */
export class CopilotInteractionHandler {
  constructor(private readonly options: CopilotInteractionHandlerOptions) {}

  /** Wires the callbacks one native session is created with to that session's identity. */
  bind(sessionToken: object): CopilotSessionInteractionHandlers {
    return {
      handlePermissionRequest: (request, prompt) => (
        this.handlePermissionRequest(sessionToken, request, prompt)
      ),
      handleUserInputRequest: request => this.handleUserInputRequest(sessionToken, request),
    };
  }

  private async handlePermissionRequest(
    sessionToken: object,
    request: CopilotSdkPermissionRequest,
    prompt?: CopilotSdkPermissionPrompt,
  ): Promise<CopilotSdkPermissionResult> {
    const active = this.options.getActiveTurn(sessionToken);
    if (!active || active.signal.aborted || prompt?.signal?.aborted) {
      return { kind: 'reject', feedback: 'No Copilot turn is accepting approvals.' };
    }

    const policy = this.options.getToolPolicy();
    if (policy && isBlockedByToolPolicy(policy, request.kind)) {
      return {
        kind: 'reject',
        feedback: `Blocked by the current Claudian tool policy (${policy.kind}).`,
      };
    }

    if (
      this.options.getPermissionMode?.() === 'judge'
      && (policy?.kind === 'provider-default' || policy?.kind === 'unrestricted')
      && request.managedApprovalRequired !== true
      && prompt?.managedApprovalRequired !== true
      && prompt?.autoApproval?.recommendation === 'approve'
    ) {
      return { kind: 'approve-once' };
    }

    const signal = prompt?.signal
      ? AbortSignal.any([active.signal, prompt.signal])
      : active.signal;
    const response = await this.options.interactionPort.requestApproval({
      description: describePermission(request),
      input: toRecord(request),
      interactionId: randomUUID(),
      kind: 'approval',
      nativeContext: request,
      sessionInstanceId: this.options.sessionInstanceId,
      toolName: request.kind,
      turnId: active.turnId,
    }, signal);

    const current = this.options.getActiveTurn(sessionToken);
    if (signal.aborted || current?.turnId !== active.turnId || current.signal !== active.signal) {
      return { kind: 'reject', feedback: 'The Copilot turn is no longer accepting approvals.' };
    }

    switch (response.decision) {
      case 'allow':
        return { kind: 'approve-once', approvedInteractively: true };
      case 'allow-always':
        return { kind: 'approve-for-session' };
      case 'cancel':
        return { kind: 'reject', feedback: 'Cancelled by the user.' };
      default:
        return { kind: 'reject', feedback: 'Denied by the user.' };
    }
  }

  private async handleUserInputRequest(
    sessionToken: object,
    request: CopilotSdkUserInputRequest,
  ): Promise<CopilotSdkUserInputResponse> {
    const active = this.options.getActiveTurn(sessionToken);
    if (!active) {
      return { answer: '', wasFreeform: true };
    }

    const choices = request.choices ?? [];
    const response = await this.options.interactionPort.askUserQuestion({
      input: {
        questions: [{
          header: 'Copilot',
          isOther: request.allowFreeform !== false,
          multiSelect: false,
          options: choices.map(choice => ({ description: '', label: choice, value: choice })),
          question: request.question,
        }],
      },
      interactionId: randomUUID(),
      kind: 'question',
      nativeContext: request,
      sessionInstanceId: this.options.sessionInstanceId,
      turnId: active.turnId,
    }, active.signal);

    const answered = response.answers?.[request.question];
    const answer = Array.isArray(answered) ? answered[0] ?? '' : answered ?? '';
    return { answer, wasFreeform: !choices.includes(answer) };
  }
}

/**
 * A read-only turn names the permission kinds it still allows. Every other kind the CLI
 * defines, and every kind a later release adds, is rejected without reaching the user.
 */
function isBlockedByToolPolicy(policy: ProviderToolPolicy, kind: string): boolean {
  if (policy.kind === 'passive') {
    return true;
  }
  return policy.kind === 'read-only' && !COPILOT_READ_ONLY_PERMISSION_KINDS.has(kind);
}

function describePermission(request: CopilotSdkPermissionRequest): string {
  switch (request.kind) {
    case 'shell':
      return 'Copilot wants to run a shell command.';
    case 'write':
      return 'Copilot wants to write files.';
    case 'read':
      return 'Copilot wants to read files outside its current permission scope.';
    case 'mcp':
      return 'Copilot wants to invoke an MCP tool.';
    case 'url':
      return 'Copilot wants to access a URL.';
    default:
      return `Copilot requests permission for ${request.kind}.`;
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
