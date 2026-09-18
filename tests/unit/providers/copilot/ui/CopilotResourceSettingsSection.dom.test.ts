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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { waitFor, within } from '@testing-library/dom';
import { configureAxe } from 'jest-axe';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution/ProviderExecutionLifecycleRegistry';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderId, ProviderSettingsTabRendererContext } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';
import { CopilotCommandLoader } from '@/providers/copilot/app/CopilotCommandLoader';
import { CopilotCommandMetadataProbe } from '@/providers/copilot/app/CopilotCommandMetadataProbe';
import { CopilotMcpReadinessCoordinator } from '@/providers/copilot/app/CopilotMcpReadinessCoordinator';
import { CopilotMcpSignInCoordinator } from '@/providers/copilot/app/CopilotMcpSignInCoordinator';
import type { CopilotWorkspaceServices } from '@/providers/copilot/app/CopilotWorkspaceServices';
import {
  getCopilotHostResources,
  updateCopilotHostResources,
} from '@/providers/copilot/resources/CopilotHostResources';
import type { CopilotResourceSettings } from '@/providers/copilot/resources/CopilotResourceSettings';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';
import { renderCopilotResourceSettings } from '@/providers/copilot/ui/CopilotResourceSettingsSection';

import { createDeferred, FakeCopilotSdkClient, FakeCopilotSdkRuntime } from '../sdk/FakeCopilotSdkRuntime';

const checkAccessibility = configureAxe({ rules: { region: { enabled: false } } });

let workspace = '';
const cleanups: Array<() => Promise<void>> = [];

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
  beforeSettingsCommit?: () => Promise<void>;
  expectedSignInDisposalFailure?: string;
  persistenceError?: Error;
  resources?: Partial<CopilotResourceSettings>;
  settings?: Record<string, unknown>;
  vaultDirectory?: string;
  runtime?: FakeCopilotSdkRuntime;
} = {}): {
  container: HTMLElement;
  commandLoader: CopilotCommandLoader;
  persistedSelections: CopilotResourceSettings[];
  settings: Record<string, unknown>;
  dispose: () => void;
  mcpSignIn: CopilotMcpSignInCoordinator;
  registry: ProviderExecutionLifecycleRegistry;
} {
  const settings = options.settings ?? { providerConfigs: {} };
  updateCopilotProviderSettings(settings, {
    enabled: true,
    discoveredModels: [{
      rawId: 'gpt-5-mini', displayName: 'GPT-5 mini',
      reasoningEfforts: [], supportsReasoning: false, supportsVision: false,
    }],
    visibleModels: ['gpt-5-mini'],
  });
  if (options.resources) {
    updateCopilotProviderSettings(settings, {
      resourcesByHost: updateCopilotHostResources(settings, options.resources),
    });
  }
  const persistedSelections: CopilotResourceSettings[] = [];
  const registry = new ProviderExecutionLifecycleRegistry();
  const host = {
    executionLifecycleRegistry: registry,
    runProviderExecutionTransition: registry.runTransition.bind(registry),
    getResolvedProviderCliPath: async () => '/usr/bin/copilot',
    app: { vault: { adapter: { basePath: options.vaultDirectory ?? path.join(workspace, 'vault') } } },
    applyProviderRuntimeSettings: async (
      providerIds: ProviderId[],
      mutation: (value: ClaudianSettings) => void,
      onApplied?: () => void,
    ) => {
      await registry.runTransition(providerIds, async () => {
        await options.beforeSettingsCommit?.();
        if (options.persistenceError) {
          throw options.persistenceError;
        }
        mutation(settings as unknown as ClaudianSettings);
        persistedSelections.push(getCopilotHostResources(settings));
      });
      onApplied?.();
    },
    settings: settings as unknown as ClaudianSettings,
  } as unknown as ProviderHost;

  const commandLoader = new CopilotCommandLoader(new CopilotCommandMetadataProbe(host));
  const runtime = options.runtime ?? new FakeCopilotSdkRuntime();
  const mcpReadiness = new CopilotMcpReadinessCoordinator(host, { runtime });
  const mcpSignIn = new CopilotMcpSignInCoordinator(host, { runtime });
  ProviderWorkspaceRegistry.setServices('copilot', { commandLoader, mcpReadiness, mcpSignIn } as CopilotWorkspaceServices);

  const context = {
    notifyProviderModelOptionsChanged: () => {},
    plugin: host,
    renderAgentSkillSettings: () => {},
    renderCustomContextLimits: () => {},
    renderHiddenProviderCommandSetting: () => {},
  } as unknown as ProviderSettingsTabRendererContext;

  const container = document.body.appendChild(document.createElement('div'));
  const release = renderCopilotResourceSettings(container, context);
  const dispose = () => { if (typeof release === 'function') release(); };
  cleanups.push(async () => {
    dispose();
    await mcpReadiness.dispose();
    if (options.expectedSignInDisposalFailure) {
      await expect(mcpSignIn.dispose()).rejects.toThrow(options.expectedSignInDisposalFailure);
    } else {
      await mcpSignIn.dispose();
    }
  });
  return { commandLoader, container, persistedSelections, settings, dispose, mcpSignIn, registry };
}

async function settle(): Promise<void> {
  await waitFor(() => {
    for (const input of within(document.body).queryAllByRole('checkbox', { name: 'Remember MCP sign-ins' })) {
      expect((input as HTMLInputElement).disabled).toBe(false);
    }
    for (const button of within(document.body).queryAllByRole('button', { name: /^(Discover|Discovering|Refresh) resources$/ })) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    }
  });
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
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.replaceChildren();
  ProviderWorkspaceRegistry.setServices('copilot', undefined);
  rmSync(workspace, { force: true, recursive: true });
});

describe('Copilot resource settings', () => {
  it('keeps completed MCP checks across skill-only changes while explicit Refresh checks again', async () => {
    const configPath = write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: {
        notes: { type: 'http', url: 'https://notes.example.test/mcp' },
        wiki: { type: 'http', url: 'https://wiki.example.test/mcp' },
      },
    }));
    const skillPath = write('home/.copilot/skills/review/SKILL.md', '---\nname: review\n---\n');
    const runtime = new FakeCopilotSdkRuntime();
    const { container, settings } = renderSection({
      runtime,
      resources: { selectedMcpServers: ['notes', 'wiki'].map(name => ({ configPath, name })) },
    });
    await waitFor(() => expect(within(container).getAllByText('Connected (0 tools)')).toHaveLength(2));
    const initialClients = [...runtime.clients];
    const skill = within(container).getByRole('checkbox', { name: /Skill: review/ });
    for (const selected of [true, false]) {
      skill.click();
      await settle();
      await waitFor(() => expect(within(container).getAllByText('Connected (0 tools)')).toHaveLength(2));
      expect(getCopilotHostResources(settings).selectedSkillPaths).toEqual(selected ? [skillPath] : []);
      expect(runtime.clients).toEqual(initialClients);
    }

    within(container).getByRole('button', { name: 'Refresh resources' }).click();
    await settle();
    await waitFor(() => expect(within(container).getAllByText('Connected (0 tools)')).toHaveLength(2));
    expect(runtime.clients.flatMap(client => client.createdSessions.map(session => (
      Object.keys(session.config.resources?.mcpServers ?? {})
    )))).toEqual([['notes'], ['wiki'], ['notes'], ['wiki']]);
  });

  it('rechecks confirmed authentication even when the chat-runtime refresh fails', async () => {
    const configPath = write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp' } },
    }));
    let authenticated = false;
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      onSessionCreated: session => {
        session.mcpReadinessBehavior = async () => authenticated
          ? { phase: 'connected', toolCount: 1 } : { phase: 'needs-auth' };
        session.mcpSignInBehavior = async () => { authenticated = true; return {}; };
      },
    }));
    const reference = { configPath, name: 'notes' };
    const { container, mcpSignIn, registry } = renderSection({
      expectedSignInDisposalFailure: 'Existing chat runtime could not be refreshed.',
      runtime, resources: { selectedMcpServers: [reference], rememberMcpSignIns: true },
    });
    await waitFor(() => expect(within(container).getByText('Sign-in required')).toBeTruthy());
    registry.registerTransitionHook('copilot', {
      beforeTransition: () => { throw new Error('Existing chat runtime could not be refreshed.'); },
    });
    await mcpSignIn.signIn(reference);

    await waitFor(() => expect(within(container).getByText('Connected (1 tool)')).toBeTruthy());
    expect(mcpSignIn.getState(reference)).toEqual({
      phase: 'connected', warning: expect.stringContaining('Existing chat runtime could not be refreshed.'),
    });
    expect(within(container).queryByRole('button', { name: 'Sign in to notes' })).toBeNull();
  });

  it('reports failed probe quiescence instead of committing runtime settings, and permits retry', async () => {
    const configPath = write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp' } },
    }));
    const entered = createDeferred();
    const listing = createDeferred();
    let failStop = true;
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      onSessionCreated: session => {
        session.mcpReadinessBehavior = async () => {
          entered.resolve();
          await listing.promise;
          return { phase: 'needs-auth' };
        };
      },
      stopBehavior: async () => { if (failStop) throw new Error('The MCP probe could not be stopped.'); },
    }));
    const { container, settings } = renderSection({
      runtime,
      resources: { selectedMcpServers: [{ configPath, name: 'notes' }], rememberMcpSignIns: true },
    });
    await entered.promise;
    within(container).getByRole('checkbox', { name: 'Remember MCP sign-ins' }).click();
    listing.resolve();
    await waitFor(() => {
      expect(within(container).getByRole('status').textContent)
        .toContain('Could not save resource settings: The MCP probe could not be stopped.');
    });
    expect(getCopilotHostResources(settings).rememberMcpSignIns).toBe(true);

    failStop = false;
    within(container).getByRole('checkbox', { name: 'Remember MCP sign-ins' }).click();
    await settle();
    expect(getCopilotHostResources(settings).rememberMcpSignIns).toBeUndefined();
  });

  it('disables sign-in while the remembered-credentials choice is being saved', async () => {
    const configPath = write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp' } },
    }));
    const commit = createDeferred();
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      onSessionCreated: session => {
        session.mcpReadinessBehavior = async () => ({ phase: 'needs-auth' });
      },
    }));
    const { container } = renderSection({
      beforeSettingsCommit: () => commit.promise,
      runtime,
      resources: { selectedMcpServers: [{ configPath, name: 'notes' }], rememberMcpSignIns: true },
    });
    await waitFor(() => expect(within(container).getByText('Sign-in required')).toBeTruthy());
    const signIn = within(container).getByRole('button', { name: 'Sign in to notes' }) as HTMLButtonElement;
    expect(signIn.disabled).toBe(false);
    within(container).getByRole('checkbox', { name: 'Remember MCP sign-ins' }).click();
    try {
      expect(signIn.disabled).toBe(true);
    } finally {
      commit.resolve();
      await settle();
    }
  });

  it('checks enabled MCPs after rendering, keeps skills status-free, and does not probe on filters', async () => {
    const configPath = write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: {
        notes: { type: 'http', url: 'https://example.test/mcp' },
        disabled: { command: 'unused' },
      },
    }));
    write('vault/.github/skills/review/SKILL.md', '---\nname: review\n---\n');
    const listing = createDeferred();
    const entered = createDeferred();
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      onSessionCreated: session => {
        session.mcpReadinessBehavior = async () => {
          entered.resolve();
          await listing.promise;
          return { phase: 'connected', toolCount: 0 };
        };
      },
    }));
    const { container, persistedSelections } = renderSection({
      runtime, resources: { selectedMcpServers: [{ configPath, name: 'notes' }], rememberMcpSignIns: true },
    });
    await entered.promise;
    const notes = within(container).getByRole('checkbox', { name: /MCP server: notes/ }).closest('.claudian-copilot-resources-row')!;
    expect(within(notes as HTMLElement).getByText('Checking...')).toBeTruthy();
    expect(within(container).getByText('Disabled')).toBeTruthy();
    const skills = within(container).getByRole('checkbox', { name: /Skill: review/ }).closest('.claudian-copilot-resources-row')!;
    expect(within(skills as HTMLElement).queryByRole('button')).toBeNull();
    expect(skills.querySelector('.claudian-copilot-mcp-readiness')).toBeNull();
    listing.resolve();
    await waitFor(() => expect(within(notes as HTMLElement).getByText('Connected (0 tools)')).toBeTruthy());
    expect(within(notes as HTMLElement).queryByRole('button', { name: 'Sign in to notes' })).toBeNull();
    expect(within(notes as HTMLElement).getByRole('button', { name: 'Check notes connection' })).toBeTruthy();
    const input = within(container).getByRole('searchbox') as HTMLInputElement;
    input.value = 'notes';
    input.dispatchEvent(new Event('input'));
    input.value = '';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect(runtime.clients).toHaveLength(1);
    expect(persistedSelections).toEqual([]);
    expect((await checkAccessibility(container)).violations).toEqual([]);
  });

  it('offers sign-in only when appropriate and explicitly rechecks an auth-required server', async () => {
    const configPath = write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp' } },
    }));
    let ready = false;
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      onSessionCreated: session => {
        session.mcpReadinessBehavior = async () => ready
          ? { phase: 'connected', toolCount: 2 } : { phase: 'needs-auth' };
      },
    }));
    const { container } = renderSection({
      runtime, resources: { selectedMcpServers: [{ configPath, name: 'notes' }], rememberMcpSignIns: true },
    });
    await waitFor(() => expect(within(container).getByText('Sign-in required')).toBeTruthy());
    expect(within(container).getAllByRole('button', { name: 'Sign in to notes' })).toHaveLength(1);
    ready = true;
    within(container).getByRole('button', { name: 'Check notes connection' }).click();
    await waitFor(() => expect(within(container).getByText('Connected (2 tools)')).toBeTruthy());
  });

  it('rechecks after completed OAuth, not after handing off the URL, and waits for tool listing', async () => {
    const configPath = write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp' } },
    }));
    const reference = { configPath, name: 'notes' };
    const listing = createDeferred();
    const entered = createDeferred();
    let authenticated = false;
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      onSessionCreated: session => {
        session.mcpSignInBehavior = async () => ({ authorizationUrl: 'https://example.test/authorize' });
        session.mcpReadinessBehavior = async () => {
          if (!authenticated) return { phase: 'needs-auth' };
          entered.resolve();
          await listing.promise;
          return { phase: 'connected', toolCount: 1 };
        };
      },
    }));
    const { container, mcpSignIn } = renderSection({
      runtime, resources: { selectedMcpServers: [reference], rememberMcpSignIns: true },
    });
    await waitFor(() => expect(within(container).getByText('Sign-in required')).toBeTruthy());
    const signingIn = mcpSignIn.signIn(reference);
    await waitFor(() => expect(mcpSignIn.getState(reference).phase).toBe('waiting'));
    expect(container.textContent).not.toContain('Connected');
    authenticated = true;
    runtime.clients.at(-1)!.lastSession!.emit({
      id: 'connected', parentId: null, timestamp: new Date().toISOString(),
      type: 'session.mcp_server_status_changed', ephemeral: true,
      data: { serverName: 'notes', status: 'connected' },
    });
    await signingIn;
    await entered.promise;
    expect(within(container).getByText('Checking...')).toBeTruthy();
    expect(container.textContent).not.toContain('Connected');
    listing.resolve();
    await waitFor(() => expect(within(container).getByText('Connected (1 tool)')).toBeTruthy());
  });

  it('releases the view and fences its late readiness completion', async () => {
    const configPath = write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { command: 'notes-mcp' } },
    }));
    const entered = createDeferred();
    const listing = createDeferred();
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      onSessionCreated: session => {
        session.mcpReadinessBehavior = async () => {
          entered.resolve();
          await listing.promise;
          return { phase: 'connected', toolCount: 1 };
        };
      },
    }));
    const { container, dispose } = renderSection({
      runtime, resources: { selectedMcpServers: [{ configPath, name: 'notes' }] },
    });
    await entered.promise;
    dispose();
    const text = container.textContent;
    listing.resolve();
    await waitFor(() => expect(runtime.clients[0]?.stopped).toBe(1));
    expect(container.textContent).toBe(text);
    expect(container.textContent).not.toContain('Connected');
  });

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
    await settle();

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
    await settle();

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

  it('renders sign-in controls only for remote MCP servers, never for skills or local servers', async () => {
    write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: {
        local: { command: 'local-mcp' },
        remote: { type: 'http', url: 'https://example.test/mcp' },
      },
    }));
    write('home/.copilot/skills/review/SKILL.md', '---\nname: review\n---\n');
    const { container } = renderSection();
    const skill = await discovered(container, /Skill: review/);
    const local = within(container).getByRole('checkbox', { name: /MCP server: local/ });

    for (const checkbox of [skill, local]) {
      const row = checkbox.closest('.claudian-copilot-resources-row')!;
      expect(within(row as HTMLElement).queryAllByRole('button', { name: /Sign in/, hidden: true })).toEqual([]);
    }
    expect(within(container).getByRole('button', { name: 'Sign in to remote' })).toBeTruthy();
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

  it('offers sign-in only after selecting a remote server and opting in to remembered credentials', async () => {
    write('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp' } },
    }));
    const runtime = new FakeCopilotSdkRuntime(() => new FakeCopilotSdkClient({
      onSessionCreated: session => { session.mcpReadinessBehavior = async () => ({ phase: 'needs-auth' }); },
    }));
    const { container, settings } = renderSection({ runtime });
    const selected = await discovered(container, /MCP server: notes/);
    const signIn = within(container).getByRole('button', { name: 'Sign in to notes' }) as HTMLButtonElement;
    expect(signIn.type).toBe('button');
    expect(signIn.closest('label')).toBeNull();
    expect(signIn.parentElement).toBe(selected.closest('.claudian-copilot-resources-row'));
    expect(signIn.disabled).toBe(true);
    selected.click();
    await settle();
    expect(signIn.disabled).toBe(true);

    within(container).getByRole('checkbox', { name: 'Remember MCP sign-ins' }).click();
    await settle();

    expect(getCopilotHostResources(settings).rememberMcpSignIns).toBe(true);
    await waitFor(() => {
      expect((within(container).getByRole('button', { name: 'Sign in to notes' }) as HTMLButtonElement).disabled).toBe(false);
    });
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
