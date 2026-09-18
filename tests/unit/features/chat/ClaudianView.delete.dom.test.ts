/**
 * @jest-environment jsdom
 */

jest.mock('obsidian', () => {
  class Component {
    private readonly cleanup: Array<() => void> = [];
    load(): void {}
    unload(): void { this.cleanup.splice(0).reverse().forEach(dispose => dispose()); }
    register(dispose: () => void): void { this.cleanup.push(dispose); }
    registerEvent(): void {}
    registerDomEvent(
      element: EventTarget,
      type: string,
      listener: EventListener,
      options?: AddEventListenerOptions,
    ): void {
      element.addEventListener(type, listener, options);
      this.register(() => element.removeEventListener(type, listener, options));
    }
    addChild<T extends Component>(child: T): T {
      this.register(() => child.unload());
      return child;
    }
    removeChild<T extends Component>(child: T): T { child.unload(); return child; }
  }

  class ItemView extends Component {
    readonly app: unknown;
    readonly containerEl = document.createElement('section');
    readonly contentEl = this.containerEl.appendChild(document.createElement('div'));
    constructor(readonly leaf: { app: unknown }) {
      super();
      this.app = leaf.app;
    }
  }

  class Modal {
    modalEl = document.createElement('section');
    contentEl = this.modalEl.appendChild(document.createElement('div'));
    constructor() {
      this.modalEl.setAttribute('role', 'dialog');
      this.modalEl.setAttribute('aria-modal', 'true');
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

  return { ...jest.requireActual('obsidian'), Component, ItemView, Modal, Setting };
});

import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { configureAxe } from 'jest-axe';
import { type App, Menu, Notice, type WorkspaceLeaf } from 'obsidian';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { ConversationPersistenceStore } from '@/core/bootstrap/ConversationPersistenceStore';
import {
  type ChatRewindResult,
  type ProviderExecutionEvent,
  ProviderExecutionLifecycleRegistry,
  type ProviderExecutionSession,
  type RewindableExecutionSession,
} from '@/core/execution';
import type { ProviderSessionConfig } from '@/core/execution/ProviderExecutionBackend';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { Conversation } from '@/core/types';
import { ClaudianView } from '@/features/chat/ClaudianView';
import { WarmExecutionPool } from '@/features/chat/execution/WarmExecutionPool';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import type { FeatureHost } from '@/features/FeatureHost';
import { registerBuiltInProviders } from '@/providers';
import { claudeProviderRegistration } from '@/providers/claude/registration';

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  Object.assign(HTMLElement.prototype, {
    empty(this: HTMLElement) { this.replaceChildren(); },
    scrollIntoView() {},
    appendText(this: HTMLElement, text: string) { this.appendChild(document.createTextNode(text)); },
    addClass(this: HTMLElement, ...classes: string[]) { this.classList.add(...classes); },
    removeClass(this: HTMLElement, ...classes: string[]) { this.classList.remove(...classes); },
    hasClass(this: HTMLElement, cls: string) { return this.classList.contains(cls); },
    toggleClass(this: HTMLElement, cls: string, enabled: boolean) { this.classList.toggle(cls, enabled); },
    setCssProps(this: HTMLElement, styles: Record<string, string>) {
      for (const [property, value] of Object.entries(styles)) this.style.setProperty(property, value);
    },
    setCssStyles(this: HTMLElement, styles: Partial<CSSStyleDeclaration>) { Object.assign(this.style, styles); },
    setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
    show(this: HTMLElement) { this.style.display = ''; },
    hide(this: HTMLElement) { this.style.display = 'none'; },
  });
});

beforeEach(() => {
  registerBuiltInProviders();
  ProviderWorkspaceRegistry.setServices('claude', {});
});

afterEach(() => {
  document.body.replaceChildren();
  ProviderWorkspaceRegistry.clear();
  jest.clearAllMocks();
});

async function createHarness(options: {
  archived?: boolean;
  createSession?: (config: ProviderSessionConfig) => ProviderExecutionSession;
  beforeWrite?: (path: string, content: string) => Promise<void>;
  messages?: Conversation['messages'];
} = {}) {
  ProviderRegistry.register('claude', {
    ...claudeProviderRegistration,
    createExecutionBackend: () => ({
      providerId: 'claude',
      createSession: options.createSession
        ?? (() => { throw new Error('Deletion must not start a provider session.'); }),
    }),
    createSubagentHistoryService: undefined,
  });
  const files = new Map<string, string>();
  const folders = new Set<string>();
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
          await options.beforeWrite?.(path, content);
          files.set(path, content);
        },
        mkdir: async (path: string) => { folders.add(path); },
        remove: async (path: string) => { files.delete(path); },
      },
      getAbstractFileByPath: () => null,
      getFiles: () => [],
      on: () => ({}),
      offref: () => {},
    },
    workspace: {
      getActiveFile: () => null,
      getActiveViewOfType: () => null,
      getLeavesOfType: () => [],
      on: () => ({}),
      offref: () => {},
      requestSaveLayout: Object.assign(() => {}, { run: async () => {} }),
    },
    metadataCache: {
      getFileCache: () => null,
      on: () => ({}),
      offref: () => {},
    },
  } as unknown as App;
  const settings = {
    ...DEFAULT_CLAUDIAN_SETTINGS,
    enableAutoTitleGeneration: false,
    enableDualPane: false,
  };
  const persistence = new ConversationPersistenceStore(new VaultFileAdapter(app), `device-${'b'.repeat(64)}`);
  const repository = new ConversationRepository({
    getSettings: () => settings,
    getVaultPath: () => null,
    onConversationDeleted: async () => {},
    persistence,
  });
  const conversation: Conversation = {
    id: 'shared-chat',
    providerId: 'claude',
    title: 'Shared chat',
    createdAt: 1,
    lastActivityAt: 1,
    sessionId: null,
    selectedModel: 'haiku',
    messages: options.messages ?? [],
    ...(options.archived ? { isArchived: true } : {}),
  };
  repository.replaceAll([conversation]);
  await persistence.saveMetadata({ ...conversation });
  const views: ClaudianView[] = [];
  const providerHost: Pick<
    FeatureHost['providerHost'],
    'app' | 'settings' | 'executionLifecycleRegistry' | 'getActiveEnvironmentVariables'
  > = {
    app,
    settings,
    executionLifecycleRegistry: new ProviderExecutionLifecycleRegistry(),
    getActiveEnvironmentVariables: () => '',
  };
  const plugin: Partial<FeatureHost> = {
    app,
    settings,
    executionPersistence: repository,
    providerHost: providerHost as FeatureHost['providerHost'],
    warmExecutionPool: new WarmExecutionPool(() => 5),
    getActiveEnvironmentVariables: () => '',
    getAgentSkillResourceGeneration: () => 0,
    getConversationList: () => repository.list(),
    getConversationById: (id: string) => repository.switchTo(id),
    getConversationSync: (id: string) => repository.getSync(id),
    getCachedConversation: (id: string) => repository.getSync(id),
    switchConversation: (id: string) => repository.switchTo(id),
    updateConversation: (id, updates) => repository.update(id, updates),
    renameConversation: (id, title) => repository.update(id, { title }),
    deleteConversation: (id: string) => repository.delete(id),
    getAllViews: () => views,
    findConversationAcrossViews: (id: string) => {
      for (const view of views) {
        const tab = view.getTabManager()?.getAllTabs().find(candidate => candidate.conversationId === id);
        if (tab) return { view, tabId: tab.id };
      }
      return null;
    },
    isCollabEnabled: () => false,
    ensureConversationMetadataLoaded: async () => {},
    registerTabWorkspaceStateDelivery: () => ({
      declarationsReady: true,
      waitUntilDeclarationsReady: Promise.resolve(),
    }),
  };

  async function restorePane(tabId: string, conversationId = 'shared-chat'): Promise<ClaudianView> {
    const leaf = { app } as unknown as WorkspaceLeaf;
    const view = new ClaudianView(leaf, plugin as FeatureHost);
    views.push(view);
    document.body.appendChild(view.containerEl);
    await view.onOpen();
    await view.setState({
      tabWorkspace: {
        version: 1,
        openTabs: [{ tabId, conversationId }],
        activeTabId: tabId,
      },
    }, { history: false });
    expect(view.getActiveTab()?.conversationId).toBe(conversationId);
    return view;
  }

  return {
    persistence,
    repository,
    restorePane,
    dispose: async () => {
      for (const view of views) {
        await view.onClose();
        view.unload();
      }
    },
  };
}

function openHistory(view: ClaudianView, archived = false): HTMLElement {
  within(view.containerEl).getByRole('button', { name: 'Chat history' }).click();
  if (archived) {
    within(view.containerEl).getByRole('button', { name: 'Archive' }).click();
  }
  return view.containerEl.querySelector<HTMLElement>('[data-conversation-id="shared-chat"]')!;
}

function startWork(tab: AssembledTabRuntime, kind: 'streaming' | 'active-turn' | 'subagent'): () => void {
  if (kind === 'streaming') {
    tab.state.isStreaming = true;
    return () => { tab.state.isStreaming = false; };
  }
  if (kind === 'active-turn') {
    let finish!: () => void;
    tab.session.activeTurn = new Promise<void>(resolve => { finish = resolve; });
    return () => { finish(); tab.session.activeTurn = null; };
  }
  tab.services.subagentManager.handleTaskToolUse('background-task', {
    description: 'Synthetic background work',
    run_in_background: true,
  }, tab.dom.messagesEl);
  return () => { tab.services.subagentManager.clear(); };
}

it.each([
  { archived: false, kind: 'streaming' },
  { archived: true, kind: 'streaming' },
  { archived: false, kind: 'active-turn' },
  { archived: false, kind: 'subagent' },
] as const)('blocks $kind deletion in the archived=$archived list when an idle local copy hides another pane', async ({ archived, kind }) => {
  const harness = await createHarness({ archived });
  let stopWork = () => {};
  try {
    const local = await harness.restorePane('local-tab');
    const remote = await harness.restorePane('remote-tab');
    const localTab = local.getActiveTab()!;
    const remoteTab = remote.getActiveTab()!;
    expect(localTab).not.toBe(remoteTab);
    stopWork = startWork(remoteTab, kind);
    expect(local.getTabManager()!.isTabWorking(localTab.id)).toBe(false);
    expect(remote.getTabManager()!.isTabWorking(remoteTab.id)).toBe(true);

    const row = openHistory(local, archived);
    expect(row.getAttribute('data-open-state')).toBe('current');
    expect(row.getAttribute('data-running')).toBe('false');
    expect((within(row).getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.contextMenu(row);
    const menu = (Menu as typeof Menu & {
      instances: Array<{ items: Array<{ title: string; disabled: boolean }> }>;
    }).instances.at(-1)!;
    expect(menu.items.find(item => item.title === 'Delete')?.disabled).toBe(true);
    expect(await harness.persistence.isDeleted('shared-chat')).toBe(false);
  } finally {
    stopWork();
    await harness.dispose();
  }
});

function createResponseSession(
  phase: 'thinking' | 'text' | 'tool' | 'approval' = 'thinking',
  sessionInstanceId = 'synthetic-response',
) {
  let release!: () => void;
  const settlement = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  let cancelled = false;
  let aborted = false;
  let config: ProviderSessionConfig;
  const session: ProviderExecutionSession = {
    providerId: 'claude',
    sessionInstanceId,
    execute: (request) => {
      started = true;
      request.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      const scope = {
        kind: 'requested' as const,
        sessionInstanceId: session.sessionInstanceId,
        executionId: 'execution',
        turnId: 'turn',
        sequence: 0,
      };
      return {
        executionId: scope.executionId,
        turnId: scope.turnId,
        cancel: () => { cancelled = true; },
        events: (async function* (): AsyncIterable<ProviderExecutionEvent> {
          yield { type: 'turn_started', accepted: true, scope };
          if (phase === 'tool') {
            yield {
              type: 'tool_started',
              name: 'Read',
              input: { file_path: 'example.md' },
              toolCallId: 'read-example',
              toolScope: { kind: 'main' },
              scope: { ...scope, sequence: 1 },
            };
          } else if (phase === 'approval') {
            await config.interactionPort.requestApproval({
              kind: 'approval',
              sessionInstanceId: session.sessionInstanceId,
              turnId: scope.turnId,
              interactionId: 'approval',
              toolName: 'Bash',
              input: { command: 'echo synthetic' },
              description: 'Synthetic approval',
            }, request.signal);
          } else {
            yield {
              type: phase === 'thinking' ? 'thinking_delta' : 'text_delta',
              text: 'Considering the request',
              scope: { ...scope, sequence: 1 },
            };
          }
          await settlement;
          yield { type: 'cancelled', scope: { ...scope, sequence: 2 } };
        })(),
      };
    },
    cancel: () => { cancelled = true; },
    getSnapshot: () => ({ providerId: 'claude', revision: 0, status: 'idle' }),
    getStatus: () => 'idle',
    onEvent: () => () => {},
    dispose: async () => { release(); },
  };
  return {
    session,
    createSession: (sessionConfig: ProviderSessionConfig) => { config = sessionConfig; return session; },
    release,
    get started() { return started; },
    get cancelled() { return cancelled; },
    get aborted() { return aborted; },
  };
}

it('stops only the owning response and waits for real provider settlement without losing queued input', async () => {
  const provider = createResponseSession();
  const otherProvider = createResponseSession('thinking', 'neighbor-response');
  const sessions = [provider.session, otherProvider.session];
  const harness = await createHarness({ createSession: () => {
    const session = sessions.shift();
    if (!session) throw new Error('Unexpected provider session');
    return session;
  } });
  let turn: Promise<void> | undefined;
  let otherTurn: Promise<void> | undefined;
  try {
    const view = await harness.restorePane('active-tab');
    const otherConversation = await harness.repository.create({ providerId: 'claude' });
    const neighbor = await harness.restorePane('neighbor-tab', otherConversation.id);
    const tab = view.getActiveTab()!;
    expect(within(view.containerEl).queryByRole('button', { name: 'Stop response' })).toBeNull();
    tab.dom.inputEl.value = 'Help with this request';
    turn = tab.controllers.inputController.sendMessage();
    await waitFor(() => { expect(provider.started).toBe(true); });
    const otherTab = neighbor.getActiveTab()!;
    otherTab.dom.inputEl.value = 'Keep working independently';
    otherTurn = otherTab.controllers.inputController.sendMessage();
    await waitFor(() => { expect(otherProvider.started).toBe(true); });

    const stop = within(view.containerEl).getByRole<HTMLButtonElement>('button', { name: 'Stop response' });
    expect(stop.type).toBe('button');
    expect(stop.textContent).toBe('Stop');
    expect(stop.title).toContain('esc');
    expect((await configureAxe({ rules: { region: { enabled: false } } })(stop)).violations).toEqual([]);
    tab.dom.inputEl.value = 'Queued follow-up';
    await tab.controllers.inputController.sendMessage();
    tab.dom.inputEl.value = 'Draft still being written';
    stop.click();
    stop.click();

    expect(provider.cancelled).toBe(true);
    expect(tab.state.isStreaming).toBe(true);
    expect(stop.disabled).toBe(true);
    expect(stop.textContent).toBe('Stopping...');
    expect(tab.dom.inputEl.value).toContain('Queued follow-up');
    expect(tab.dom.inputEl.value).toContain('Draft still being written');
    expect(neighbor.getActiveTab()!.state.cancelRequested).toBe(false);
    expect(otherProvider.cancelled).toBe(false);
    expect(otherTab.state.isStreaming).toBe(true);
    expect(within(neighbor.containerEl).getByRole<HTMLButtonElement>('button', { name: 'Stop response' }).disabled).toBe(false);

    provider.release();
    await turn;
    expect(tab.state.isStreaming).toBe(false);
    expect(within(view.containerEl).queryByRole('button', { name: 'Stop response' })).toBeNull();
    expect(tab.state.messages.some(message => message.content === 'Help with this request')).toBe(true);
    expect(tab.state.messages.some(message => message.isInterrupt)).toBe(true);
  } finally {
    provider.release();
    otherProvider.release();
    await turn;
    await otherTurn;
    await harness.dispose();
  }
});

it.each(['text', 'tool', 'approval'] as const)('Escape stops an active %s response with the same pending projection', async phase => {
  const provider = createResponseSession(phase);
  const harness = await createHarness({ createSession: provider.createSession });
  let turn: Promise<void> | undefined;
  try {
    const view = await harness.restorePane('active-tab');
    const tab = view.getActiveTab()!;
    tab.dom.inputEl.value = 'Synthetic request';
    turn = tab.controllers.inputController.sendMessage();
    await waitFor(() => {
      expect(provider.started).toBe(true);
      expect(tab.state.requiresAction).toBe(phase === 'approval');
      expect(tab.state.messages.some(message => message.toolCalls?.length)).toBe(phase === 'tool');
    });
    const stop = within(view.containerEl).getByRole<HTMLButtonElement>('button', { name: 'Stop response' });
    fireEvent.keyDown(tab.dom.inputEl, { key: 'Escape' });
    expect(provider.aborted).toBe(true);
    expect(provider.cancelled).toBe(true);
    expect(stop.disabled).toBe(true);
    expect(stop.textContent).toBe('Stopping...');
    expect(tab.state.isStreaming).toBe(true);
    provider.release();
    await turn;
    expect(tab.state.requiresAction).toBe(false);
    expect(within(view.containerEl).queryByRole('button', { name: 'Stop response' })).toBeNull();
    await harness.dispose();
    tab.state.isStreaming = true;
    stop.click();
    expect(tab.state.cancelRequested).toBe(false);
  } finally {
    provider.release();
    await turn;
    await harness.dispose();
  }
});

it.each(['session preparation', 'input staging'])('never sends a turn stopped during %s', async phase => {
  const provider = createResponseSession();
  let finishPreparation!: () => void;
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
  let preparing = false;
  const harness = await createHarness({
    createSession: () => {
      preparing = phase === 'session preparation';
      return provider.session;
    },
    beforeWrite: async (_path, content) => {
      if (phase === 'input staging' && content.includes('"staged"')) preparing = true;
      if (preparing) await preparation;
    },
  });
  let turn: Promise<void> | undefined;
  try {
    const view = await harness.restorePane('preparing-tab');
    const tab = view.getActiveTab()!;
    tab.dom.inputEl.value = 'Do not send this after I stop';
    turn = tab.controllers.inputController.sendMessage();
    await waitFor(() => { expect(preparing).toBe(true); });
    fireEvent.keyDown(tab.dom.inputEl, { key: 'Escape' });
    const stop = within(view.containerEl).getByRole<HTMLButtonElement>('button', { name: 'Stop response' });
    expect(stop.disabled).toBe(true);
    expect(stop.textContent).toBe('Stopping...');
    expect(tab.state.isStreaming).toBe(true);
    finishPreparation();
    provider.release();
    await turn;
    expect(provider.started).toBe(false);
    expect(tab.state.isStreaming).toBe(false);
    expect(tab.state.messages.some(message => message.isInterrupt)).toBe(true);
    expect(within(view.containerEl).queryByRole('button', { name: 'Stop response' })).toBeNull();
  } finally {
    finishPreparation();
    provider.release();
    await turn;
    await harness.dispose();
  }
});

it('hides the response control when initialization fails and restores the unsent draft', async () => {
  const harness = await createHarness({ createSession: () => { throw new Error('Synthetic initialization failure'); } });
  try {
    const view = await harness.restorePane('failed-tab');
    const tab = view.getActiveTab()!;
    tab.dom.inputEl.value = 'Keep this unsent request';
    await tab.controllers.inputController.sendMessage();
    expect(tab.state.isStreaming).toBe(false);
    expect(tab.dom.inputEl.value).toBe('Keep this unsent request');
    expect(within(view.containerEl).queryByRole('button', { name: 'Stop response' })).toBeNull();
  } finally {
    await harness.dispose();
  }
});

async function createRewindHarness() {
  let finishRewind!: (result: ChatRewindResult) => void;
  const pendingRewind = new Promise<ChatRewindResult>(resolve => { finishRewind = resolve; });
  let providerIsRewinding = false;
  const session: ProviderExecutionSession & RewindableExecutionSession = {
    providerId: 'claude',
    sessionInstanceId: 'synthetic-rewind-session',
    execute: () => { throw new Error('This fixture only supports rewind.'); },
    cancel: () => {},
    getSnapshot: () => ({ providerId: 'claude', revision: 0, status: 'idle' }),
    getStatus: () => 'idle',
    onEvent: () => () => {},
    dispose: async () => {},
    previewRewind: async () => ({ canRewind: true }),
    rewind: async () => {
      providerIsRewinding = true;
      return pendingRewind;
    },
  };
  const harness = await createHarness({
    createSession: () => session,
    messages: [
      { id: 'user', role: 'user', content: 'Question', timestamp: 1, userMessageId: 'native-user' },
      { id: 'assistant', role: 'assistant', content: 'Answer', timestamp: 2, assistantMessageId: 'native-assistant' },
    ],
  });
  let rewind: Promise<void> | undefined;
  return {
    ...harness,
    startRewind: async (tab: AssembledTabRuntime) => {
      rewind = tab.controllers.conversationController.rewind('user', 'conversation');
      (await screen.findByRole('button', { name: 'Rewind' })).click();
      await waitFor(() => { expect(providerIsRewinding).toBe(true); });
    },
    dispose: async () => {
      finishRewind({ canRewind: false, error: 'Synthetic rewind finished.' });
      await rewind;
      await harness.dispose();
    },
  };
}

it('disables deletion across panes while a real provider rewind refuses forced tab closure', async () => {
  const harness = await createRewindHarness();
  try {
    const local = await harness.restorePane('local-tab');
    const remote = await harness.restorePane('remote-tab');
    const remoteTab = remote.getActiveTab()!;
    openHistory(local);

    await harness.startRewind(remoteTab);

    expect(remoteTab.state.isRewinding).toBe(true);
    expect(within(remote.containerEl).queryByRole('button', { name: 'Stop response' })).toBeNull();
    expect(remote.getTabManager()!.isTabWorking(remoteTab.id)).toBe(false);
    expect(await remote.getTabManager()!.closeTab(remoteTab.id, true)).toBe(false);
    const row = local.containerEl.querySelector<HTMLElement>('[data-conversation-id="shared-chat"]')!;
    expect((within(row).getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
    expect(await harness.persistence.isDeleted('shared-chat')).toBe(false);
  } finally {
    await harness.dispose();
  }
});

it('refuses stale deletion confirmation while another restored pane is rewinding', async () => {
  const harness = await createRewindHarness();
  try {
    const local = await harness.restorePane('local-tab');
    const remote = await harness.restorePane('remote-tab');
    const remoteTab = remote.getActiveTab()!;
    openHistory(local);
    within(local.containerEl).getByRole('button', { name: 'Delete' }).click();
    const dialog = await screen.findByRole('dialog', { name: 'Confirm' });

    await harness.startRewind(remoteTab);
    within(dialog).getByRole('button', { name: 'Delete' }).click();

    await waitFor(() => {
      expect(harness.repository.getSync('shared-chat')).not.toBeNull();
      expect(Notice).toHaveBeenCalledWith(expect.stringContaining('rewind to finish'));
    });
    expect(await harness.persistence.isDeleted('shared-chat')).toBe(false);
    expect(remoteTab.state.isRewinding).toBe(true);
  } finally {
    await harness.dispose();
  }
});

it('rechecks another restored pane when work starts during deletion confirmation', async () => {
  const harness = await createHarness();
  try {
    const local = await harness.restorePane('local-tab');
    const remote = await harness.restorePane('remote-tab');
    const remoteTab = remote.getActiveTab()!;
    within(local.containerEl).getByRole('button', { name: 'Chat history' }).click();
    within(local.containerEl).getByRole('button', { name: 'Delete' }).click();
    const dialog = await screen.findByRole('dialog', { name: 'Confirm' });

    remoteTab.state.isStreaming = true;
    within(dialog).getByRole('button', { name: 'Delete' }).click();

    await waitFor(() => {
      expect(harness.repository.getSync('shared-chat')).not.toBeNull();
      expect(Notice).toHaveBeenCalledWith('Stop this session before deleting it.');
    });
    expect(await harness.persistence.isDeleted('shared-chat')).toBe(false);
    expect(remote.getTabManager()!.isTabWorking(remoteTab.id)).toBe(true);
  } finally {
    await harness.dispose();
  }
});

it('does not block an idle target because another pane is working on a different conversation', async () => {
  const harness = await createHarness();
  let stopWork = () => {};
  try {
    const local = await harness.restorePane('local-tab');
    const unrelated = await harness.repository.create({ providerId: 'claude' });
    const remote = await harness.restorePane('remote-tab', unrelated.id);
    const remoteTab = remote.getActiveTab()!;
    stopWork = startWork(remoteTab, 'streaming');

    const row = openHistory(local);
    within(row).getByRole('button', { name: 'Delete' }).click();
    const dialog = await screen.findByRole('dialog', { name: 'Confirm' });
    within(dialog).getByRole('button', { name: 'Delete' }).click();

    await waitFor(async () => { expect(await harness.persistence.isDeleted('shared-chat')).toBe(true); });
    expect(harness.repository.getSync(unrelated.id)).not.toBeNull();
    expect(remote.getTabManager()!.isTabWorking(remoteTab.id)).toBe(true);
  } finally {
    stopWork();
    await harness.dispose();
  }
});
