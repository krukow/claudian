/**
 * @jest-environment jsdom
 */

jest.mock('obsidian', () => {
  class Dropdown {
    readonly selectEl: HTMLSelectElement;
    constructor(container: HTMLElement) {
      this.selectEl = container.appendChild(document.createElement('select'));
    }
    addOption(value: string, text: string): this {
      const option = this.selectEl.appendChild(document.createElement('option'));
      option.value = value;
      option.textContent = text;
      return this;
    }
    setValue(value: string): this { this.selectEl.value = value; return this; }
    setDisabled(disabled: boolean): this { this.selectEl.disabled = disabled; return this; }
    onChange(callback: (value: string) => void): this {
      this.selectEl.addEventListener('change', () => callback(this.selectEl.value));
      return this;
    }
  }
  class Setting {
    readonly controlEl = document.createElement('div');
    private readonly nameEl = document.createElement('div');
    private readonly descEl = document.createElement('div');

    constructor(container: HTMLElement) {
      const setting = container.appendChild(document.createElement('div'));
      setting.append(this.nameEl, this.descEl, this.controlEl);
    }

    setName(name: string): this {
      this.nameEl.textContent = name;
      return this;
    }

    setDesc(description: string): this {
      this.descEl.textContent = description;
      return this;
    }

    setHeading(): this {
      this.nameEl.setAttribute('role', 'heading');
      this.nameEl.setAttribute('aria-level', '3');
      return this;
    }
    addDropdown(callback: (dropdown: Dropdown) => void): this {
      callback(new Dropdown(this.controlEl));
      return this;
    }
  }
  return { Setting };
});

import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { configureAxe } from 'jest-axe';

import { getProviderConfig } from '@/core/providers/providerConfig';
import type { ProviderSettingsTabRendererContext } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';
import {
  type CopilotPermissionMode,
  getCopilotPermissionMode,
} from '@/providers/copilot/settings';
import { renderCopilotPermissionSettings } from '@/providers/copilot/ui/CopilotPermissionSettings';
import { getHostnameKey } from '@/utils/env';

const checkAccessibility = configureAxe({ rules: { region: { enabled: false } } });

function render(config: Record<string, unknown> = {}, saveError?: Error) {
  const settings = { providerConfigs: { copilot: config } };
  const transitions: string[][] = [];
  const context = {
    plugin: {
      settings,
      applyProviderRuntimeSettings: async (
        providers: string[],
        mutate: (settings: ClaudianSettings) => void,
      ) => {
        if (saveError) throw saveError;
        transitions.push(providers);
        mutate(settings as unknown as ClaudianSettings);
      },
    },
  } as unknown as ProviderSettingsTabRendererContext;
  const container = document.body.appendChild(document.createElement('div'));
  renderCopilotPermissionSettings(container, context);
  return { container, settings, transitions };
}

afterEach(() => document.body.replaceChildren());

describe('Copilot permission settings', () => {
  it('defaults to Ask and exposes accessible native controls without granting anything', async () => {
    const { container, settings } = render();
    const select = screen.getByRole('combobox', { name: 'Copilot permissions' });

    expect((select as HTMLSelectElement).value).toBe('ask');
    expect(within(select).getAllByRole('option').map(option => option.textContent))
      .toEqual(['Ask', 'LLM judge', 'Allow all']);
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Allow all' })).toBeNull();
    expect(getProviderConfig(settings, 'copilot').permissionModesByHost).toBeUndefined();
    expect((await checkAccessibility(container)).violations).toEqual([]);
  });

  it('makes the scope of Allow all explicit before selection', () => {
    render();
    const consent = screen.getByText(/Allow all permits available tools/);

    expect(consent.textContent).toContain('paths outside the vault');
    expect(consent.textContent).toContain('unrestricted network destinations and URLs');
  });

  it.each<CopilotPermissionMode>(['ask', 'allow-all', 'judge'])(
    'saves %s for this computer through the runtime transition',
    async (mode) => {
      const { settings, transitions } = render({
        permissionModesByHost: {
          [getHostnameKey()]: mode === 'ask' ? 'allow-all' : 'ask',
          'another-computer': 'judge',
        },
        futureOption: { keep: true },
      });
      const select = screen.getByRole('combobox', { name: 'Copilot permissions' });

      fireEvent.change(select, { target: { value: mode } });

      await waitFor(() => expect(getCopilotPermissionMode(settings)).toBe(mode));
      expect(getProviderConfig(settings, 'copilot')).toMatchObject({
        permissionModesByHost: { 'another-computer': 'judge' },
        futureOption: { keep: true },
      });
      expect(transitions).toEqual([['copilot']]);
    },
  );

  it('shows Ask for an invalid persisted mode', () => {
    render({ permissionModesByHost: { [getHostnameKey()]: 'auto' } });

    expect((screen.getByRole('combobox', { name: 'Copilot permissions' }) as HTMLSelectElement).value)
      .toBe('ask');
  });

  it('reports a failed save and restores the persisted choice', async () => {
    const { settings } = render({}, new Error('Settings could not be saved.'));
    const select = screen.getByRole('combobox', { name: 'Copilot permissions' });

    fireEvent.change(select, { target: { value: 'allow-all' } });

    await waitFor(() => expect(screen.getByRole('status').textContent)
      .toContain('Settings could not be saved.'));
    expect((select as HTMLSelectElement).value).toBe('ask');
    expect(getCopilotPermissionMode(settings)).toBe('ask');
  });
});
