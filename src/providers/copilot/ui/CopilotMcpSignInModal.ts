import { type App, Modal } from 'obsidian';

import type {
  CopilotMcpSignInCoordinator,
  CopilotMcpSignInState,
} from '../app/CopilotMcpSignInCoordinator';
import type { CopilotMcpServerReference } from '../resources/CopilotResourceSettings';

export class CopilotMcpSignInModal extends Modal {
  private unsubscribe: (() => void) | null = null;

  constructor(
    app: App,
    private readonly service: CopilotMcpSignInCoordinator,
    private readonly reference: CopilotMcpServerReference,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(`Sign in to ${this.reference.name}`);
    this.modalEl.setAttribute('role', 'dialog');
    this.modalEl.setAttribute('aria-modal', 'true');
    this.unsubscribe = this.service.subscribe(() => this.render(this.service.getState(this.reference)));
    this.render({ phase: 'starting' });
    void this.service.signIn(this.reference);
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    void this.service.cancel(this.reference);
    this.contentEl.empty();
  }

  private render(state: CopilotMcpSignInState): void {
    this.contentEl.empty();
    const message = state.phase === 'connected'
      ? 'Signed in. Resources will check the connection and tool list. Retry your chat message to use this server.'
      : state.phase === 'waiting'
      ? 'Complete sign-in in your browser. This window will update when the server connects.'
      : state.phase === 'error'
      ? state.message
      : 'Preparing sign-in for this MCP server...';
    const status = this.contentEl.createEl('p', { text: message });
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    if (state.phase === 'waiting') {
      this.contentEl.createEl('a', {
        text: `Continue on ${new URL(state.authorizationUrl).hostname}`,
        attr: { href: state.authorizationUrl, target: '_blank', rel: 'noopener noreferrer' },
      });
    }
    const actions = this.contentEl.createDiv({ cls: 'claudian-copilot-connect-actions' });
    if (state.phase === 'error') {
      const retry = actions.createEl('button', {
        cls: 'claudian-copilot-connect-button', text: 'Try again', attr: { type: 'button' },
      });
      retry.addEventListener('click', () => { void this.service.signIn(this.reference); });
    }
    const close = actions.createEl('button', {
      cls: 'claudian-copilot-connect-button',
      text: state.phase === 'connected' ? 'Done' : 'Cancel',
      attr: { type: 'button' },
    });
    close.addEventListener('click', () => this.close());
  }
}
