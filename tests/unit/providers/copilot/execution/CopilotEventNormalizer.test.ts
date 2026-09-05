import type { ProviderRequestedEventScope } from '@/core/execution';
import { CopilotEventNormalizer } from '@/providers/copilot/execution/CopilotEventNormalizer';
import type { CopilotSdkEvent } from '@/providers/copilot/sdk/CopilotSdkPort';

function createNormalizer(
  buildUsage: CopilotEventNormalizerOptionsUsage = () => null,
): CopilotEventNormalizer {
  let sequence = 0;
  return new CopilotEventNormalizer({
    buildUsage,
    nextScope: (): ProviderRequestedEventScope => ({
      executionId: 'execution-1',
      kind: 'requested',
      sequence: ++sequence,
      sessionInstanceId: 'session-instance-1',
      turnId: 'turn-1',
    }),
  });
}

type CopilotEventNormalizerOptionsUsage = ConstructorParameters<
  typeof CopilotEventNormalizer
>[0]['buildUsage'];

function sdkEvent(type: string, data: unknown, agentId?: string): CopilotSdkEvent {
  return {
    data,
    id: 'event-1',
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    type,
    ...(agentId ? { agentId } : {}),
  } as unknown as CopilotSdkEvent;
}

describe('CopilotEventNormalizer assistant text', () => {
  it('opens the assistant message once and streams deltas', () => {
    const normalizer = createNormalizer();

    const first = normalizer.normalize(sdkEvent('assistant.message_delta', {
      deltaContent: 'Hello',
      messageId: 'message-1',
    }));
    const second = normalizer.normalize(sdkEvent('assistant.message_delta', {
      deltaContent: ' world',
      messageId: 'message-1',
    }));

    expect(first.map(event => event.type))
      .toEqual(['assistant_message_started', 'text_delta']);
    expect(first[0]).toMatchObject({ nativeAssistantId: 'message-1' });
    expect(first[1]).toMatchObject({ text: 'Hello' });
    expect(second.map(event => event.type)).toEqual(['text_delta']);
    expect(second[0]).toMatchObject({ text: ' world' });
  });

  it('does not repeat text the stream already delivered', () => {
    const normalizer = createNormalizer();
    normalizer.normalize(sdkEvent('assistant.message_delta', {
      deltaContent: 'Hello',
      messageId: 'message-1',
    }));

    expect(normalizer.normalize(sdkEvent('assistant.message', {
      content: 'Hello',
      messageId: 'message-1',
    }))).toEqual([]);
  });

  it('emits a final message that never streamed', () => {
    const normalizer = createNormalizer();

    const events = normalizer.normalize(sdkEvent('assistant.message', {
      content: 'Complete answer',
      messageId: 'message-2',
    }));

    expect(events.map(event => event.type))
      .toEqual(['assistant_message_started', 'text_delta']);
    expect(events[1]).toMatchObject({ text: 'Complete answer' });
  });

  it('stamps an increasing sequence on every event', () => {
    const normalizer = createNormalizer();

    const events = normalizer.normalize(sdkEvent('assistant.message_delta', {
      deltaContent: 'Hi',
      messageId: 'message-1',
    }));

    expect(events.map(event => event.scope.sequence)).toEqual([1, 2]);
    expect(events[0].scope).toMatchObject({ kind: 'requested', turnId: 'turn-1' });
  });
});

describe('CopilotEventNormalizer reasoning', () => {
  it('streams reasoning deltas without opening an assistant message', () => {
    const normalizer = createNormalizer();

    const events = normalizer.normalize(sdkEvent('assistant.reasoning_delta', {
      deltaContent: 'Considering options',
      reasoningId: 'reasoning-1',
    }));

    expect(events.map(event => event.type)).toEqual(['thinking_delta']);
    expect(events[0]).toMatchObject({ text: 'Considering options' });
  });

  it('does not repeat reasoning the stream already delivered', () => {
    const normalizer = createNormalizer();
    normalizer.normalize(sdkEvent('assistant.reasoning_delta', {
      deltaContent: 'Thought',
      reasoningId: 'reasoning-1',
    }));

    expect(normalizer.normalize(sdkEvent('assistant.reasoning', {
      content: 'Thought',
      reasoningId: 'reasoning-1',
    }))).toEqual([]);
  });
});

describe('CopilotEventNormalizer tool lifecycle', () => {
  it('maps the full start, partial output, and completion sequence', () => {
    const normalizer = createNormalizer();

    const started = normalizer.normalize(sdkEvent('tool.execution_start', {
      arguments: { path: 'note.md' },
      toolCallId: 'tool-1',
      toolName: 'read',
    }));
    const partial = normalizer.normalize(sdkEvent('tool.execution_partial_result', {
      partialOutput: 'first chunk',
      toolCallId: 'tool-1',
    }));
    const completed = normalizer.normalize(sdkEvent('tool.execution_complete', {
      result: { content: 'file contents' },
      success: true,
      toolCallId: 'tool-1',
    }));

    expect(started[0]).toMatchObject({
      input: { path: 'note.md' },
      name: 'read',
      toolCallId: 'tool-1',
      toolScope: { kind: 'main' },
      type: 'tool_started',
    });
    expect(partial[0]).toMatchObject({ content: 'first chunk', type: 'tool_output' });
    expect(completed[0]).toMatchObject({
      content: 'file contents',
      isError: false,
      type: 'tool_completed',
    });
  });

  it('prefers detailed content and reports failure', () => {
    const normalizer = createNormalizer();

    expect(normalizer.normalize(sdkEvent('tool.execution_complete', {
      result: { content: 'short', detailedContent: 'long' },
      success: true,
      toolCallId: 'tool-1',
    }))[0]).toMatchObject({ content: 'long' });

    expect(normalizer.normalize(sdkEvent('tool.execution_complete', {
      error: { message: 'Permission denied' },
      success: false,
      toolCallId: 'tool-2',
    }))[0]).toMatchObject({ content: 'Permission denied', isError: true });
  });

  it('normalizes missing arguments to an empty input record', () => {
    const normalizer = createNormalizer();

    expect(normalizer.normalize(sdkEvent('tool.execution_start', {
      arguments: 'not-a-record',
      toolCallId: 'tool-1',
      toolName: 'read',
    }))[0]).toMatchObject({ input: {} });
  });
});

describe('CopilotEventNormalizer other events', () => {
  it('emits usage only when the builder produces one', () => {
    const usage = {
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextTokens: 10,
      contextWindow: 100,
      inputTokens: 10,
      percentage: 10,
    };

    expect(createNormalizer(() => usage).normalize(sdkEvent('assistant.usage', {
      inputTokens: 10,
      model: 'gpt-5',
    }))[0]).toMatchObject({ type: 'usage_updated', usage });

    expect(createNormalizer().normalize(sdkEvent('assistant.usage', { model: 'gpt-5' })))
      .toEqual([]);
  });

  it('surfaces a session error as a warning notice', () => {
    expect(createNormalizer().normalize(sdkEvent('session.error', {
      errorType: 'model',
      message: 'Model temporarily unavailable',
    }))[0]).toMatchObject({
      level: 'warning',
      message: 'Model temporarily unavailable',
      type: 'notice',
    });
  });

  it('ignores sub-agent events and unmapped event types', () => {
    const normalizer = createNormalizer();

    expect(normalizer.normalize(sdkEvent('assistant.message_delta', {
      deltaContent: 'Hidden',
      messageId: 'message-1',
    }, 'subagent-1'))).toEqual([]);
    expect(normalizer.normalize(sdkEvent('session.title_changed', { title: 'New' })))
      .toEqual([]);
  });

  it('ignores empty delta and partial payloads', () => {
    const normalizer = createNormalizer();

    expect(normalizer.normalize(sdkEvent('assistant.message_delta', {
      deltaContent: '',
      messageId: 'message-1',
    })).map(event => event.type)).toEqual(['assistant_message_started']);
    expect(normalizer.normalize(sdkEvent('tool.execution_partial_result', {
      partialOutput: '',
      toolCallId: 'tool-1',
    }))).toEqual([]);
  });

  /**
   * A delta that carried nothing delivered nothing, so the aggregate that follows it is
   * the only copy of the text. Suppressing it because an id was seen would drop the whole
   * message.
   */
  it('emits the final message after a delta that carried no text', () => {
    const normalizer = createNormalizer();
    normalizer.normalize(sdkEvent('assistant.message_delta', {
      deltaContent: '',
      messageId: 'message-1',
    }));

    const events = normalizer.normalize(sdkEvent('assistant.message', {
      content: 'Complete answer',
      messageId: 'message-1',
    }));

    expect(events.map(event => event.type)).toEqual(['text_delta']);
    expect(events[0]).toMatchObject({ text: 'Complete answer' });
  });

  it('emits the final reasoning after a delta that carried no text', () => {
    const normalizer = createNormalizer();
    normalizer.normalize(sdkEvent('assistant.reasoning_delta', {
      deltaContent: '',
      reasoningId: 'reasoning-1',
    }));

    const events = normalizer.normalize(sdkEvent('assistant.reasoning', {
      content: 'Complete thought',
      reasoningId: 'reasoning-1',
    }));

    expect(events.map(event => event.type)).toEqual(['thinking_delta']);
    expect(events[0]).toMatchObject({ text: 'Complete thought' });
  });
});
