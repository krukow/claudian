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

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import {
  getCopilotHostResources,
  updateCopilotHostResources,
} from '@/providers/copilot/resources/CopilotHostResources';
import { resolveCopilotSelectedResources } from '@/providers/copilot/resources/CopilotResourceResolver';
import type { CopilotResourceSettings } from '@/providers/copilot/resources/CopilotResourceSettings';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';
import { renderCopilotResourceSettings } from '@/providers/copilot/ui/CopilotResourceSettingsSection';

const checkAccessibility = configureAxe({ rules: { region: { enabled: false } } });

let workspace = '';

jest.mock('node:os', () => ({
  ...jest.requireActual<typeof os>('node:os'),
  homedir: jest.fn(() => path.join(workspaceRoot(), 'home')),
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

function renderSection(options: {
  persistenceError?: Error;
  resources?: Partial<CopilotResourceSettings>;
  settings?: Record<string, unknown>;
  vaultDirectory?: string;
} = {}): {
  container: HTMLElement;
  commandLoader: CopilotCommandLoader;
  persistedSelections: CopilotResourceSettings[];
  settings: Record<string, unknown>;
} {
  const settings = options.settings ?? { providerConfigs: {} };
  if (options.resources) {
    updateCopilotProviderSettings(settings, {
      resourcesByHost: updateCopilotHostResources(settings, options.resources),
    });
  }
  const persistedSelections: CopilotResourceSettings[] = [];
  const host = {
    app: { vault: { adapter: { basePath: options.vaultDirectory ?? path.join(workspace, 'vault') } } },
    applyProviderRuntimeSettings: async (
      _providerIds: readonly string[],
      mutation: (value: ClaudianSettings) => void,
      onApplied?: () => void,
    ) => {
      if (options.persistenceError) {
        throw options.persistenceError;
      }
      mutation(settings as unknown as ClaudianSettings);
      persistedSelections.push(getCopilotHostResources(settings));
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
  return { commandLoader, container, persistedSelections, settings };
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** Waits for discovery to reach the list. */
async function discovered(container: HTMLElement, name: RegExp): Promise<HTMLInputElement> {
  return waitFor(() => (
    within(container).getByRole('checkbox', { name }) as HTMLInputElement
  ));
}

function resourceCheckboxes(container: HTMLElement): HTMLElement[] {
  return within(container).queryAllByRole('checkbox', { name: /^(MCP server|Skill):/ });
}

beforeAll(() => {
  installObsidianDomHelpers();
});

beforeEach(() => {
  workspace = path.resolve('.context', `copilot-resource-ui-${randomUUID()}`);
  mkdirSync(path.join(workspace, 'vault', '.git'), { recursive: true });
});

afterEach(async () => {
  await waitFor(() => {
    const pending = within(document.body).queryAllByRole('button', {
      name: 'Discovering resources',
    });
    if (pending.length > 0) {
      throw new Error('Resource discovery is still running.');
    }
  });
  document.body.replaceChildren();
  ProviderWorkspaceRegistry.setServices('copilot', undefined);
  rmSync(workspace, { force: true, recursive: true });
});

describe('Copilot resource settings', () => {
  it('automatically verifies selected resources without false missing labels or settings writes', async () => {
    const configPath = write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: 'notes-mcp' } },
    }));
    const skillPath = write('home/.copilot/skills/review/SKILL.md', '---\nname: review\n---\n');
    const { commandLoader, container, persistedSelections, settings } = renderSection({
      resources: {
        selectedMcpServers: [{ configPath, name: 'notes' }],
        selectedSkillPaths: [skillPath],
      },
    });
    const fingerprint = commandLoader.getCacheFingerprint(settings);

    expect(container.textContent).not.toContain('not found on this computer');
    expect(within(container).getByRole('checkbox', { name: /MCP server: notes.*not checked yet/ }))
      .toBeTruthy();
    expect(within(container).getByRole('checkbox', { name: /Skill: review.*not checked yet/ }))
      .toBeTruthy();
    expect((within(container).getByRole('button', {
      name: 'Discovering resources',
    }) as HTMLButtonElement).disabled).toBe(true);

    await waitFor(() => {
      expect(within(container).getByRole('button', { name: 'Refresh resources' })).toBeTruthy();
    });

    expect(container.textContent).not.toContain('not checked yet');
    expect(container.textContent).not.toContain('not found on this computer');
    expect(resourceCheckboxes(container).every(element => (element as HTMLInputElement).checked))
      .toBe(true);
    expect(persistedSelections).toEqual([]);
    expect(commandLoader.getCacheFingerprint(settings)).toBe(fingerprint);
  });

  it.each([false, true])('does not change an unverified saved skill before discovering its repository scope (alias: %s)', async (linked) => {
    const skillPath = write('vault/.github/skills/review/SKILL.md', '---\nname: review\n---\n');
    const vault = path.join(workspace, linked ? 'linked-vault' : 'vault');
    if (linked) symlinkSync(path.join(workspace, 'vault'), vault, 'junction');
    const { container, persistedSelections, settings } = renderSection({
      resources: { selectedSkillPaths: [path.join(vault, '.github', 'skills', 'review', 'SKILL.md')] },
      vaultDirectory: vault,
    });
    const pending = within(container).getByRole('checkbox', {
      name: /Skill: review.*not checked yet/,
    }) as HTMLInputElement;
    pending.click();

    expect(pending.checked).toBe(true);
    expect(persistedSelections).toEqual([]);
    expect(container.textContent).not.toContain('not found on this computer');
    const verified = await discovered(container, /Skill: review.*repository skill/);
    expect(verified).toBe(pending);
    expect(verified.disabled).toBe(false);
    verified.focus();
    verified.click();
    await settle();

    expect(document.activeElement).toBe(verified);
    expect(verified.checked).toBe(false);
    expect(getCopilotHostResources(settings)).toMatchObject({
      selectedSkillPaths: [], disabledRepositorySkillPaths: [skillPath],
    });
    expect(await resolveCopilotSelectedResources(
      getCopilotHostResources(settings), path.join(workspace, 'vault'),
    )).toEqual({ problems: [], resources: null });
  });

  it('cannot bulk-disable unverified skills after discovery fails', async () => {
    const skillPath = write('vault/.github/skills/review/SKILL.md', '---\nname: review\n---\n');
    jest.mocked(os.homedir).mockImplementationOnce(() => {
      throw new Error('Home directory unavailable.');
    });
    const { container, settings, persistedSelections } = renderSection({
      resources: { selectedSkillPaths: [skillPath] },
    });
    const disable = within(container).getByRole('button', { name: 'Disable all resources' }) as HTMLButtonElement;
    const checkbox = within(container).getByRole('checkbox', { name: /Skill: review.*not checked yet/ }) as HTMLInputElement;
    disable.click();
    checkbox.click();

    expect(disable.disabled).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(true);
    expect(getCopilotHostResources(settings).selectedSkillPaths).toEqual([skillPath]);
    expect(persistedSelections).toEqual([]);
    expect(within(container).getByRole('status').textContent).toContain('Discovery failed');
  });

  it('clears alias opt-outs when automatic skills are enabled in bulk', async () => {
    const skillPath = write('vault/.github/skills/review/SKILL.md', '---\nname: review\n---\n');
    const alias = path.join(workspace, 'linked-vault');
    symlinkSync(path.join(workspace, 'vault'), alias, 'junction');
    const saved = path.join(alias, '.github', 'skills', 'review', 'SKILL.md');
    const { container, settings } = renderSection({
      resources: { selectedSkillPaths: [saved], disabledRepositorySkillPaths: [saved] },
    });
    const checkbox = await discovered(container, /Skill: review.*repository skill/);
    expect(resourceCheckboxes(container)).toEqual([checkbox]);
    expect(checkbox.checked).toBe(false);
    within(container).getByRole('button', { name: 'Enable all resources' }).click();
    await settle();

    expect(checkbox.checked).toBe(true);
    expect(getCopilotHostResources(settings).selectedSkillPaths).toEqual([]);
    expect(getCopilotHostResources(settings)).not.toHaveProperty('disabledRepositorySkillPaths');
    expect((await resolveCopilotSelectedResources(getCopilotHostResources(settings), alias)).resources?.skillPaths)
      .toEqual([skillPath]);
  });

  it('keeps selections unverified after failed automatic discovery and can retry', async () => {
    const configPath = write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: 'notes-mcp' } },
    }));
    jest.mocked(os.homedir).mockImplementationOnce(() => {
      throw new Error('Home directory unavailable.');
    });
    const { container, persistedSelections, settings } = renderSection({
      resources: { selectedMcpServers: [{ configPath, name: 'notes' }] },
    });

    expect(within(container).getByRole('status').textContent)
      .toContain('Discovery failed: Home directory unavailable.');
    expect(container.textContent).not.toContain('not found on this computer');
    expect((within(container).getByRole('checkbox', {
      name: /MCP server: notes.*not checked yet/,
    }) as HTMLInputElement).checked).toBe(true);
    expect(getCopilotHostResources(settings).selectedMcpServers).toEqual([{ configPath, name: 'notes' }]);
    expect(persistedSelections).toEqual([]);

    within(container).getByRole('button', { name: 'Discover resources' }).click();
    await discovered(container, /MCP server: notes personal stdio/);

    expect(within(container).getByRole('status').textContent).not.toContain('Discovery failed');
    expect(persistedSelections).toEqual([]);
  });

  it('selects a discovered server as a reference, without its definition', async () => {
    write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: '/usr/bin/notes-mcp', env: { TOKEN: 'private' } } },
    }));
    const { commandLoader, container, settings } = renderSection();
    const fingerprint = commandLoader.getCacheFingerprint(settings);

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

  it('enables repository skills by default but not personal skills or MCP servers', async () => {
    write('vault/.github/skills/review/SKILL.md', '---\nname: review\n---\n');
    write('vault/notes/.agents/skills/organize/SKILL.md', '---\nname: organize\n---\n');
    write('home/.copilot/skills/personal/SKILL.md', '---\nname: personal\n---\n');
    write('vault/notes/.mcp.json', JSON.stringify({
      mcpServers: { notes: { command: 'notes-mcp' } },
    }));
    const { container, persistedSelections, settings } = renderSection({
      vaultDirectory: path.join(workspace, 'vault', 'notes'),
    });

    expect((await discovered(container, /Skill: review/)).checked).toBe(true);
    expect((await discovered(container, /Skill: organize/)).checked).toBe(true);
    expect((await discovered(container, /Skill: personal/)).checked).toBe(false);
    expect((await discovered(container, /MCP server: notes/)).checked).toBe(false);
    expect(within(container).getByRole('checkbox', {
      name: /Skill: review.*repository skill.*enabled by default/,
    })).toBeTruthy();
    expect(getCopilotHostResources(settings)).toMatchObject({
      selectedMcpServers: [],
      selectedSkillPaths: [],
    });
    expect(persistedSelections).toEqual([]);
  });

  it.each([false, true])('persists repository opt-outs and re-enables without explicit selection (selected: %s)', async (selected) => {
    const skillPath = write('vault/.github/skills/review/SKILL.md', '---\nname: review\n---\n');
    const { container, settings } = renderSection({
      resources: { selectedSkillPaths: selected ? [skillPath] : [] },
    });
    const checkbox = await discovered(container, /Skill: review.*repository skill/);
    expect(checkbox.checked).toBe(true);

    checkbox.click();
    await settle();

    expect(checkbox.checked).toBe(false);
    expect(getCopilotHostResources(settings)).toMatchObject({
      selectedSkillPaths: [],
      disabledRepositorySkillPaths: [skillPath],
    });
    const reopened = renderSection({ settings: JSON.parse(JSON.stringify(settings)) });
    const reopenedCheckbox = await discovered(reopened.container, /Skill: review.*repository skill/);
    expect(reopenedCheckbox.checked).toBe(false);

    reopenedCheckbox.click();
    await settle();

    expect(reopenedCheckbox.checked).toBe(true);
    expect(getCopilotHostResources(reopened.settings).selectedSkillPaths).toEqual([]);
    expect(getCopilotHostResources(reopened.settings)).not.toHaveProperty('disabledRepositorySkillPaths');
  });

  it('honors a saved repository opt-out over an explicit selection without rewriting settings', async () => {
    const skillPath = write('vault/.github/skills/review/SKILL.md', '---\nname: review\n---\n');
    const { container, persistedSelections, settings } = renderSection({
      resources: {
        disabledRepositorySkillPaths: [skillPath],
        selectedSkillPaths: [skillPath],
      },
    });

    expect((await discovered(container, /Skill: review.*repository skill/)).checked).toBe(false);
    expect(getCopilotHostResources(settings)).toMatchObject({
      disabledRepositorySkillPaths: [skillPath],
      selectedSkillPaths: [skillPath],
    });
    expect(persistedSelections).toEqual([]);
  });

  it('refreshes native command metadata without changing the selected skill', async () => {
    const skillPath = write('home/.copilot/skills/review/SKILL.md', '---\nname: review\n---\n');
    const { commandLoader, container, settings } = renderSection();
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
    const notes = await discovered(container, /MCP server: notes/);
    const wiki = await discovered(container, /MCP server: wiki/);

    notes.click();
    wiki.click();
    await settle();

    expect(getCopilotHostResources(settings).selectedMcpServers.map(ref => ref.name))
      .toEqual(['notes', 'wiki']);
  });

  it('keeps the focused resource row and scroll position while saving a selection', async () => {
    write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: 'notes-mcp' }, wiki: { command: 'wiki-mcp' } },
    }));
    const { container } = renderSection();
    const checkbox = await discovered(container, /MCP server: wiki/);
    const list = checkbox.closest('.claudian-copilot-resources-list') as HTMLElement;
    list.scrollTop = 240;
    checkbox.focus();
    checkbox.click();
    await settle();

    expect(within(container).getByRole('checkbox', { name: /MCP server: wiki/ })).toBe(checkbox);
    expect(document.activeElement).toBe(checkbox);
    expect(list.scrollTop).toBe(240);
    expect(checkbox.checked).toBe(true);
  });

  it.each([
    ['All', '', 'all resources'],
    ['MCP servers', '', 'all MCP servers'],
    ['Skills', '', 'all skills'],
    ['All', 'review', 'search results'],
    ['MCP servers', 'review', 'search results'],
    ['Skills', 'review', 'search results'],
  ])('names bulk actions for %s with search "%s"', async (kind, search, scope) => {
    write('home/.copilot/skills/review/SKILL.md', '---\nname: review\n---\n');
    const { container, persistedSelections } = renderSection();
    await discovered(container, /Skill: review/);
    within(within(container).getByRole('group', { name: 'Filter resource type' }))
      .getByRole('button', { name: kind }).click();
    const input = within(container).getByRole('searchbox', { name: 'Filter resources' }) as HTMLInputElement;
    input.value = search;
    input.dispatchEvent(new Event('input'));

    expect(within(container).getByRole('button', { name: `Enable ${scope}` })).toBeTruthy();
    expect(within(container).getByRole('button', { name: `Disable ${scope}` })).toBeTruthy();
    expect(persistedSelections).toEqual([]);
  });

  it('enables all discovered resources in one settings snapshot without copying definitions', async () => {
    const configPath = write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: {
        notes: { command: 'notes-mcp', env: { TOKEN: 'synthetic-private-value' } },
        wiki: { command: 'wiki-mcp' },
      },
    }));
    const skillPath = write('home/.copilot/skills/review/SKILL.md', '---\nname: review\n---\n');
    const { container, persistedSelections, settings } = renderSection();
    await discovered(container, /Skill: review/);

    within(container).getByRole('button', { name: 'Enable all resources' }).click();
    await settle();

    expect(getCopilotHostResources(settings)).toMatchObject({
      selectedMcpServers: [{ configPath, name: 'notes' }, { configPath, name: 'wiki' }],
      selectedSkillPaths: [skillPath],
    });
    expect(persistedSelections).toEqual([expect.objectContaining({
      selectedMcpServers: [{ configPath, name: 'notes' }, { configPath, name: 'wiki' }],
      selectedSkillPaths: [skillPath],
    })]);
    expect(JSON.stringify(settings)).not.toContain('synthetic-private-value');
    expect(resourceCheckboxes(container).every(
      element => (element as HTMLInputElement).checked,
    )).toBe(true);
  });

  it('enables matching resources without changing selections outside the filter', async () => {
    write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: 'notes-mcp' }, wiki: { command: 'wiki-mcp' } },
    }));
    const { container, settings } = renderSection();
    (await discovered(container, /MCP server: notes/)).click();
    await settle();
    const filter = within(container).getByRole('searchbox', { name: 'Filter resources' }) as HTMLInputElement;
    filter.value = 'wiki';
    filter.dispatchEvent(new Event('input'));
    within(container).getByRole('button', { name: 'Enable search results' }).click();
    await settle();

    expect(getCopilotHostResources(settings).selectedMcpServers.map(ref => ref.name))
      .toEqual(['notes', 'wiki']);
  });

  it('disables matching resources and preserves the other selections', async () => {
    write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: 'notes-mcp' }, wiki: { command: 'wiki-mcp' } },
    }));
    const { container, settings } = renderSection();
    await discovered(container, /MCP server: wiki/);
    within(container).getByRole('button', { name: 'Enable all resources' }).click();
    await settle();
    const filter = within(container).getByRole('searchbox', { name: 'Filter resources' }) as HTMLInputElement;
    filter.value = 'wiki';
    filter.dispatchEvent(new Event('input'));
    within(container).getByRole('button', { name: 'Disable search results' }).click();
    await settle();

    expect(getCopilotHostResources(settings).selectedMcpServers.map(ref => ref.name)).toEqual(['notes']);
  });

  it('intersects kind and text filters while bulk actions preserve hidden choices', async () => {
    const configPath = write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: 'notes-mcp' }, wiki: { command: 'wiki-mcp' } },
    }));
    const reviewPath = write('home/.copilot/skills/review/SKILL.md',
      '---\nname: review\ndescription: Review notes\n---\n');
    const draftPath = write('home/.copilot/skills/draft/SKILL.md', '---\nname: draft\n---\n');
    const { container, settings } = renderSection({
      resources: {
        selectedMcpServers: [{ configPath, name: 'wiki' }],
        selectedSkillPaths: [draftPath],
      },
    });
    await discovered(container, /Skill: review/);
    const kinds = within(within(container).getByRole('group', { name: 'Filter resource type' }));
    const mcpFilter = kinds.getByRole('button', { name: 'MCP servers' });
    const skillFilter = kinds.getByRole('button', { name: 'Skills' });
    mcpFilter.click();

    expect(resourceCheckboxes(container)).toHaveLength(2);
    expect(within(container).getByRole('button', { name: 'Enable all MCP servers' })).toBeTruthy();
    const filter = within(container).getByRole('searchbox', { name: 'Filter resources' }) as HTMLInputElement;
    filter.value = 'notes';
    filter.dispatchEvent(new Event('input'));
    expect(resourceCheckboxes(container)).toEqual([
      within(container).getByRole('checkbox', { name: /MCP server: notes/ }),
    ]);

    within(container).getByRole('button', { name: 'Enable search results' }).click();
    await settle();
    expect(getCopilotHostResources(settings)).toMatchObject({
      selectedMcpServers: [{ configPath, name: 'wiki' }, { configPath, name: 'notes' }],
      selectedSkillPaths: [draftPath],
    });

    skillFilter.click();
    expect(resourceCheckboxes(container)).toEqual([
      within(container).getByRole('checkbox', { name: /Skill: review/ }),
    ]);
    within(container).getByRole('button', { name: 'Enable search results' }).click();
    await settle();
    expect(getCopilotHostResources(settings)).toMatchObject({
      selectedMcpServers: [{ configPath, name: 'wiki' }, { configPath, name: 'notes' }],
      selectedSkillPaths: [draftPath, reviewPath],
    });
    within(container).getByRole('button', { name: 'Disable search results' }).click();
    await settle();
    mcpFilter.click();
    within(container).getByRole('button', { name: 'Disable search results' }).click();
    await settle();

    expect(getCopilotHostResources(settings)).toMatchObject({
      selectedMcpServers: [{ configPath, name: 'wiki' }],
      selectedSkillPaths: [draftPath],
    });
  });

  it('bulk-updates visible repository opt-outs without changing hidden defaults or opt-outs', async () => {
    const repositoryPath = write('vault/.github/skills/review/SKILL.md', '---\nname: review\n---\n');
    const disabledPath = write('vault/.github/skills/draft/SKILL.md', '---\nname: draft\n---\n');
    write('vault/.github/skills/organize/SKILL.md', '---\nname: organize\n---\n');
    const personalPath = write('home/.copilot/skills/review-personal/SKILL.md',
      '---\nname: review-personal\n---\n');
    const configPath = write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { review: { command: 'review-mcp' } },
    }));
    const { container, settings } = renderSection({
      resources: {
        disabledRepositorySkillPaths: [disabledPath],
        selectedMcpServers: [{ configPath, name: 'review' }],
        selectedSkillPaths: [repositoryPath, personalPath],
      },
    });
    await discovered(container, /Skill: review repository skill/);
    const kinds = within(within(container).getByRole('group', { name: 'Filter resource type' }));
    kinds.getByRole('button', { name: 'Skills' }).click();
    const filter = within(container).getByRole('searchbox', { name: 'Filter resources' }) as HTMLInputElement;
    filter.value = 'review';
    filter.dispatchEvent(new Event('input'));
    expect(resourceCheckboxes(container)).toHaveLength(2);

    within(container).getByRole('button', { name: 'Disable search results' }).click();
    await settle();

    expect(getCopilotHostResources(settings)).toMatchObject({
      disabledRepositorySkillPaths: [disabledPath, repositoryPath],
      selectedMcpServers: [{ configPath, name: 'review' }],
      selectedSkillPaths: [],
    });
    expect(resourceCheckboxes(container).every(element => !(element as HTMLInputElement).checked))
      .toBe(true);

    within(container).getByRole('button', { name: 'Enable search results' }).click();
    await settle();

    expect(getCopilotHostResources(settings)).toMatchObject({
      disabledRepositorySkillPaths: [disabledPath],
      selectedMcpServers: [{ configPath, name: 'review' }],
      selectedSkillPaths: [personalPath],
    });
    expect(resourceCheckboxes(container).every(element => (element as HTMLInputElement).checked))
      .toBe(true);
    filter.value = '';
    filter.dispatchEvent(new Event('input'));
    expect((within(container).getByRole('checkbox', { name: /Skill: draft/ }) as HTMLInputElement).checked)
      .toBe(false);
    expect((within(container).getByRole('checkbox', { name: /Skill: organize/ }) as HTMLInputElement).checked)
      .toBe(true);
  });

  it('does not choose between conflicting sources when enabling all', async () => {
    write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: 'personal-notes' } },
    }));
    write('vault/.mcp.json', JSON.stringify({
      mcpServers: { notes: { command: 'vault-notes' }, wiki: { command: 'wiki-mcp' } },
    }));
    const { container, settings } = renderSection();
    await discovered(container, /MCP server: wiki/);
    within(container).getByRole('button', { name: 'Enable all resources' }).click();
    await settle();

    expect(getCopilotHostResources(settings).selectedMcpServers.map(ref => ref.name)).toEqual(['wiki']);
    expect(within(container).getByRole('status').textContent).toContain('conflicting sources');
  });

  it('does not bulk-enable a competing skill source hidden by the filters', async () => {
    write('vault/.github/skills/review/SKILL.md', '---\nname: review\n---\n');
    write('home/.copilot/skills/review/SKILL.md', '---\nname: review\n---\n');
    const { container, settings } = renderSection();
    const repositorySkill = await discovered(container, /Skill: review.*repository skill/);
    expect(repositorySkill.checked).toBe(true);
    within(within(container).getByRole('group', { name: 'Filter resource type' }))
      .getByRole('button', { name: 'Skills' }).click();
    const filter = within(container).getByRole('searchbox', { name: 'Filter resources' }) as HTMLInputElement;
    filter.value = 'personal';
    filter.dispatchEvent(new Event('input'));
    const personalSkill = within(container).getByRole('checkbox', {
      name: /Skill: review.*personal skill/,
    }) as HTMLInputElement;
    expect(resourceCheckboxes(container)).toEqual([personalSkill]);

    within(container).getByRole('button', { name: 'Enable search results' }).click();
    await settle();

    expect(personalSkill.checked).toBe(false);
    expect(getCopilotHostResources(settings).selectedSkillPaths).toEqual([]);
    expect(within(container).getByRole('status').textContent).toContain('conflicting sources');
  });

  it('does not enable a conflicting source when an existing selection is temporarily missing', async () => {
    const configPath = write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: 'personal-notes' } },
    }));
    const { container, settings } = renderSection();
    (await discovered(container, /MCP server: notes/)).click();
    await settle();
    rmSync(configPath);
    write('vault/.mcp.json', JSON.stringify({
      mcpServers: { notes: { command: 'vault-notes' } },
    }));
    within(container).getByRole('button', { name: 'Refresh resources' }).click();
    await waitFor(() => {
      expect(container.textContent).toContain('not found on this computer');
    });

    within(container).getByRole('button', { name: 'Enable all resources' }).click();
    await settle();

    expect(getCopilotHostResources(settings).selectedMcpServers).toEqual([{ configPath, name: 'notes' }]);
    expect(within(container).getByRole('status').textContent).toContain('conflicting sources');
  });

  it('reports a failed save and restores the actual selection', async () => {
    write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: 'notes-mcp' } },
    }));
    const { container, settings } = renderSection({
      persistenceError: new Error('Settings storage unavailable.'),
    });
    (await discovered(container, /MCP server: notes/)).click();
    await settle();

    expect(within(container).getByRole('status').textContent)
      .toContain('Settings storage unavailable.');
    expect(getCopilotHostResources(settings).selectedMcpServers).toEqual([]);
    expect((within(container).getByRole('checkbox', {
      name: /MCP server: notes/,
    }) as HTMLInputElement).checked).toBe(false);
  });

  it('restores the automatic repository selection when saving an opt-out fails', async () => {
    write('vault/.github/skills/review/SKILL.md', '---\nname: review\n---\n');
    const { container, settings } = renderSection({
      persistenceError: new Error('Settings storage unavailable.'),
    });
    const checkbox = await discovered(container, /Skill: review.*repository skill/);
    checkbox.click();
    await settle();

    expect(checkbox.checked).toBe(true);
    expect(getCopilotHostResources(settings).selectedSkillPaths).toEqual([]);
    expect(getCopilotHostResources(settings)).not.toHaveProperty('disabledRepositorySkillPaths');
    expect(within(container).getByRole('status').textContent).toContain('Settings storage unavailable.');
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

    await discovered(container, /Skill: review/);
    expect(resourceCheckboxes(container)).toHaveLength(2);

    const filter = within(container)
      .getByRole('searchbox', { name: 'Filter resources' }) as HTMLInputElement;
    filter.value = 'review';
    filter.dispatchEvent(new Event('input'));

    const remaining = resourceCheckboxes(container);
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

    await discovered(container, /Skill: review/);

    expect(container.textContent).toContain('mcp-config.json');
  });

  it('does not replace unchanged resource text when one skill is toggled', async () => {
    const skillPath = write('home/.copilot/skills/review/SKILL.md', '---\nname: review\ndescription: Review notes\n---\n');
    write('home/.copilot/skills/another/SKILL.md', '---\nname: another\ndescription: Another skill\n---\n');
    const { container, settings } = renderSection();
    const skill = await discovered(container, /Skill: review/);
    const textElements = Array.from(container.querySelectorAll(
      '.claudian-copilot-resources-row-name, .claudian-copilot-resources-row-detail',
    ));
    const originalTextNodes = textElements.map(element => element.firstChild);

    skill.click();
    await settle();

    expect(getCopilotHostResources(settings).selectedSkillPaths).toEqual([skillPath]);
    for (const [index, element] of textElements.entries()) {
      expect(element.firstChild).toBe(originalTextNodes[index]);
    }
  });

  it('offers accessible native pressed kind filters and restores the unfiltered actions', async () => {
    write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: 'notes-mcp' } },
    }));
    write('home/.copilot/skills/review/SKILL.md', '---\nname: review\n---\n');
    const { container } = renderSection();
    await discovered(container, /Skill: review/);
    const group = within(container).getByRole('group', { name: 'Filter resource type' });
    const all = within(group).getByRole('button', { name: 'All' }) as HTMLButtonElement;
    const servers = within(group).getByRole('button', { name: 'MCP servers' }) as HTMLButtonElement;
    const skills = within(group).getByRole('button', { name: 'Skills' }) as HTMLButtonElement;
    expect([all.type, servers.type, skills.type]).toEqual(['button', 'button', 'button']);
    expect([all, servers, skills].map(button => button.getAttribute('aria-pressed')))
      .toEqual(['true', 'false', 'false']);

    skills.focus();
    skills.click();
    expect(document.activeElement).toBe(skills);
    expect([all, servers, skills].map(button => button.getAttribute('aria-pressed')))
      .toEqual(['false', 'false', 'true']);
    expect(resourceCheckboxes(container)).toEqual([
      within(container).getByRole('checkbox', { name: /Skill: review/ }),
    ]);
    expect(within(container).getByRole('button', { name: 'Disable all skills' })).toBeTruthy();
    expect(await checkAccessibility(group)).toHaveNoViolations();

    all.click();
    expect([all, servers, skills].map(button => button.getAttribute('aria-pressed')))
      .toEqual(['true', 'false', 'false']);
    expect(resourceCheckboxes(container)).toHaveLength(2);
    expect(within(container).getByRole('button', { name: 'Enable all resources' })).toBeTruthy();
    expect(within(container).getByRole('button', { name: 'Disable all resources' })).toBeTruthy();
  });

  it('has no accessibility violations once resources are listed', async () => {
    write('home/.copilot/skills/review/SKILL.md', '---\nname: review\n---\n');
    const { container } = renderSection();

    await discovered(container, /Skill: review/);

    expect(await checkAccessibility(container)).toHaveNoViolations();
  });
});
