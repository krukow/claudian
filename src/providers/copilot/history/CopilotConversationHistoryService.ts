import type {
  ProviderConversationHistoryService,
  ProviderConversationSessionAvailability,
} from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { CopilotHistoryError, CopilotHistoryStore } from './CopilotHistoryStore';

export class CopilotConversationHistoryService implements ProviderConversationHistoryService {
  private readonly history = new CopilotHistoryStore();

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return conversation?.providerId === 'copilot' ? conversation.sessionId ?? null : null;
  }

  /**
   * A readable transcript does not prove that the CLI can resume the session.
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

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<void> {
    const sessionId = this.resolveSessionIdForConversation(conversation);
    if (!sessionId || conversation.messages.length > 0) return;
    if (!vaultPath) {
      throw new CopilotHistoryError('A vault path is required to restore Copilot history.');
    }
    const messages = await this.history.load(sessionId, vaultPath);
    if (
      this.resolveSessionIdForConversation(conversation) === sessionId
      && conversation.messages.length === 0
    ) {
      conversation.messages = messages;
    }
  }

  isPendingForkConversation(): boolean {
    return false;
  }

  buildForkProviderState(): Record<string, unknown> {
    throw new Error('Copilot does not support forking a conversation.');
  }
}
