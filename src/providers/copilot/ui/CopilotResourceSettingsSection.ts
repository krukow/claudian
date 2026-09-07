import * as os from 'node:os';

import { Setting } from 'obsidian';

import type { ProviderSettingsTabRendererContext } from '../../../core/providers/types';
import type { ClaudianSettings } from '../../../core/types';
import { getVaultPath } from '../../../utils/path';
import { getCopilotWorkspaceServices } from '../app/CopilotWorkspaceServices';
import {
  getCopilotHostResources,
  updateCopilotHostResources,
} from '../resources/CopilotHostResources';
import {
  type CopilotDiscoveredMcpServer,
  type CopilotResourceInventory,
  discoverCopilotResources,
} from '../resources/CopilotResourceInventory';
import type { CopilotResourceSettings } from '../resources/CopilotResourceSettings';
import { updateCopilotProviderSettings } from '../settings';

const COPILOT_PROVIDER_ID = 'copilot' as const;

const RESOURCES_DESCRIPTION = 'MCP servers and skills this computer offers, for the chat '
  + 'in this vault. Nothing is selected until you select it, and a selection stays on '
  + 'this computer: Claudian stores the file a server is declared in and its name, never '
  + 'the definition, so a synced vault carries no commands, environment entries, or '
  + 'headers. Selections apply to chat only — the title, inline edit, and instruction '
  + 'runs never start a server or load a skill.';

interface ResourceRow {
  readonly detail: string;
  readonly label: string;
  readonly missing: boolean;
  readonly selected: boolean;
  toggle(next: boolean): Promise<void>;
}

type ResourceMutation = (current: CopilotResourceSettings) => Partial<CopilotResourceSettings>;

/**
 * The Copilot resource surface: discover what this computer offers, then choose from it.
 *
 * Discovery reads the user's own configuration files and skill folders and reports what
 * it found. A discovery that fails, or one that no longer lists something already
 * selected, never edits the selection: the choice is the user's, and a file that is
 * temporarily unreadable is a fault to fix rather than a reason to silently switch a
 * server off.
 */
export function renderCopilotResourceSettings(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
): void {
  const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
  let inventory: CopilotResourceInventory | null = null;
  let discoveryFailure: string | null = null;
  let saveFailure: string | null = null;
  let discovering = false;
  let filter = '';

  new Setting(container).setName('Resources').setHeading();
  container.createEl('p', {
    cls: 'setting-item-description',
    text: RESOURCES_DESCRIPTION,
  });

  const persist = async (mutate: ResourceMutation): Promise<void> => {
    try {
      await context.plugin.applyProviderRuntimeSettings(
        [COPILOT_PROVIDER_ID],
        (settings: ClaudianSettings) => {
          const bag = settings as unknown as Record<string, unknown>;
          updateCopilotProviderSettings(bag, {
            resourcesByHost: updateCopilotHostResources(bag, mutate(getCopilotHostResources(bag))),
          });
        },
        () => {
          getCopilotWorkspaceServices().commandLoader.requestRefresh();
        },
      );
      saveFailure = null;
    } catch (error) {
      saveFailure = error instanceof Error ? error.message : String(error);
    }
    renderStatus();
    renderList();
  };

  renderPathListSetting({
    container,
    description: 'Absolute paths to MCP configuration files outside the standard '
      + 'locations, one per line. Use this for a configuration Claudian would not '
      + 'otherwise look at.',
    getValue: () => getCopilotHostResources(settingsBag).additionalMcpConfigPaths,
    name: 'Additional MCP configuration files',
    onChange: async paths => persist(() => ({ additionalMcpConfigPaths: paths })),
    placeholder: '/Users/you/private/mcp-config.json',
  });

  renderPathListSetting({
    container,
    description: 'Absolute paths to skill folders outside the standard locations, one per '
      + 'line. A path may be a folder of skills or one skill folder containing SKILL.md.',
    getValue: () => getCopilotHostResources(settingsBag).additionalSkillRoots,
    name: 'Additional skill folders',
    onChange: async roots => persist(() => ({ additionalSkillRoots: roots })),
    placeholder: '/Users/you/private/skills',
  });

  const controlsEl = container.createDiv({ cls: 'claudian-copilot-resources-controls' });
  const discoverButton = controlsEl.createEl('button', {
    cls: 'claudian-copilot-resources-action',
    text: 'Discover',
  });
  discoverButton.setAttribute('type', 'button');
  discoverButton.setAttribute('aria-label', 'Discover resources');

  const filterInput = controlsEl.createEl('input', {
    cls: 'claudian-copilot-resources-filter',
  });
  filterInput.type = 'search';
  filterInput.setAttribute('aria-label', 'Filter resources');
  filterInput.placeholder = 'Filter by name, source, or path...';
  filterInput.addEventListener('input', () => {
    filter = filterInput.value.trim().toLowerCase();
    renderList();
  });

  const statusEl = container.createDiv({ cls: 'claudian-copilot-resources-status' });
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.setAttribute('role', 'status');
  const listEl = container.createDiv({ cls: 'claudian-copilot-resources-list' });
  const problemsEl = container.createDiv({ cls: 'claudian-copilot-resources-problems' });

  const discover = async (): Promise<void> => {
    const refreshing = inventory !== null;
    discovering = true;
    discoveryFailure = null;
    renderStatus();
    try {
      const selection = getCopilotHostResources(settingsBag);
      inventory = await discoverCopilotResources({
        additionalMcpConfigPaths: selection.additionalMcpConfigPaths,
        additionalSkillRoots: selection.additionalSkillRoots,
        homeDirectory: os.homedir(),
        vaultDirectory: getVaultPath(context.plugin.app) ?? '',
      });
      if (refreshing) {
        await persist(() => ({}));
      }
    } catch (error) {
      discoveryFailure = error instanceof Error ? error.message : String(error);
    } finally {
      discovering = false;
      renderStatus();
      renderList();
    }
  };

  discoverButton.addEventListener('click', () => {
    void discover();
  });

  function renderStatus(): void {
    discoverButton.disabled = discovering;
    const action = discovering ? 'Discovering...' : inventory ? 'Refresh' : 'Discover';
    discoverButton.setText(action);
    discoverButton.setAttribute(
      'aria-label',
      `${discovering ? 'Discovering' : action} resources`,
    );
    statusEl.setText(
      saveFailure
        ? `Could not save resource settings: ${saveFailure}`
        : discovering
        ? 'Reading this computer\'s MCP configurations and skill folders...'
        : discoveryFailure
        ? `Discovery failed: ${discoveryFailure}. Your selections are unchanged.`
        : inventory
        ? `${inventory.mcpServers.length} MCP ${plural(inventory.mcpServers.length, 'server')}`
          + ` and ${inventory.skills.length} ${plural(inventory.skills.length, 'skill')} found.`
        : 'Select Discover to see what this computer offers.',
    );
  }

  function renderList(): void {
    listEl.empty();
    problemsEl.empty();
    const rows = buildRows(getCopilotHostResources(settingsBag), inventory, persist)
      .filter(row => matchesFilter(row, filter));
    if (rows.length === 0) {
      listEl.createDiv({
        cls: 'claudian-copilot-resources-empty',
        text: inventory
          ? 'Nothing matches this filter.'
          : 'Nothing discovered yet.',
      });
    }
    for (const row of rows) {
      renderRow(listEl, row, async (next) => {
        await row.toggle(next);
        renderList();
      });
    }
    for (const problem of inventory?.problems ?? []) {
      problemsEl.createDiv({
        cls: 'claudian-copilot-resources-problem',
        text: problem,
      });
    }
  }

  renderStatus();
  renderList();
}

function renderRow(
  listEl: HTMLElement,
  row: ResourceRow,
  onToggle: (next: boolean) => Promise<void>,
): void {
  const rowEl = listEl.createEl('label', { cls: 'claudian-copilot-resources-row' });
  const checkboxEl = rowEl.createEl('input');
  checkboxEl.type = 'checkbox';
  checkboxEl.checked = row.selected;
  checkboxEl.addEventListener('change', () => {
    void onToggle(checkboxEl.checked);
  });
  const textEl = rowEl.createDiv({ cls: 'claudian-copilot-resources-row-text' });
  textEl.createDiv({
    cls: 'claudian-copilot-resources-row-name',
    text: row.label,
  });
  textEl.createDiv({
    cls: 'claudian-copilot-resources-row-detail',
    text: row.missing ? `${row.detail} — not found on this computer` : row.detail,
  });
}

/**
 * Every row the user can act on: what discovery found, plus anything already selected
 * that it did not find. The second group is what keeps a failed or partial discovery from
 * quietly unselecting a resource.
 */
function buildRows(
  selection: CopilotResourceSettings,
  inventory: CopilotResourceInventory | null,
  persist: (mutate: ResourceMutation) => Promise<void>,
): ResourceRow[] {
  const rows: ResourceRow[] = [];
  const selectedServers = new Set(
    selection.selectedMcpServers.map(reference => serverId(reference.configPath, reference.name)),
  );
  const selectedSkills = new Set(selection.selectedSkillPaths);

  const toggleServer = async (
    reference: { configPath: string; name: string },
    next: boolean,
  ): Promise<void> => {
    await persist((current) => {
      const remaining = current.selectedMcpServers.filter(entry => (
        serverId(entry.configPath, entry.name) !== serverId(reference.configPath, reference.name)
      ));
      return { selectedMcpServers: next ? [...remaining, reference] : remaining };
    });
  };
  const toggleSkill = async (skillPath: string, next: boolean): Promise<void> => {
    await persist((current) => {
      const remaining = current.selectedSkillPaths.filter(entry => entry !== skillPath);
      return { selectedSkillPaths: next ? [...remaining, skillPath] : remaining };
    });
  };

  for (const server of inventory?.mcpServers ?? []) {
    const id = serverId(server.configPath, server.name);
    selectedServers.delete(id);
    rows.push({
      detail: describeServer(server),
      label: `MCP server: ${server.name}`,
      missing: false,
      selected: selection.selectedMcpServers.some(entry => (
        serverId(entry.configPath, entry.name) === id
      )),
      toggle: next => toggleServer({ configPath: server.configPath, name: server.name }, next),
    });
  }
  for (const reference of selection.selectedMcpServers) {
    const id = serverId(reference.configPath, reference.name);
    if (!selectedServers.has(id)) {
      continue;
    }
    rows.push({
      detail: reference.configPath,
      label: `MCP server: ${reference.name}`,
      missing: true,
      selected: true,
      toggle: next => toggleServer(reference, next),
    });
  }

  for (const skill of inventory?.skills ?? []) {
    selectedSkills.delete(skill.path);
    rows.push({
      detail: `${skill.scope} skill | ${skill.path}${
        skill.description ? ` | ${skill.description}` : ''
      }`,
      label: `Skill: ${skill.commandName}`,
      missing: false,
      selected: selection.selectedSkillPaths.includes(skill.path),
      toggle: next => toggleSkill(skill.path, next),
    });
  }
  for (const skillPath of selection.selectedSkillPaths) {
    if (!selectedSkills.has(skillPath)) {
      continue;
    }
    rows.push({
      detail: skillPath,
      label: `Skill: ${skillPath.split(/[\\/]/).at(-2) ?? skillPath}`,
      missing: true,
      selected: true,
      toggle: next => toggleSkill(skillPath, next),
    });
  }
  return rows;
}

function describeServer(server: CopilotDiscoveredMcpServer): string {
  const restriction = server.toolRestriction
    ? ` | tools: ${server.toolRestriction.join(', ') || 'none'}`
    : '';
  return `${server.scope} ${server.transport} | ${server.configPath}${restriction}`;
}

function matchesFilter(row: ResourceRow, filter: string): boolean {
  if (!filter) {
    return true;
  }
  return `${row.label} ${row.detail}`.toLowerCase().includes(filter);
}

function serverId(configPath: string, name: string): string {
  return `${configPath}::${name}`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

interface PathListSettingOptions {
  readonly container: HTMLElement;
  readonly description: string;
  readonly getValue: () => readonly string[];
  readonly name: string;
  readonly onChange: (paths: string[]) => Promise<void>;
  readonly placeholder: string;
}

function renderPathListSetting(options: PathListSettingOptions): void {
  new Setting(options.container)
    .setName(options.name)
    .setDesc(options.description)
    .addTextArea((text) => {
      text.setPlaceholder(options.placeholder);
      text.inputEl.setAttribute('aria-label', options.name);
      text.setValue(options.getValue().join('\n'));
      text.onChange((value) => {
        void options.onChange(value.split('\n').map(entry => entry.trim()).filter(Boolean));
      });
    });
}
