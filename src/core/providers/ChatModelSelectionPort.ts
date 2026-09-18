import type { StoredChatModelSelection } from '../types';

/** Application-owned ordering and persistence of explicit future-chat model choices. */
export interface ChatModelSelectionPort {
  beginIntent(): number;
  commitIntent(
    intent: number,
    selection: StoredChatModelSelection,
    isStillValid: () => boolean,
  ): Promise<boolean>;
}
