import type {
  ProviderExecutionEvent,
  ProviderRequestedEventScope,
} from '../../../core/execution';
import type { UsageInfo } from '../../../core/types';
import type { CopilotSdkEvent } from '../sdk/CopilotSdkPort';
import type { CopilotExecutionEventDraft } from './CopilotExecutionEventDraft';

export interface CopilotEventNormalizerOptions {
  /** Mints the scope for the next emitted event, including its sequence number. */
  readonly nextScope: () => ProviderRequestedEventScope;
  readonly buildUsage: (data: CopilotUsageEventData) => UsageInfo | null;
}

export type CopilotUsageEventData = Extract<
  CopilotSdkEvent,
  { type: 'assistant.usage' }
>['data'];

/**
 * Translates the Copilot SDK event stream into provider-neutral execution events.
 *
 * The SDK emits both incremental deltas and a final aggregate for assistant text and
 * reasoning. An id is recorded once a delta has actually delivered text, so the aggregate
 * is only emitted when the stream did not already carry it: replay stays free of
 * duplicated text, and a message whose deltas were all empty is still delivered by its
 * aggregate rather than being suppressed by an id that stood for nothing.
 */
export class CopilotEventNormalizer {
  private assistantStarted = false;
  private readonly streamedMessageIds = new Set<string>();
  private readonly streamedReasoningIds = new Set<string>();

  constructor(private readonly options: CopilotEventNormalizerOptions) {}

  normalize(event: CopilotSdkEvent): ProviderExecutionEvent[] {
    // Sub-agent output is not part of this layer's contract; the session also asks the
    // runtime not to stream it.
    if (event.agentId) {
      return [];
    }

    switch (event.type) {
      case 'assistant.message_delta':
        return this.normalizeMessageDelta(event.data);
      case 'assistant.message':
        return this.normalizeMessage(event.data);
      case 'assistant.reasoning_delta':
        return this.normalizeReasoningDelta(event.data);
      case 'assistant.reasoning':
        return this.normalizeReasoning(event.data);
      case 'tool.execution_start':
        return this.normalizeToolStart(event.data);
      case 'tool.execution_partial_result':
        return this.normalizeToolOutput(event.data);
      case 'tool.execution_complete':
        return this.normalizeToolComplete(event.data);
      case 'assistant.usage':
        return this.normalizeUsage(event.data);
      case 'session.error':
        return this.normalizeSessionError(event.data);
      default:
        return [];
    }
  }

  private normalizeMessageDelta(
    data: Extract<CopilotSdkEvent, { type: 'assistant.message_delta' }>['data'],
  ): ProviderExecutionEvent[] {
    const started = this.ensureAssistantStarted(data.messageId);
    if (!data.deltaContent) {
      return started;
    }
    this.streamedMessageIds.add(data.messageId);
    return [...started, this.event({ text: data.deltaContent, type: 'text_delta' })];
  }

  private normalizeMessage(
    data: Extract<CopilotSdkEvent, { type: 'assistant.message' }>['data'],
  ): ProviderExecutionEvent[] {
    const events = this.ensureAssistantStarted(data.messageId);
    if (!data.content || this.streamedMessageIds.has(data.messageId)) {
      return events;
    }
    return [...events, this.event({ text: data.content, type: 'text_delta' })];
  }

  private normalizeReasoningDelta(
    data: Extract<CopilotSdkEvent, { type: 'assistant.reasoning_delta' }>['data'],
  ): ProviderExecutionEvent[] {
    if (!data.deltaContent) {
      return [];
    }
    this.streamedReasoningIds.add(data.reasoningId);
    return [this.event({ text: data.deltaContent, type: 'thinking_delta' })];
  }

  private normalizeReasoning(
    data: Extract<CopilotSdkEvent, { type: 'assistant.reasoning' }>['data'],
  ): ProviderExecutionEvent[] {
    if (!data.content || this.streamedReasoningIds.has(data.reasoningId)) {
      return [];
    }
    return [this.event({ text: data.content, type: 'thinking_delta' })];
  }

  private normalizeToolStart(
    data: Extract<CopilotSdkEvent, { type: 'tool.execution_start' }>['data'],
  ): ProviderExecutionEvent[] {
    return [this.event({
      input: toRecord(data.arguments),
      name: data.toolName,
      providerPayload: { rawInput: data.arguments, rawName: data.toolName },
      toolCallId: data.toolCallId,
      toolScope: { kind: 'main' },
      type: 'tool_started',
    })];
  }

  private normalizeToolOutput(
    data: Extract<CopilotSdkEvent, { type: 'tool.execution_partial_result' }>['data'],
  ): ProviderExecutionEvent[] {
    if (!data.partialOutput) {
      return [];
    }
    return [this.event({
      content: data.partialOutput,
      toolCallId: data.toolCallId,
      toolScope: { kind: 'main' },
      type: 'tool_output',
    })];
  }

  private normalizeToolComplete(
    data: Extract<CopilotSdkEvent, { type: 'tool.execution_complete' }>['data'],
  ): ProviderExecutionEvent[] {
    return [this.event({
      content: readToolResultContent(data),
      isError: !data.success,
      providerPayload: { rawOutput: data },
      toolCallId: data.toolCallId,
      toolScope: { kind: 'main' },
      type: 'tool_completed',
    })];
  }

  private normalizeUsage(data: CopilotUsageEventData): ProviderExecutionEvent[] {
    const usage = this.options.buildUsage(data);
    return usage ? [this.event({ type: 'usage_updated', usage })] : [];
  }

  private normalizeSessionError(
    data: Extract<CopilotSdkEvent, { type: 'session.error' }>['data'],
  ): ProviderExecutionEvent[] {
    if (!data.message) {
      return [];
    }
    return [this.event({ level: 'warning', message: data.message, type: 'notice' })];
  }

  private ensureAssistantStarted(messageId?: string): ProviderExecutionEvent[] {
    if (this.assistantStarted) {
      return [];
    }
    this.assistantStarted = true;
    return [this.event({
      ...(messageId ? { nativeAssistantId: messageId } : {}),
      type: 'assistant_message_started',
    })];
  }

  private event(event: CopilotExecutionEventDraft): ProviderExecutionEvent {
    return { ...event, scope: this.options.nextScope() };
  }
}

function readToolResultContent(
  data: Extract<CopilotSdkEvent, { type: 'tool.execution_complete' }>['data'],
): string {
  const result = data.result as { content?: unknown; detailedContent?: unknown } | undefined;
  return readString(result?.detailedContent)
    ?? readString(result?.content)
    ?? readString(data.error?.message)
    ?? '';
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
