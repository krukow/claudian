import type { Conversation } from '@/core/types';
import { CopilotConversationHistoryService } from '@/providers/copilot/history/CopilotConversationHistoryService';

function createConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    createdAt: 0,
    id: 'conversation-1',
    lastActivityAt: 0,
    messages: [],
    providerId: 'copilot',
    sessionId: 'copilot-session-1',
    title: 'Conversation',
    ...overrides,
  } as Conversation;
}

describe('CopilotConversationHistoryService', () => {
  const service = new CopilotConversationHistoryService();

  it('resolves the native session reference for Copilot conversations only', () => {
    expect(service.resolveSessionIdForConversation(createConversation()))
      .toBe('copilot-session-1');
    expect(service.resolveSessionIdForConversation(createConversation({ providerId: 'grok' })))
      .toBeNull();
    expect(service.resolveSessionIdForConversation(createConversation({ sessionId: null })))
      .toBeNull();
    expect(service.resolveSessionIdForConversation(null)).toBeNull();
  });

  it('does not claim to know whether a native session still exists', async () => {
    await expect(service.getConversationSessionAvailability(createConversation()))
      .resolves.toBe('unknown');
  });

  it('reports a conversation without a session reference as missing', async () => {
    await expect(service.getConversationSessionAvailability(
      createConversation({ sessionId: null }),
    )).resolves.toBe('missing');
  });

  it('resets rather than deletes when the runtime lost the session', async () => {
    const conversation = createConversation();

    await expect(service.resolveMissingConversationSession(
      conversation,
      '/vault',
      'copilot-session-1',
    )).resolves.toBe('reset');
    expect(conversation.sessionId).toBeNull();
  });

  /**
   * The runtime reports which session it lost. A report naming a session the conversation
   * no longer refers to is stale — it arrived after the conversation moved on — so the
   * reference it does hold is left alone.
   */
  it.each<[string, string | undefined, string | null]>([
    ['the report names another session', 'copilot-session-old', 'copilot-session-1'],
    ['no session was reported', undefined, 'copilot-session-1'],
  ])('preserves the reference when %s', async (_label, missingId, expected) => {
    const conversation = createConversation();

    await expect(service.resolveMissingConversationSession(
      conversation,
      '/vault',
      missingId,
    )).resolves.toBe('preserve');
    expect(conversation.sessionId).toBe(expected);
  });

  it('preserves a conversation that refers to no native session', async () => {
    const conversation = createConversation({ sessionId: null });

    await expect(service.resolveMissingConversationSession(
      conversation,
      '/vault',
      'copilot-session-1',
    )).resolves.toBe('preserve');
    expect(conversation.sessionId).toBeNull();
  });

  it('does not replay history into a resumed native session', async () => {
    const conversation = createConversation();

    await expect(service.hydrateConversationHistory()).resolves.toBeUndefined();
    expect(conversation.messages).toEqual([]);
  });

  it('advertises no fork support, matching the capability contract', () => {
    expect(service.isPendingForkConversation()).toBe(false);
    expect(() => service.buildForkProviderState()).toThrow(/does not support forking/);
  });
});
