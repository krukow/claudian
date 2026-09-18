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

    close(): void {}
  }
  return { ...jest.requireActual('obsidian'), Modal };
});

import { deserialize, serialize } from 'node:v8';

import { waitFor, within } from '@testing-library/dom';
import { configureAxe } from 'jest-axe';
import type { App } from 'obsidian';

import { ChatModelSelectionCoordinator } from '@/app/settings/ChatModelSelectionCoordinator';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ClaudianSettings } from '@/core/types';
import { registerBuiltInProviders } from '@/providers';
import { CopilotConnectionCoordinator } from '@/providers/copilot/app/CopilotConnectionCoordinator';
import { getCopilotProviderSettings } from '@/providers/copilot/settings';
import { CopilotConnectionModal } from '@/providers/copilot/ui/CopilotConnectionModal';

import { createDeferred, FakeCopilotSdkClient, FakeCopilotSdkRuntime } from '../sdk/FakeCopilotSdkRuntime';

const checkAccessibility = configureAxe({ rules: { region: { enabled: false } } });

beforeAll(() => {
  registerBuiltInProviders();
  HTMLElement.prototype.empty = function empty(this: HTMLElement) { this.replaceChildren(); };
  global.structuredClone = <T>(value: T): T => deserialize(serialize(value)) as T;
});
afterEach(() => { document.body.replaceChildren(); });

it.each([false, true])('publishes a chosen model even if dismissed during save=%s', async dismissDuringSave => {
  const saving = createDeferred();
  const commit = createDeferred();
  const settings: Record<string, unknown> = { settingsProvider: 'copilot' };
  const settingsCoordinator = new SettingsCoordinator(
    settings as unknown as ClaudianSettings, async () => {
      saving.resolve();
      await commit.promise;
    },
  );
  const host = {
    app: { vault: { adapter: { basePath: '/vault' } } },
    chatModelSelection: new ChatModelSelectionCoordinator(settingsCoordinator),
    mutateSettings: (mutation: (settings: ClaudianSettings) => void) => (
      settingsCoordinator.mutate(mutation)
    ),
    executionLifecycleRegistry: new ProviderExecutionLifecycleRegistry(),
    getResolvedProviderCliPath: async () => '/usr/bin/copilot',
    notifyProviderChatOptionsChanged: () => {},
    settings,
  } as unknown as ProviderHost;
  const connection = new CopilotConnectionCoordinator(host, {
    login: { signIn: async () => { throw new Error('Already authenticated.'); } },
    runtime: new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      models: [{
        capabilities: {
          limits: { max_context_window_tokens: 128_000 },
          supports: { reasoningEffort: false, vision: false },
        },
        id: 'gpt-5-mini',
        name: 'GPT-5 mini',
      }],
    })),
  });
  let projectedModel: string | undefined;
  const modal = new CopilotConnectionModal({} as App, connection, () => {
    projectedModel = getCopilotProviderSettings(settings).visibleModels[0];
  });
  modal.onOpen();
  try {
    const dialog = within(document.body).getByRole('dialog', { name: 'Connect Copilot' });
    const useModel = await waitFor(() => within(dialog).getByRole('button', { name: 'Use this model' }));

    expect(within(dialog).getByRole('combobox', { name: 'Copilot model' })).toBeTruthy();
    expect(getCopilotProviderSettings(settings).enabled).toBe(false);
    expect(await checkAccessibility(dialog)).toHaveNoViolations();
    useModel.click();
    await saving.promise;
    if (dismissDuringSave) {
      modal.onClose();
    }
    commit.resolve();

    await waitFor(() => {
      expect(projectedModel).toBe('gpt-5-mini');
    });
    expect(getCopilotProviderSettings(settings).visibleModels).toEqual(['gpt-5-mini']);
    expect(getCopilotProviderSettings(settings).enabled).toBe(true);
    expect(Boolean(within(dialog).queryByRole('button', { name: 'Done' }))).toBe(!dismissDuringSave);
  } finally {
    commit.resolve();
    modal.onClose();
    await connection.dispose();
  }
});
