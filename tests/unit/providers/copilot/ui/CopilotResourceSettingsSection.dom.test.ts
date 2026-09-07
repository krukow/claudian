/**
 * @jest-environment jsdom
 */

jest.mock('obsidian', () => {
  class MockTextAreaComponent {
    inputEl = document.createElement('textarea');
    private callback: ((value: string) => Promise<void> | void) | null = null;

    constructor(container: HTMLElement) {
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

  return { ...jest.requireActual('obsidian'), Setting: MockSetting };
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { waitFor, within } from '@testing-library/dom';
import { configureAxe } from 'jest-axe';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderSettingsTabRendererContext } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';
import { CopilotCommandLoader } from '@/providers/copilot/app/CopilotCommandLoader';
import { CopilotCommandMetadataProbe } from '@/providers/copilot/app/CopilotCommandMetadataProbe';
import type { CopilotWorkspaceServices } from '@/providers/copilot/app/CopilotWorkspaceServices';
import { getCopilotHostResources } from '@/providers/copilot/resources/CopilotHostResources';
import { renderCopilotResourceSettings } from '@/providers/copilot/ui/CopilotResourceSettingsSection';

const checkAccessibility = configureAxe({ rules: { region: { enabled: false } } });

let workspace = '';

jest.mock('node:os', () => ({
  ...jest.requireActual<typeof os>('node:os'),
  homedir: () => path.join(workspaceRoot(), 'home'),
}));

function workspaceRoot(): string {
  return workspace;
}

function installObsidianDomHelpers(): void {
  if (!HTMLElement.prototype.empty) {
    HTMLElement.prototype.empty = function empty(this: HTMLElement) {
      this.replaceChildren();
    };
  }
}

function write(relativePath: string, content: string): string {
  const target = path.join(workspace, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
}

function renderSection(persistenceError?: Error): {
  container: HTMLElement;
  commandLoader: CopilotCommandLoader;
  settings: Record<string, unknown>;
} {
  const settings: Record<string, unknown> = { providerConfigs: {} };
  const host = {
    app: { vault: { adapter: { basePath: path.join(workspace, 'vault') } } },
    applyProviderRuntimeSettings: async (
      _providerIds: readonly string[],
      mutation: (value: ClaudianSettings) => void,
      onApplied?: () => void,
    ) => {
      if (persistenceError) {
        throw persistenceError;
      }
      mutation(settings as unknown as ClaudianSettings);
      onApplied?.();
    },
    settings: settings as unknown as ClaudianSettings,
  } as unknown as ProviderHost;

  const commandLoader = new CopilotCommandLoader(new CopilotCommandMetadataProbe(host));
  ProviderWorkspaceRegistry.setServices('copilot', { commandLoader } as CopilotWorkspaceServices);

  const context = {
    notifyProviderModelOptionsChanged: () => {},
    plugin: host,
    renderAgentSkillSettings: () => {},
    renderCustomContextLimits: () => {},
    renderHiddenProviderCommandSetting: () => {},
  } as unknown as ProviderSettingsTabRendererContext;

  const container = document.body.appendChild(document.createElement('div'));
  renderCopilotResourceSettings(container, context);
  return { commandLoader, container, settings };
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** Waits for the discovery the button started to reach the list. */
async function discovered(container: HTMLElement, name: RegExp): Promise<HTMLInputElement> {
  return waitFor(() => (
    within(container).getByRole('checkbox', { name }) as HTMLInputElement
  ));
}

beforeAll(() => {
  installObsidianDomHelpers();
});

beforeEach(() => {
  workspace = mkdtempSync(path.join(os.tmpdir(), 'copilot-resource-ui-'));
});

afterEach(() => {
  document.body.replaceChildren();
  ProviderWorkspaceRegistry.setServices('copilot', undefined);
  rmSync(workspace, { force: true, recursive: true });
});

describe('Copilot resource settings', () => {
  it('shows nothing selected and nothing discovered until discovery runs', () => {
    const { container } = renderSection();

    expect(within(container).getByRole('button', { name: 'Discover resources' }))
      .toBeTruthy();
    expect(within(container).queryAllByRole('checkbox')).toEqual([]);
    expect(container.textContent).toContain('Nothing discovered yet.');
  });

  it('selects a discovered server as a reference, without its definition', async () => {
    write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: '/usr/bin/notes-mcp', env: { TOKEN: 'private' } } },
    }));
    const { commandLoader, container, settings } = renderSection();
    const fingerprint = commandLoader.getCacheFingerprint(settings);

    within(container).getByRole('button', { name: 'Discover resources' }).click();
    const toggle = await discovered(container, /MCP server: notes/);
    toggle.click();
    await settle();

    expect(getCopilotHostResources(settings).selectedMcpServers).toEqual([{
      configPath: path.join(workspace, 'home', '.copilot', 'mcp-config.json'),
      name: 'notes',
    }]);
    expect(JSON.stringify(settings)).not.toContain('private');
    expect(commandLoader.getCacheFingerprint(settings)).not.toBe(fingerprint);
  });

  it('refreshes native command metadata without changing the selected skill', async () => {
    const skillPath = write('home/.copilot/skills/review/SKILL.md', '---\nname: review\n---\n');
    const { commandLoader, container, settings } = renderSection();
    within(container).getByRole('button', { name: 'Discover resources' }).click();
    (await discovered(container, /Skill: review/)).click();
    await settle();
    const fingerprint = commandLoader.getCacheFingerprint(settings);

    writeFileSync(skillPath, '---\nname: review\ndescription: Updated skill\n---\n');
    within(container).getByRole('button', { name: 'Refresh resources' }).click();
    await discovered(container, /Updated skill/);

    expect(commandLoader.getCacheFingerprint(settings)).not.toBe(fingerprint);
    expect(getCopilotHostResources(settings).selectedSkillPaths).toEqual([skillPath]);
  });

  it('keeps both choices when resources are toggled before the list rerenders', async () => {
    write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: {
        notes: { command: 'notes-mcp' },
        wiki: { command: 'wiki-mcp' },
      },
    }));
    const { container, settings } = renderSection();
    within(container).getByRole('button', { name: 'Discover resources' }).click();
    const notes = await discovered(container, /MCP server: notes/);
    const wiki = await discovered(container, /MCP server: wiki/);

    notes.click();
    wiki.click();
    await settle();

    expect(getCopilotHostResources(settings).selectedMcpServers.map(ref => ref.name))
      .toEqual(['notes', 'wiki']);
  });

  it('reports a failed save and restores the actual selection', async () => {
    write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: 'notes-mcp' } },
    }));
    const { container, settings } = renderSection(new Error('Settings storage unavailable.'));
    within(container).getByRole('button', { name: 'Discover resources' }).click();
    (await discovered(container, /MCP server: notes/)).click();
    await settle();

    expect(within(container).getByRole('status').textContent)
      .toContain('Settings storage unavailable.');
    expect(getCopilotHostResources(settings).selectedMcpServers).toEqual([]);
    expect((within(container).getByRole('checkbox', {
      name: /MCP server: notes/,
    }) as HTMLInputElement).checked).toBe(false);
  });

  it('names both custom source path inputs', () => {
    const { container } = renderSection();

    expect(within(container).getByRole('textbox', {
      name: 'Additional MCP configuration files',
    })).toBeTruthy();
    expect(within(container).getByRole('textbox', {
      name: 'Additional skill folders',
    })).toBeTruthy();
  });

  it('filters the list without changing what is selected', async () => {
    write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: '/usr/bin/notes-mcp' } },
    }));
    write('home/.copilot/skills/review/SKILL.md', '---\nname: review\n---\n');
    const { container } = renderSection();

    within(container).getByRole('button', { name: 'Discover resources' }).click();
    await discovered(container, /Skill: review/);
    expect(within(container).queryAllByRole('checkbox')).toHaveLength(2);

    const filter = within(container)
      .getByRole('searchbox', { name: 'Filter resources' }) as HTMLInputElement;
    filter.value = 'review';
    filter.dispatchEvent(new Event('input'));

    const remaining = within(container).queryAllByRole('checkbox');
    expect(remaining).toHaveLength(1);
    expect(within(container).getByRole('checkbox', { name: /Skill: review/ })).toBeTruthy();
  });

  /**
   * A selection is the user's answer. Discovery that no longer finds it says the file
   * moved, which is something to fix rather than a reason to switch a server off.
   */
  it('keeps a selection discovery no longer finds, and says so', async () => {
    const configPath = write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: '/usr/bin/notes-mcp' } },
    }));
    const { container, settings } = renderSection();

    within(container).getByRole('button', { name: 'Discover resources' }).click();
    (await discovered(container, /MCP server: notes/)).click();
    await settle();
    rmSync(configPath);
    within(container).getByRole('button', { name: 'Refresh resources' }).click();
    await waitFor(() => {
      expect(container.textContent).toContain('not found on this computer');
    });

    expect(getCopilotHostResources(settings).selectedMcpServers).toHaveLength(1);
    const row = within(container).getByRole('checkbox', { name: /MCP server: notes/ });
    expect((row as HTMLInputElement).checked).toBe(true);
    expect(container.textContent).toContain('not found on this computer');
  });

  it('reports a malformed source without dropping the rest', async () => {
    write('home/.copilot/mcp-config.json', '{ not json');
    write('home/.copilot/skills/review/SKILL.md', '---\nname: review\n---\n');
    const { container } = renderSection();

    within(container).getByRole('button', { name: 'Discover resources' }).click();
    await discovered(container, /Skill: review/);

    expect(container.textContent).toContain('mcp-config.json');
  });

  it('has no accessibility violations once resources are listed', async () => {
    write('home/.copilot/skills/review/SKILL.md', '---\nname: review\n---\n');
    const { container } = renderSection();

    within(container).getByRole('button', { name: 'Discover resources' }).click();
    await discovered(container, /Skill: review/);

    expect(await checkAccessibility(container)).toHaveNoViolations();
  });
});
