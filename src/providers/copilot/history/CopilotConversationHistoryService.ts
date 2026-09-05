import type {
  ProviderConversationHistoryService,
  ProviderConversationSessionAvailability,
} from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';

/**
 * The minimum history contract this layer can honor.
 *
 * Copilot session data lives in the CLI's own store, which Claudian treats as read-only
 * and does not read. The service therefore answers only what it can answer truthfully:
 * which native session a conversation refers to, and what to do when the runtime reports
 * that session is gone. It never hydrates a transcript, forks, or recovers a historical
 * model, and `COPILOT_PROVIDER_CAPABILITIES` advertises none of those.
 */
export class CopilotConversationHistoryService implements ProviderConversationHistoryService {
  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return conversation?.providerId === 'copilot' ? conversation.sessionId ?? null : null;
  }

  /**
   * Availability cannot be proven without reading the CLI's private store, so a
   * conversation that names a session is reported as unknown rather than guessed at.
   */
  async getConversationSessionAvailability(
    conversation: Conversation,
  ): Promise<ProviderConversationSessionAvailability> {
    return this.resolveSessionIdForConversation(conversation) ? 'unknown' : 'missing';
  }

  /**
   * The runtime has told us which native session is gone. Dropping that reference lets the
   * next turn start a fresh session while the Claudian conversation and its messages
   * survive; deleting the conversation would discard user content over a runtime state
   * change.
   *
   * The report is only acted on when it names the session this conversation still refers
   * to. A report that names another one arrived after the conversation moved on, so acting
   * on it would drop a reference the runtime never said anything about.
   */
  async resolveMissingConversationSession(
    conversation: Conversation,
    _vaultPath: string | null,
    missingProviderSessionId?: string,
  ): Promise<'delete' | 'reset' | 'preserve'> {
    const sessionId = this.resolveSessionIdForConversation(conversation);
    if (!sessionId || !missingProviderSessionId || sessionId !== missingProviderSessionId) {
      return 'preserve';
    }

    conversation.sessionId = null;
    return 'reset';
  }

  /**
   * Replay is a Claudian-side concern in this layer. A resumed native session already
   * carries its own context, so re-sending conversation history would duplicate it.
   */
  async hydrateConversationHistory(): Promise<void> {
    // Intentionally empty: Copilot transcripts are provider-owned and read-only.
  }

  isPendingForkConversation(): boolean {
    return false;
  }

  buildForkProviderState(): Record<string, unknown> {
    throw new Error('Copilot does not support forking a conversation.');
  }
}
