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
import type { App } from 'obsidian';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { CopilotMcpSignInCoordinator } from '@/providers/copilot/app/CopilotMcpSignInCoordinator';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';
import { CopilotMcpSignInModal } from '@/providers/copilot/ui/CopilotMcpSignInModal';
import { getHostnameKey } from '@/utils/env';

import { FakeCopilotSdkClient, FakeCopilotSdkRuntime } from '../sdk/FakeCopilotSdkRuntime';

const checkAccessibility = configureAxe({ rules: { region: { enabled: false } } });
let root = '';
let service: CopilotMcpSignInCoordinator;
let client: FakeCopilotSdkClient;
let reference: { configPath: string; name: string };

beforeEach(async () => {
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
  const host = {
    app: { vault: { adapter: { basePath: root } } },
    getResolvedProviderCliPath: async () => '/usr/bin/copilot',
    runProviderExecutionTransition: async (_ids: unknown, mutate: () => Promise<void>) => mutate(),
    settings,
  } as unknown as ProviderHost;
  service = new CopilotMcpSignInCoordinator(host, {
    runtime: new FakeCopilotSdkRuntime(() => client),
  });
});

afterEach(async () => {
  await service?.dispose();
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
