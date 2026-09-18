/**
 * @jest-environment jsdom
 */

jest.mock('obsidian', () => {
  class Modal {
    modalEl = document.createElement('section');
    contentEl = document.createElement('div');

    constructor() {
      this.modalEl.appendChild(this.contentEl);
      document.body.appendChild(this.modalEl);
    }

    setTitle(title: string): void {
      this.modalEl.setAttribute('aria-label', title);
    }

    close(): void {
      this.onClose();
      this.modalEl.remove();
    }

    onClose(): void {}
  }
  return { ...jest.requireActual('obsidian'), Modal };
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { waitFor, within } from '@testing-library/dom';
import { configureAxe } from 'jest-axe';
import { type App, Notice } from 'obsidian';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution/ProviderExecutionLifecycleRegistry';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { CopilotMcpSignInCoordinator } from '@/providers/copilot/app/CopilotMcpSignInCoordinator';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';
import { CopilotMcpSignInModal } from '@/providers/copilot/ui/CopilotMcpSignInModal';
import { getHostnameKey } from '@/utils/env';

import { createDeferred, FakeCopilotSdkClient, FakeCopilotSdkRuntime } from '../sdk/FakeCopilotSdkRuntime';

const checkAccessibility = configureAxe({ rules: { region: { enabled: false } } });
let root = '';
let service: CopilotMcpSignInCoordinator;
let client: FakeCopilotSdkClient;
let reference: { configPath: string; name: string };
let expectedDisposalFailure: string | undefined;
let registry: ProviderExecutionLifecycleRegistry;

beforeEach(async () => {
  expectedDisposalFailure = undefined;
  jest.mocked(Notice).mockClear();
  HTMLElement.prototype.empty = function empty(this: HTMLElement) { this.replaceChildren(); };
  root = await mkdtemp(path.join(os.tmpdir(), 'claudian-mcp-modal-'));
  reference = { configPath: path.join(root, 'mcp.json'), name: 'notes' };
  await writeFile(reference.configPath, JSON.stringify({
    mcpServers: { notes: { type: 'http', url: 'https://mcp.example.test' } },
  }));
  const settings: Record<string, unknown> = {};
  updateCopilotProviderSettings(settings, {
    enabled: true,
    discoveredModels: [{
      rawId: 'gpt-5-mini', displayName: 'GPT-5 mini',
      reasoningEfforts: [], supportsReasoning: false, supportsVision: false,
    }],
    visibleModels: ['gpt-5-mini'],
    resourcesByHost: {
      [getHostnameKey()]: {
        additionalMcpConfigPaths: [], additionalSkillRoots: [], selectedSkillPaths: [],
        rememberMcpSignIns: true, selectedMcpServers: [reference],
      },
    },
  });
  client = new FakeCopilotSdkClient({
    onSessionCreated: session => {
      Object.assign(session, {
        signInMcpServer: async () => ({ authorizationUrl: 'https://login.example.test/authorize' }),
      });
    },
  });
  registry = new ProviderExecutionLifecycleRegistry();
  const host = {
    app: { vault: { adapter: { basePath: root } } },
    executionLifecycleRegistry: registry,
    getResolvedProviderCliPath: async () => '/usr/bin/copilot',
    runProviderExecutionTransition: registry.runTransition.bind(registry),
    settings,
  } as unknown as ProviderHost;
  service = new CopilotMcpSignInCoordinator(host, {
    runtime: new FakeCopilotSdkRuntime(() => client),
  });
});

afterEach(async () => {
  const expectedFailure = expectedDisposalFailure;
  if (expectedFailure) {
    await service.dispose().catch(error => {
      if (!(error instanceof Error) || !error.message.includes(expectedFailure)) throw error;
    });
  } else {
    await service?.dispose();
  }
  document.body.replaceChildren();
  await rm(root, { recursive: true, force: true });
});

it('shows a named browser handoff and reports success only after the server connects', async () => {
  const modal = new CopilotMcpSignInModal({} as App, service, reference);
  modal.onOpen();
  const dialog = within(document.body).getByRole('dialog', { name: 'Sign in to notes' });
  const link = await waitFor(() => within(dialog).getByRole('link', { name: 'Continue on login.example.test' }));

  expect(link.getAttribute('href')).toBe('https://login.example.test/authorize');
  expect(within(dialog).getByRole('status').textContent).toContain('Complete sign-in in your browser');
  expect(within(dialog).queryByRole('button', { name: 'Done' })).toBeNull();
  expect(await checkAccessibility(dialog)).toHaveNoViolations();
  client.lastSession?.emit({
    id: 'connected', parentId: null, timestamp: '2026-09-17T12:00:00Z',
    type: 'session.mcp_server_status_changed', ephemeral: true,
    data: { serverName: 'notes', status: 'connected' },
  });

  const done = await waitFor(() => within(dialog).getByRole('button', { name: 'Done' }));
  expect(within(dialog).getByRole('status').textContent).toContain('Signed in');
  done.click();
  expect(service.getState(reference).phase).toBe('connected');
  expect(within(document.body).queryByRole('dialog')).toBeNull();
});

it('cancels browser waiting and releases the temporary native session', async () => {
  const modal = new CopilotMcpSignInModal({} as App, service, reference);
  modal.onOpen();
  const dialog = within(document.body).getByRole('dialog', { name: 'Sign in to notes' });
  await waitFor(() => within(dialog).getByRole('link'));

  within(dialog).getByRole('button', { name: 'Cancel' }).click();

  await waitFor(() => { expect(service.getState(reference).phase).toBe('idle'); });
  expect(client.deletedSessions).toEqual([client.lastSession?.sessionId]);
  expect(within(document.body).queryByRole('dialog')).toBeNull();
});

it('shows native failure and lets the user retry without enabling another server', async () => {
  client = new FakeCopilotSdkClient({
    onSessionCreated: session => {
      Object.assign(session, {
        signInMcpServer: async () => { throw new Error('The selected server is unavailable.'); },
      });
    },
  });
  const modal = new CopilotMcpSignInModal({} as App, service, reference);
  modal.onOpen();
  const dialog = within(document.body).getByRole('dialog', { name: 'Sign in to notes' });
  const retry = await waitFor(() => within(dialog).getByRole('button', { name: 'Try again' }));
  expect(within(dialog).getByRole('status').textContent).toContain('The selected server is unavailable.');
  client = new FakeCopilotSdkClient({
    onSessionCreated: session => {
      Object.assign(session, {
        signInMcpServer: async () => ({ authorizationUrl: 'https://login.example.test/authorize' }),
      });
    },
  });

  retry.click();

  await waitFor(() => within(dialog).getByRole('link', { name: 'Continue on login.example.test' }));
  expect(Object.keys(client.lastSession?.config.resources?.mcpServers ?? {})).toEqual(['notes']);
  modal.onClose();
});

it('reopens browser sign-in after the cancelled modal finishes releasing its client', async () => {
  const stopping = createDeferred();
  const release = createDeferred();
  client = new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpSignInBehavior = async () => ({ authorizationUrl: 'https://login.example.test/authorize' });
    },
    stopBehavior: async () => { stopping.resolve(); await release.promise; },
  });
  const first = new CopilotMcpSignInModal({} as App, service, reference);
  first.onOpen();
  const firstDialog = within(document.body).getByRole('dialog', { name: 'Sign in to notes' });
  await waitFor(() => within(firstDialog).getByRole('link'));
  within(firstDialog).getByRole('button', { name: 'Cancel' }).click();
  await stopping.promise;
  client = new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpSignInBehavior = async () => ({ authorizationUrl: 'https://login.example.test/new-authorization' });
    },
  });
  const reopened = new CopilotMcpSignInModal({} as App, service, reference);
  reopened.onOpen();
  release.resolve();
  try {
    const dialog = within(document.body).getByRole('dialog', { name: 'Sign in to notes' });
    const link = await waitFor(() => within(dialog).getByRole('link', { name: 'Continue on login.example.test' }));
    expect(link.getAttribute('href')).toBe('https://login.example.test/new-authorization');
  } finally {
    reopened.close();
  }
});

it('reports failed cancellation cleanup after the sign-in dialog has closed', async () => {
  expectedDisposalFailure = 'Native MCP shutdown failed.';
  client = new FakeCopilotSdkClient({
    onSessionCreated: session => {
      session.mcpSignInBehavior = async () => ({ authorizationUrl: 'https://login.example.test/authorize' });
    },
    stopBehavior: async () => { throw new Error('Native MCP shutdown failed.'); },
  });
  const modal = new CopilotMcpSignInModal({} as App, service, reference);
  modal.onOpen();
  const dialog = within(document.body).getByRole('dialog', { name: 'Sign in to notes' });
  await waitFor(() => within(dialog).getByRole('link'));
  within(dialog).getByRole('button', { name: 'Cancel' }).click();

  expect(within(document.body).queryByRole('dialog')).toBeNull();
  await waitFor(() => {
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining('Native MCP shutdown failed.'));
  });
  await expect(service.dispose()).rejects.toThrow('Native MCP shutdown failed.');
});

it.each([false, true])('keeps confirmed sign-in distinct from failed chat refresh when closed=%s', async closed => {
  const entered = createDeferred();
  const release = createDeferred();
  registry.registerTransitionHook('copilot', {
    beforeTransition: async () => {
      entered.resolve();
      await release.promise;
      throw new Error('Existing chat runtime could not be refreshed.');
    },
  });
  client = new FakeCopilotSdkClient();
  const modal = new CopilotMcpSignInModal({} as App, service, reference);
  modal.onOpen();
  await entered.promise;
  const dialog = within(document.body).getByRole('dialog', { name: 'Sign in to notes' });
  expect(client.stopped).toBe(1);
  expect(within(dialog).queryByRole('button', { name: 'Done' })).toBeNull();
  if (closed) within(dialog).getByRole('button', { name: 'Cancel' }).click();
  release.resolve();

  await waitFor(() => {
    const message = closed
      ? jest.mocked(Notice).mock.calls.at(-1)?.[0]
      : within(dialog).getByRole('status').textContent;
    expect(message).toContain('Signed in, but follow-up failed: Existing chat runtime could not be refreshed.');
  });
  expect(within(document.body).queryByRole('button', { name: 'Done' }) !== null).toBe(!closed);
  expect(within(document.body).queryByRole('button', { name: 'Try again' })).toBeNull();
  if (!closed) modal.close();
  await expect(service.dispose()).resolves.toBeUndefined();
});

it.each(['refresh', 'fence', 'cleanup'] as const)(
  'does not repeat an old %s warning when a later clean sign-in closes',
  async failureKind => {
    const entered = createDeferred();
    const release = createDeferred();
    const unregister = registry.registerTransitionHook('copilot', {
      beforeTransition: () => {
        if (failureKind === 'refresh') throw new Error('Old runtime refresh failed.');
      },
    });
    client = new FakeCopilotSdkClient({
      stopBehavior: async () => {
        if (failureKind === 'cleanup') throw new Error('Old native cleanup failed.');
        if (failureKind === 'fence') { entered.resolve(); await release.promise; }
      },
    });
    expectedDisposalFailure = failureKind === 'cleanup' ? 'Old native cleanup failed.' : undefined;
    const first = new CopilotMcpSignInModal({} as App, service, reference);
    first.onOpen();
    if (failureKind === 'fence') {
      await entered.promise;
      const changing = registry.runTransition(['copilot'], async () => {});
      await waitFor(() => {
        if (registry.getProviderGeneration('copilot') !== 1) throw new Error('Transition has not started.');
      });
      release.resolve();
      await changing;
    }
    const firstDialog = within(document.body).getByRole('dialog', { name: 'Sign in to notes' });
    const firstDone = await waitFor(() => within(firstDialog).getByRole('button', { name: 'Done' }));
    expect(within(firstDialog).getByRole('status').textContent).toContain('follow-up failed');
    firstDone.click();
    unregister();

    client = new FakeCopilotSdkClient();
    const second = new CopilotMcpSignInModal({} as App, service, reference);
    second.onOpen();
    const message = {
      refresh: 'Old runtime refresh failed.',
      fence: 'Copilot settings changed during MCP sign-in. Try again.',
      cleanup: 'Old native cleanup failed.',
    }[failureKind];
    await waitFor(() => {
      expect(Notice).toHaveBeenCalledWith(`Signed in, but follow-up failed: ${message}`);
    });
    const oldNotices = [...jest.mocked(Notice).mock.calls];
    const secondDialog = within(document.body).getByRole('dialog', { name: 'Sign in to notes' });
    const done = await waitFor(() => within(secondDialog).getByRole('button', { name: 'Done' }));
    expect(service.getState(reference)).toEqual({ phase: 'connected' });
    done.click();
    await expect(service.cancel(reference)).resolves.toBeUndefined();
    expect(jest.mocked(Notice).mock.calls).toEqual(oldNotices);

    const error = expect.objectContaining({ message: expect.stringContaining('Old native cleanup failed.') });
    expect(await Promise.allSettled([service.dispose()])).toEqual(failureKind === 'cleanup'
      ? [{ status: 'rejected', reason: error }]
      : [{ status: 'fulfilled', value: undefined }]);
  },
);
