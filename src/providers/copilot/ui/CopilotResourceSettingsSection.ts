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
import {
  type CopilotMcpServerReference,
  type CopilotResourceSettings,
  getEnabledCopilotSkillPaths,
} from '../resources/CopilotResourceSettings';
import { updateCopilotProviderSettings } from '../settings';
import { CopilotMcpSignInModal } from './CopilotMcpSignInModal';

const COPILOT_PROVIDER_ID = 'copilot' as const;

const RESOURCES_DESCRIPTION = 'MCP servers and skills this computer offers, for the chat '
  + 'in this vault. Skills in the Git repository containing the vault are enabled by '
  + 'default; turn off individual skills below. Other skills and MCP servers are opt-in. '
  + 'Choices stay on this computer: Claudian stores the file a server is declared in and its name, never '
  + 'the definition, so a synced vault carries no commands, environment entries, or '
  + 'headers. Selections apply to chat only — the title, inline edit, and instruction '
  + 'runs never start a server or load a skill.';

interface ResourceRow {
  readonly detail: string;
  readonly label: string;
  readonly missing: boolean;
  readonly selected: boolean;
  readonly supportsSignIn: boolean;
  readonly reference:
    | { readonly kind: 'mcp'; readonly server: CopilotMcpServerReference }
    | { readonly kind: 'skill'; readonly path: string; readonly repository: boolean };
  toggle(next: boolean): Promise<void>;
}

interface RenderedResourceRow {
  readonly element: HTMLDivElement;
  readonly checkbox: HTMLInputElement;
  readonly name: HTMLElement;
  readonly detail: HTMLElement;
  signIn: HTMLButtonElement | null;
  row: ResourceRow;
}

type ResourceMutation = (current: CopilotResourceSettings) => Partial<CopilotResourceSettings>;
type ResourceKindFilter = 'all' | ResourceRow['reference']['kind'];

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
  let kindFilter: ResourceKindFilter = 'all';
  let bulkStatus = '';
  let saving = 0;
  const renderedRows = new Map<string, RenderedResourceRow>();

  new Setting(container).setName('Resources').setHeading();
  container.createEl('p', {
    cls: 'setting-item-description',
    text: RESOURCES_DESCRIPTION,
  });

  const persist = async (mutate: ResourceMutation): Promise<void> => {
    saving += 1;
    renderStatus();
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
    } finally {
      saving -= 1;
    }
    renderList();
    renderStatus();
  };

  const rememberSetting = new Setting(container)
    .setName('Remember MCP sign-ins')
    .setDesc('Use the Copilot CLI credential cache on this computer. It normally uses the OS keychain; if that fails, it may store tokens in local files outside the vault. Required for sign-in from settings.');
  const remember = rememberSetting.controlEl.createEl('input');
  remember.type = 'checkbox';
  remember.setAttribute('aria-label', 'Remember MCP sign-ins');
  remember.addEventListener('change', () => {
    const selected = remember.checked;
    void persist(() => ({ rememberMcpSignIns: selected }));
  });

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

  const enableAllButton = controlsEl.createEl('button', {
    cls: 'claudian-copilot-resources-action', text: 'Enable all resources', attr: { type: 'button' },
  });
  const disableAllButton = controlsEl.createEl('button', {
    cls: 'claudian-copilot-resources-action', text: 'Disable all resources', attr: { type: 'button' },
  });
  enableAllButton.addEventListener('click', () => { void setAll(true); });
  disableAllButton.addEventListener('click', () => { void setAll(false); });

  const kindsEl = controlsEl.createDiv({
    cls: 'claudian-copilot-resources-kinds',
    attr: { role: 'group', 'aria-label': 'Filter resource type' },
  });
  const kindButtons = new Map<ResourceKindFilter, HTMLButtonElement>();
  for (const [kind, label] of [['all', 'All'], ['mcp', 'MCP servers'], ['skill', 'Skills']] as const) {
    const button = kindsEl.createEl('button', {
      cls: 'claudian-copilot-resources-action claudian-copilot-resources-kind',
      text: label,
      attr: { type: 'button', 'aria-pressed': String(kind === kindFilter) },
    });
    kindButtons.set(kind, button);
    button.addEventListener('click', () => {
      kindFilter = kind;
      bulkStatus = '';
      renderList();
      renderStatus();
    });
  }

  const filterInput = controlsEl.createEl('input', {
    cls: 'claudian-copilot-resources-filter',
  });
  filterInput.type = 'search';
  filterInput.setAttribute('aria-label', 'Filter resources');
  filterInput.placeholder = 'Filter by name, source, or path...';
  filterInput.addEventListener('input', () => {
    filter = filterInput.value.trim().toLowerCase();
    bulkStatus = '';
    renderList();
    renderStatus();
  });

  const statusEl = container.createDiv({ cls: 'claudian-copilot-resources-status' });
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.setAttribute('role', 'status');
  const listEl = container.createDiv({ cls: 'claudian-copilot-resources-list' });
  const problemsEl = container.createDiv({ cls: 'claudian-copilot-resources-problems' });

  const setAll = async (enabled: boolean): Promise<void> => {
    const rows = buildRows(getCopilotHostResources(settingsBag), inventory, persist);
    const nameCounts = new Map<string, number>();
    for (const row of rows) {
      const name = row.label.toLowerCase();
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    let skipped = 0;
    const targets = rows.filter(row => {
      if (!matchesFilter(row, filter, kindFilter)) return false;
      if (enabled && row.missing) return false;
      if (enabled && !row.selected && (nameCounts.get(row.label.toLowerCase()) ?? 0) > 1) {
        skipped += 1;
        return false;
      }
      return true;
    });
    bulkStatus = skipped > 0
      ? `Skipped ${skipped} resources with conflicting sources. Select a source individually.`
      : '';
    await persist(current => {
      const servers = new Map(current.selectedMcpServers.map(ref => [
        serverId(ref.configPath, ref.name), ref,
      ]));
      const skills = new Set(current.selectedSkillPaths);
      const disabledRepositorySkills = new Set(current.disabledRepositorySkillPaths);
      for (const { reference } of targets) {
        if (reference.kind === 'mcp') {
          const ref = reference.server;
          const id = serverId(ref.configPath, ref.name);
          if (enabled) servers.set(id, ref);
          else servers.delete(id);
        } else if (reference.repository) {
          skills.delete(reference.path);
          if (enabled) disabledRepositorySkills.delete(reference.path);
          else disabledRepositorySkills.add(reference.path);
        } else if (enabled) {
          skills.add(reference.path);
        } else {
          skills.delete(reference.path);
        }
      }
      return {
        selectedMcpServers: [...servers.values()],
        selectedSkillPaths: [...skills],
        disabledRepositorySkillPaths: [...disabledRepositorySkills],
      };
    });
  };

  const discover = async (): Promise<void> => {
    const refreshing = inventory !== null;
    discovering = true;
    discoveryFailure = null;
    bulkStatus = '';
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
      renderList();
      renderStatus();
    }
  };

  discoverButton.addEventListener('click', () => {
    void discover();
  });

  function renderStatus(): void {
    remember.checked = getCopilotHostResources(settingsBag).rememberMcpSignIns === true;
    remember.disabled = saving > 0;
    discoverButton.disabled = discovering || saving > 0;
    enableAllButton.disabled = discovering || saving > 0 || inventory === null;
    disableAllButton.disabled = discovering || saving > 0 || renderedRows.size === 0;
    const scope = filter
      ? 'search results'
      : kindFilter === 'skill'
      ? 'all skills'
      : kindFilter === 'mcp'
      ? 'all MCP servers'
      : 'all resources';
    enableAllButton.setText(`Enable ${scope}`);
    disableAllButton.setText(`Disable ${scope}`);
    for (const [kind, button] of kindButtons) {
      button.setAttribute('aria-pressed', String(kind === kindFilter));
    }
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
        : bulkStatus
        ? bulkStatus
        : inventory
        ? `${inventory.mcpServers.length} MCP ${plural(inventory.mcpServers.length, 'server')}`
          + ` and ${inventory.skills.length} ${plural(inventory.skills.length, 'skill')} found.`
        : 'Select Discover to see what this computer offers.',
    );
  }

  function renderList(): void {
    problemsEl.empty();
    const selection = getCopilotHostResources(settingsBag);
    const rows = buildRows(selection, inventory, persist)
      .filter(row => matchesFilter(row, filter, kindFilter));
    const ids = new Set(rows.map(resourceRowId));
    for (const [id, rendered] of renderedRows) {
      if (!ids.has(id)) {
        rendered.element.remove();
        renderedRows.delete(id);
      }
    }
    listEl.querySelector('.claudian-copilot-resources-empty')?.remove();
    if (rows.length === 0) {
      listEl.createDiv({
        cls: 'claudian-copilot-resources-empty',
        text: inventory
          ? 'Nothing matches this filter.'
          : 'Nothing discovered yet.',
      });
    }
    let previous: HTMLElement | null = null;
    for (const row of rows) {
      const id = resourceRowId(row);
      let rendered = renderedRows.get(id);
      if (!rendered) {
        rendered = renderRow(listEl, row);
        renderedRows.set(id, rendered);
      }
      rendered.row = row;
      rendered.checkbox.checked = row.selected;
      if (rendered.name.textContent !== row.label) rendered.name.setText(row.label);
      const detail = row.missing ? `${row.detail} — not found on this computer` : row.detail;
      if (rendered.detail.textContent !== detail) rendered.detail.setText(detail);
      if (row.supportsSignIn && row.reference.kind === 'mcp') {
        if (!rendered.signIn) {
          const reference = row.reference.server;
          rendered.signIn = rendered.element.createEl('button', {
            cls: 'claudian-copilot-resources-action',
            text: 'Sign in',
            attr: { type: 'button', 'aria-label': `Sign in to ${reference.name}` },
          });
          rendered.signIn.addEventListener('click', () => {
            new CopilotMcpSignInModal(context.plugin.app, getCopilotWorkspaceServices().mcpSignIn, reference).open();
          });
        }
        const disabled = !row.selected || row.missing || selection.rememberMcpSignIns !== true;
        if (rendered.signIn.disabled !== disabled) rendered.signIn.disabled = disabled;
        const title = disabled
          ? 'Select this server and enable Remember MCP sign-ins first.'
          : 'Authenticate this server in your browser.';
        if (rendered.signIn.title !== title) rendered.signIn.title = title;
      } else if (rendered.signIn) {
        rendered.signIn.remove();
        rendered.signIn = null;
      }
      const next: Element | null = previous ? previous.nextElementSibling : listEl.firstElementChild;
      if (next !== rendered.element) {
        listEl.insertBefore(rendered.element, next);
      }
      previous = rendered.element;
    }
    for (const problem of inventory?.problems ?? []) {
      problemsEl.createDiv({
        cls: 'claudian-copilot-resources-problem',
        text: problem,
      });
    }
  }

  renderList();
  void discover();
}

function renderRow(
  listEl: HTMLElement,
  row: ResourceRow,
): RenderedResourceRow {
  const rowEl = listEl.createDiv({ cls: 'claudian-copilot-resources-row' });
  const label = rowEl.createEl('label', { cls: 'claudian-copilot-resources-row-label' });
  const checkboxEl = label.createEl('input');
  checkboxEl.type = 'checkbox';
  checkboxEl.checked = row.selected;
  const textEl = label.createDiv({ cls: 'claudian-copilot-resources-row-text' });
  const name = textEl.createDiv({
    cls: 'claudian-copilot-resources-row-name',
    text: row.label,
  });
  const detail = textEl.createDiv({
    cls: 'claudian-copilot-resources-row-detail',
    text: row.missing ? `${row.detail} — not found on this computer` : row.detail,
  });
  const rendered: RenderedResourceRow = {
    element: rowEl, checkbox: checkboxEl, name, detail, signIn: null, row,
  };
  checkboxEl.addEventListener('change', () => {
    void rendered.row.toggle(checkboxEl.checked);
  });
  return rendered;
}

function resourceRowId(row: ResourceRow): string {
  return row.reference.kind === 'mcp'
    ? `mcp:${serverId(row.reference.server.configPath, row.reference.server.name)}`
    : `skill:${row.reference.path}`;
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
  const selectedSkills = new Set(getEnabledCopilotSkillPaths(
    selection,
    (inventory?.skills ?? []).filter(skill => skill.scope === 'repository').map(skill => skill.path),
  ));

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
  const toggleSkill = async (skillPath: string, next: boolean, repository = false): Promise<void> => {
    await persist((current) => {
      const remaining = current.selectedSkillPaths.filter(entry => entry !== skillPath);
      if (repository) {
        const disabled = new Set(current.disabledRepositorySkillPaths);
        if (next) disabled.delete(skillPath);
        else disabled.add(skillPath);
        return { selectedSkillPaths: remaining, disabledRepositorySkillPaths: [...disabled] };
      }
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
      supportsSignIn: server.transport === 'http' || server.transport === 'sse',
      reference: { kind: 'mcp', server: { configPath: server.configPath, name: server.name } },
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
      detail: inventory ? reference.configPath : `${reference.configPath} | not checked yet`,
      label: `MCP server: ${reference.name}`,
      missing: inventory !== null,
      supportsSignIn: false,
      reference: { kind: 'mcp', server: reference },
      selected: true,
      toggle: next => toggleServer(reference, next),
    });
  }

  for (const skill of inventory?.skills ?? []) {
    const selected = selectedSkills.delete(skill.path);
    const source = skill.scope === 'repository'
      ? 'repository skill (enabled by default)'
      : `${skill.scope} skill`;
    rows.push({
      detail: `${source} | ${skill.path}${
        skill.description ? ` | ${skill.description}` : ''
      }`,
      label: `Skill: ${skill.commandName}`,
      missing: false,
      supportsSignIn: false,
      reference: { kind: 'skill', path: skill.path, repository: skill.scope === 'repository' },
      selected,
      toggle: next => toggleSkill(skill.path, next, skill.scope === 'repository'),
    });
  }
  for (const skillPath of selection.selectedSkillPaths) {
    if (!selectedSkills.has(skillPath)) {
      continue;
    }
    rows.push({
      detail: inventory ? skillPath : `${skillPath} | not checked yet`,
      label: `Skill: ${skillPath.split(/[\\/]/).at(-2) ?? skillPath}`,
      missing: inventory !== null,
      supportsSignIn: false,
      reference: { kind: 'skill', path: skillPath, repository: false },
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

function matchesFilter(row: ResourceRow, filter: string, kind: ResourceKindFilter): boolean {
  if (kind !== 'all' && row.reference.kind !== kind) {
    return false;
  }
  return !filter || `${row.label} ${row.detail}`.toLowerCase().includes(filter);
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
