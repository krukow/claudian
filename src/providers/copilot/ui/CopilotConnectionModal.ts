import { type App, Modal } from 'obsidian';

import type {
  CopilotConnectionCoordinator,
  CopilotConnectionState,
} from '../app/CopilotConnectionCoordinator';

export class CopilotConnectionModal extends Modal {
  private unsubscribe: (() => void) | null = null;

  constructor(
    app: App,
    private readonly connection: CopilotConnectionCoordinator,
    private readonly onSettingsCommitted: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle('Connect Copilot');
    this.modalEl.setAttribute('role', 'dialog');
    this.modalEl.setAttribute('aria-modal', 'true');
    this.unsubscribe = this.connection.subscribe(state => this.render(state));
    void this.connection.connect();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    void this.connection.cancel();
    this.contentEl.empty();
  }

  private render(state: CopilotConnectionState): void {
    this.contentEl.empty();
    const status = this.contentEl.createEl('p', { text: describeState(state) });
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const actions = this.contentEl.createDiv({ cls: 'claudian-copilot-connect-actions' });

    if (state.phase === 'choose-model') {
      const select = this.contentEl.createEl('select', { cls: 'claudian-copilot-connect-model' });
      select.setAttribute('aria-label', 'Copilot model');
      for (const model of state.models) {
        select.createEl('option', { text: model.displayName }).value = model.rawId;
      }
      select.value = state.recommendedModel;
      this.contentEl.createEl('p', {
        text: 'This enables Copilot and uses the chosen model for new chats. '
          + 'Existing chats are unchanged. You can add more models later in settings.',
      });
      const confirm = this.button(actions, 'Use this model');
      confirm.classList.add('claudian-copilot-connect-button--primary');
      confirm.addEventListener('click', () => {
        void this.connection.confirmModel(select.value).then(committed => {
          if (committed) {
            this.onSettingsCommitted();
          }
        });
      });
    }
    if (state.phase === 'signing-in' && state.authorizationUrl) {
      this.contentEl.createEl('a', {
        text: 'Open GitHub sign-in',
        attr: { href: state.authorizationUrl, rel: 'noopener noreferrer', target: '_blank' },
      });
    }
    if (state.phase === 'error') {
      this.button(actions, 'Try again').addEventListener('click', () => { void this.connection.connect(); });
      this.contentEl.createEl('p').createEl('a', {
        text: 'Copilot CLI installation help',
        attr: {
          href: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started',
          rel: 'noopener noreferrer',
          target: '_blank',
        },
      });
    }
    const closing = state.phase === 'connected' ? 'Done' : state.phase === 'saving' ? 'Close' : 'Cancel';
    this.button(actions, closing).addEventListener('click', () => this.close());
    this.contentEl.appendChild(actions);
  }

  private button(container: HTMLElement, text: string): HTMLButtonElement {
    return container.createEl('button', {
      cls: 'claudian-copilot-connect-button', text, attr: { type: 'button' },
    });
  }
}

function describeState(state: CopilotConnectionState): string {
  switch (state.phase) {
    case 'idle': return 'Connect your GitHub account to use Copilot in this vault.';
    case 'checking': return 'Checking the installed Copilot CLI and your sign-in...';
    case 'signing-in': return 'Complete GitHub sign-in in your browser. This window will continue automatically.';
    case 'discovering': return 'Checking your Copilot subscription and loading available models...';
    case 'choose-model': return 'Your account is connected. Choose a model to finish setup.';
    case 'saving': return 'Saving your Copilot model selection...';
    case 'connected': return 'Connected. Open Claudian and start a new chat to use Copilot.';
    case 'error': return state.message;
  }
}
