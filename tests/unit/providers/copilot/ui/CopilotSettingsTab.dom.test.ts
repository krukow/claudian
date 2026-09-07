/**
 * @jest-environment jsdom
 */

jest.mock('obsidian', () => {
  class MockToggleComponent {
    toggleEl = document.createElement('input');
    private callback: ((value: boolean) => Promise<void> | void) | null = null;

    constructor(container: HTMLElement) {
      this.toggleEl.type = 'checkbox';
      container.appendChild(this.toggleEl);
      this.toggleEl.addEventListener('click', () => {
        void this.callback?.(this.toggleEl.checked);
      });
    }

    onChange(callback: (value: boolean) => Promise<void> | void): this {
      this.callback = callback;
      return this;
    }

    setDisabled(disabled: boolean): this {
      this.toggleEl.disabled = disabled;
      return this;
    }

    setValue(value: boolean): this {
      this.toggleEl.checked = value;
      return this;
    }
  }

  class MockTextComponent {
    inputEl = document.createElement('input');
    private callback: ((value: string) => Promise<void> | void) | null = null;

    constructor(container: HTMLElement) {
      this.inputEl.type = 'text';
      container.appendChild(this.inputEl);
      this.inputEl.addEventListener('change', () => {
        void this.callback?.(this.inputEl.value);
      });
    }

    onChange(callback: (value: string) => Promise<void> | void): this {
      this.callback = callback;
      return this;
    }

    setPlaceholder(value: string): this {
      this.inputEl.placeholder = value;
      return this;
    }

    setValue(value: string): this {
      this.inputEl.value = value;
      return this;
    }
  }

  class MockTextAreaComponent {
    inputEl = document.createElement('textarea');

    constructor(container: HTMLElement) {
      container.appendChild(this.inputEl);
    }

    onChange(): this {
      return this;
    }

    setPlaceholder(value: string): this {
      this.inputEl.placeholder = value;
      return this;
    }

    setValue(value: string): this {
      this.inputEl.value = value;
      return this;
    }
  }

  class MockSetting {
    controlEl = document.createElement('div');
    descEl = document.createElement('div');
    nameEl = document.createElement('div');
    settingEl = document.createElement('div');

    constructor(container: HTMLElement) {
      this.settingEl.append(this.nameEl, this.descEl, this.controlEl);
      container.appendChild(this.settingEl);
    }

    addTextArea(callback: (text: MockTextAreaComponent) => void): this {
      callback(new MockTextAreaComponent(this.controlEl));
      return this;
    }

    addText(callback: (text: MockTextComponent) => void): this {
      callback(new MockTextComponent(this.controlEl));
      return this;
    }

    addToggle(callback: (toggle: MockToggleComponent) => void): this {
      callback(new MockToggleComponent(this.controlEl));
      return this;
    }

    setDesc(desc: string): this {
      this.descEl.textContent = desc;
      return this;
    }

    setHeading(): this {
      this.nameEl.setAttribute('role', 'heading');
      this.nameEl.setAttribute('aria-level', '3');
      return this;
    }

    setName(name: string): this {
      this.nameEl.textContent = name;
      return this;
    }
  }

  return {
    ...jest.requireActual('obsidian'),
    Setting: MockSetting,
  };
});

import { screen, within } from '@testing-library/dom';
import { configureAxe } from 'jest-axe';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderSettingsTabRendererContext } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';
import { registerBuiltInProviders } from '@/providers';
import type { CopilotWorkspaceServices } from '@/providers/copilot/app/CopilotWorkspaceServices';
import { getCopilotProviderSettings } from '@/providers/copilot/settings';
import { copilotSettingsTabRenderer } from '@/providers/copilot/ui/CopilotSettingsTab';

const checkAccessibility = configureAxe({ rules: { region: { enabled: false } } });

interface Harness {
  readonly container: HTMLElement;
  readonly settings: Record<string, unknown>;
}

function installObsidianDomHelpers(): void {
  if (!HTMLElement.prototype.addClass) {
    HTMLElement.prototype.addClass = function addClass(this: HTMLElement, ...classes: string[]) {
      this.classList.add(...classes);
    };
  }
  if (!HTMLElement.prototype.empty) {
    HTMLElement.prototype.empty = function empty(this: HTMLElement) {
      this.replaceChildren();
    };
  }
  if (!HTMLElement.prototype.toggleClass) {
    HTMLElement.prototype.toggleClass = function toggleClass(
      this: HTMLElement,
      classes: string | string[],
      value: boolean,
    ) {
      for (const cls of Array.isArray(classes) ? classes : [classes]) {
        this.classList.toggle(cls, value);
      }
    };
  }
}

type SettingsMutation = (value: ClaudianSettings) => void | Promise<void>;

function createHost(settings: Record<string, unknown>): ProviderHost {
  const applyMutation = async (mutation: SettingsMutation): Promise<void> => {
    await mutation(settings as unknown as ClaudianSettings);
  };

  const host: Pick<
    ProviderHost,
    'applyProviderRuntimeSettings'
    | 'getEnvironmentVariablesForScope'
    | 'mutateSettings'
    | 'runProviderExecutionTransition'
    | 'settings'
  > = {
    applyProviderRuntimeSettings: async (_providerIds, mutation, onApplied) => {
      await applyMutation(mutation);
      await onApplied?.();
    },
    getEnvironmentVariablesForScope: () => '',
    mutateSettings: applyMutation,
    runProviderExecutionTransition: async (_providerIds, mutation) => mutation({} as never),
    settings: settings as unknown as ClaudianSettings,
  };
  return host as ProviderHost;
}

function renderSettingsTab(
  settingsOverrides: Record<string, unknown> = {},
): Harness {
  const settings: Record<string, unknown> = {
    envSnippets: [],
    providerConfigs: {},
    ...settingsOverrides,
  };
  const plugin = createHost(settings);
  ProviderWorkspaceRegistry.setServices(
    'copilot',
    { ...createServices(plugin) } as CopilotWorkspaceServices,
  );

  const context: ProviderSettingsTabRendererContext = {
    notifyProviderModelOptionsChanged: () => {},
    plugin,
    renderAgentSkillSettings: () => {},
    renderCustomContextLimits: () => {},
    renderHiddenProviderCommandSetting: () => {},
  };
  const container = document.body.appendChild(document.createElement('div'));
  copilotSettingsTabRenderer.render(container, context);
  return { container, settings };
}

/** Lets the control's own async persistence settle before the assertion. */
async function settleCallbacks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

function createServices(plugin: ProviderHost): CopilotWorkspaceServices {
  return {
    cliResolver: { reset: () => {} },
    refreshModelCatalog: async () => ({ changed: false }),
    settingsTabRenderer: copilotSettingsTabRenderer,
    plugin,
  } as unknown as CopilotWorkspaceServices;
}

describe('Copilot settings tab', () => {
  beforeAll(() => {
    installObsidianDomHelpers();
    registerBuiltInProviders();
  });

  afterEach(() => {
    document.body.replaceChildren();
    ProviderWorkspaceRegistry.setServices('copilot', undefined);
  });

  it('offers the provider switched off, and turns it on through the shared coordinator', async () => {
    const { container, settings } = renderSettingsTab();

    const toggle = within(container)
      .getByRole('checkbox', { name: /Enable Copilot/i }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(getCopilotProviderSettings(settings).enabled).toBe(false);

    toggle.click();
    await settleCallbacks();

    expect(getCopilotProviderSettings(settings).enabled).toBe(true);
  });

  /**
   * A configured path is an answer for this computer, so it is written under the host key
   * and the catalog discovered from the previous CLI is dropped with it.
   */
  it('writes the CLI path for this host and clears the catalog discovered before it', async () => {
    const { container, settings } = renderSettingsTab();

    const cliPath = within(container).getByRole('textbox', { name: 'CLI path' });
    (cliPath as HTMLInputElement).value = '/opt/copilot/bin/copilot';
    cliPath.dispatchEvent(new Event('change'));
    await settleCallbacks();

    const persisted = getCopilotProviderSettings(settings);
    expect(Object.values(persisted.cliPathsByHost)).toEqual(['/opt/copilot/bin/copilot']);
    expect(persisted.cliPath).toBe('');
    expect(persisted.discoveredModels).toEqual([]);
  });

  /**
   * Locale is the only category a vault may set. Proxy reachability and TLS trust decide
   * where an already signed-in CLI sends its requests, and a vault syncs and can be
   * shared, so the section must not invite either.
   */
  it('names only the locale variables the CLI accepts from the vault', () => {
    const { container } = renderSettingsTab();

    const environment = within(container)
      .getByPlaceholderText('LANG=en_US.UTF-8') as HTMLTextAreaElement;
    const description = environment.closest('div')?.parentElement?.textContent ?? '';

    expect(description).toContain('LANG, LC_ALL');
    expect(description).not.toContain('HTTPS_PROXY');
    expect(description).not.toContain('NODE_EXTRA_CA_CERTS');
  });

  it('offers discovery through the shared model picker', () => {
    const { container } = renderSettingsTab();

    expect(within(container).getByRole('button', { name: 'Discover' })).toBeTruthy();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderSettingsTab();

    expect(await checkAccessibility(container)).toHaveNoViolations();
    expect(screen.queryAllByRole('checkbox').length).toBeGreaterThan(0);
  });
});
