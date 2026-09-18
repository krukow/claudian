/**
 * @jest-environment jsdom
 */

jest.mock('obsidian', () => {
  class Modal {
    modalEl = document.createElement('section');
    contentEl = document.createElement('div');

    constructor() {
      this.modalEl.setAttribute('role', 'dialog');
      this.modalEl.setAttribute('aria-modal', 'true');
      this.modalEl.appendChild(this.contentEl);
    }

    setTitle(title: string): void { this.modalEl.setAttribute('aria-label', title); }
    open(): void { document.body.appendChild(this.modalEl); this.onOpen(); }
    close(): void { this.onClose(); this.modalEl.remove(); }
    onOpen(): void {}
    onClose(): void {}
  }

  class Button {
    readonly buttonEl: HTMLButtonElement;
    constructor(container: HTMLElement) {
      this.buttonEl = container.appendChild(document.createElement('button'));
    }
    setButtonText(text: string): this { this.buttonEl.textContent = text; return this; }
    setDestructive(): this { return this; }
    onClick(callback: () => void): this {
      this.buttonEl.addEventListener('click', callback);
      return this;
    }
  }

  class Setting {
    constructor(private readonly container: HTMLElement) {}
    addButton(callback: (button: Button) => void): this {
      callback(new Button(this.container));
      return this;
    }
  }
  class Component {
    unload(): void {}
  }
  return { ...jest.requireActual('obsidian'), Component, Modal, Setting };
});

import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { configureAxe } from 'jest-axe';
import { type App, Component, Notice } from 'obsidian';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ConversationPersistenceStore } from '@/core/bootstrap/ConversationPersistenceStore';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { Conversation } from '@/core/types';
import { ConversationController } from '@/features/chat/controllers/ConversationController';
import { LinkedContentController } from '@/features/chat/linked-content/LinkedContentController';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { SubagentManager } from '@/features/chat/services/SubagentManager';
import { ChatState } from '@/features/chat/state/ChatState';
import type { FeatureHost } from '@/features/FeatureHost';
import { registerBuiltInProviders } from '@/providers';

const checkAccessibility = configureAxe({ rules: { region: { enabled: false } } });

beforeAll(() => {
  registerBuiltInProviders();
  HTMLElement.prototype.empty = function empty() { this.replaceChildren(); };
  HTMLElement.prototype.addClass = function addClass(...classes: string[]) { this.classList.add(...classes); };
});
afterEach(() => { document.body.replaceChildren(); jest.clearAllMocks(); });

async function createHarness(archived = false) {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  let failWrites = false;
  let disposed = false;
  let deletion: Promise<void> | null = null;
  let writeBarrier: { started: () => void; wait: Promise<void> } | null = null;
  const app = {
    vault: {
      adapter: {
        exists: async (path: string) => files.has(path) || folders.has(path),
        read: async (path: string) => {
          const content = files.get(path);
          if (content === undefined) throw new Error(`Missing fixture file: ${path}`);
          return content;
        },
        write: async (path: string, content: string) => {
          if (failWrites) throw new Error('Storage unavailable.');
          if (writeBarrier) {
            writeBarrier.started();
            await writeBarrier.wait;
          }
          files.set(path, content);
        },
        mkdir: async (path: string) => { folders.add(path); },
        remove: async (path: string) => { files.delete(path); },
      },
    },
  } as unknown as App;
  const persistence = new ConversationPersistenceStore(new VaultFileAdapter(app), `device-${'a'.repeat(64)}`);
  const repository = new ConversationRepository({
    getSettings: () => ({}),
    getVaultPath: () => null,
    onConversationDeleted: async () => {},
    persistence,
  });
  const conversation: Conversation = {
    id: 'chat-to-delete',
    providerId: 'copilot',
    title: 'Disposable chat',
    createdAt: 1,
    lastActivityAt: 1,
    sessionId: 'native-session-kept',
    messages: [],
    ...(archived ? { isArchived: true } : {}),
    linkedContentPath: 'Notes/Keep.md',
  };
  repository.replaceAll([conversation]);
  await persistence.saveMetadata({ ...conversation });
  const state = new ChatState();
  state.currentConversationId = 'another-chat';
  const plugin = {
    app,
    settings: {},
    getConversationList: () => repository.list(),
    deleteConversation: (id: string) => {
      deletion = repository.delete(id);
      return deletion;
    },
    getConversationSync: (id: string) => repository.getSync(id),
  } as unknown as FeatureHost;
  const messagesEl = document.createElement('div');
  const inputEl = document.createElement('textarea');
  const component = new Component();
  const renderer = new MessageRenderer(plugin, component, messagesEl);
  const linkedContent = new LinkedContentController({
    app, getExcludedTags: () => [], getCachedVaultFiles: () => [], getCachedVaultFolders: () => [],
  });
  const container = document.body.appendChild(document.createElement('div'));
  const controller = new ConversationController({
    plugin, state, renderer,
    subagentManager: new SubagentManager(() => {}),
    getHistoryDropdown: () => container,
    getWelcomeEl: () => null,
    setWelcomeEl: () => {},
    getMessagesEl: () => messagesEl,
    getInputEl: () => inputEl,
    getFileContextManager: () => null,
    getLinkedContentController: () => linkedContent,
    getImageContextManager: () => null,
    getExternalContextSelector: () => null,
    clearQueuedMessage: () => {},
    getTitleGenerationService: () => null,
    getStatusPanel: () => null,
    getExecutionCoordinator: () => null,
    isDisposed: () => disposed,
  });
  let running = false;
  const render = () => controller.renderHistoryDropdown(container, {
    onSelectConversation: async () => { throw new Error('Deleting must not select a conversation.'); },
    onRerender: render,
    sessionActionMode: archived ? 'archived' : 'active',
    sessionScope: archived ? 'archived' : 'active',
    showOpenStateActions: false,
    getConversationStatus: () => ({ openState: 'closed', isRunning: running }),
  });
  render();
  return {
    container, repository, persistence, state, render,
    setRunning: (value: boolean) => { running = value; },
    failWrites: () => { failWrites = true; },
    deferDeletionWrite: () => {
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      writeBarrier = { started: markStarted, wait };
      return { started, release: () => { writeBarrier = null; release(); } };
    },
    waitForDeletion: async () => {
      if (!deletion) throw new Error('No deletion was requested.');
      await deletion;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      renderer.dispose();
      linkedContent.destroy();
      component.unload();
    },
  };
}

it.each([false, true])('confirms deletion from the %s archived list without selecting the chat', async archived => {
  const harness = await createHarness(archived);
  try {
    const remove = within(harness.container).getByRole('button', { name: 'Delete' });
    expect(remove.getAttribute('type')).toBe('button');
    remove.click();

    const dialog = await screen.findByRole('dialog', { name: 'Confirm' });
    expect(dialog.textContent).toContain('Disposable chat');
    expect(dialog.textContent).toContain('notes');
    expect(harness.repository.list().map(item => item.id)).toEqual(['chat-to-delete']);
    expect(await checkAccessibility(dialog)).toHaveNoViolations();
    within(dialog).getByRole('button', { name: 'Cancel' }).click();
    expect(harness.repository.list().map(item => item.id)).toEqual(['chat-to-delete']);

    remove.click();
    const confirmation = await screen.findByRole('dialog');
    const confirmButton = within(confirmation).getByRole('button', { name: 'Delete' });
    expect(confirmButton.getAttribute('type')).toBe('button');
    confirmButton.click();

    await waitFor(() => { expect(harness.repository.list()).toEqual([]); });
    await waitFor(() => {
      expect(within(harness.container).queryByRole('button', { name: 'Delete' })).toBeNull();
    });
    expect(await harness.persistence.isDeleted('chat-to-delete')).toBe(true);
    expect(harness.state.currentConversationId).toBe('another-chat');
  } finally {
    harness.dispose();
  }
});

it('lets an unrelated chat keep running while deleting an idle session', async () => {
  const harness = await createHarness();
  try {
    harness.state.isStreaming = true;
    within(harness.container).getByRole('button', { name: 'Delete' }).click();
    const dialog = await screen.findByRole('dialog');
    within(dialog).getByRole('button', { name: 'Delete' }).click();

    await waitFor(() => { expect(harness.repository.list()).toEqual([]); });
    expect(harness.state.isStreaming).toBe(true);
  } finally {
    harness.dispose();
  }
});

it('requires a running target to stop, including when it starts during confirmation', async () => {
  const harness = await createHarness();
  try {
    harness.setRunning(true);
    harness.render();
    expect((within(harness.container).getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
    harness.setRunning(false);
    harness.render();
    fireEvent.click(within(harness.container).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    harness.setRunning(true);
    within(dialog).getByRole('button', { name: 'Delete' }).click();

    await waitFor(() => { expect(Notice).toHaveBeenCalledWith('Stop this session before deleting it.'); });
    expect(harness.repository.list().map(item => item.id)).toEqual(['chat-to-delete']);
  } finally {
    harness.dispose();
  }
});

it('reports storage failure and leaves the conversation available', async () => {
  const harness = await createHarness();
  try {
    harness.failWrites();
    within(harness.container).getByRole('button', { name: 'Delete' }).click();
    const dialog = await screen.findByRole('dialog');
    within(dialog).getByRole('button', { name: 'Delete' }).click();

    await waitFor(() => { expect(Notice).toHaveBeenCalledWith('Failed to delete conversation'); });
    expect(harness.repository.list().map(item => item.id)).toEqual(['chat-to-delete']);
    expect(await harness.persistence.isDeleted('chat-to-delete')).toBe(false);
  } finally {
    harness.dispose();
  }
});

it('finishes durable deletion without publishing into a disposed history surface', async () => {
  const harness = await createHarness();
  const deletionWrite = harness.deferDeletionWrite();
  try {
    within(harness.container).getByRole('button', { name: 'Delete' }).click();
    const dialog = await screen.findByRole('dialog');
    within(dialog).getByRole('button', { name: 'Delete' }).click();
    await deletionWrite.started;
    harness.dispose();
    harness.container.remove();
    const disposedMarkup = harness.container.innerHTML;

    deletionWrite.release();
    await harness.waitForDeletion();

    expect(harness.repository.list()).toEqual([]);
    expect(await harness.persistence.isDeleted('chat-to-delete')).toBe(true);
    expect(harness.container.innerHTML).toBe(disposedMarkup);
  } finally {
    deletionWrite.release();
    harness.dispose();
  }
});
