import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveCopilotSelectedResources } from '@/providers/copilot/resources/CopilotResourceResolver';
import type { CopilotResourceSettings } from '@/providers/copilot/resources/CopilotResourceSettings';

let workspace: string;

jest.mock('node:os', () => ({
  ...jest.requireActual<typeof os>('node:os'),
  homedir: () => path.join(workspace, 'home'),
}));

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-resolver-')));
});

afterEach(async () => {
  await fs.rm(workspace, { force: true, recursive: true });
});

async function writeFile(relativePath: string, content: string): Promise<string> {
  const target = path.join(workspace, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
  return target;
}

function selection(overrides: Partial<CopilotResourceSettings> = {}): CopilotResourceSettings {
  return {
    additionalMcpConfigPaths: [],
    additionalSkillRoots: [],
    selectedMcpServers: [],
    selectedSkillPaths: [],
    ...overrides,
  };
}

describe('resolveCopilotSelectedResources', () => {
  it('resolves nothing when nothing is selected', async () => {
    const resolution = await resolveCopilotSelectedResources(selection());

    expect(resolution).toEqual({ problems: [], resources: null });
  });

  it('automatically loads repository skills for a vault nested below the Git root, but no MCP servers', async () => {
    const vault = path.join(workspace, 'repo', 'content');
    await fs.mkdir(vault, { recursive: true });
    await fs.mkdir(path.join(workspace, 'repo', '.git'));
    const skill = await writeFile('repo/.github/skills/review/SKILL.md', '---\nname: review\n---\n');
    await writeFile('repo/.mcp.json', JSON.stringify({
      mcpServers: { notSelected: { command: 'never-start-this' } },
    }));

    const resolution = await resolveCopilotSelectedResources(selection(), vault);

    expect(resolution).toEqual({
      problems: [],
      resources: { mcpServers: {}, skillDirectories: [path.dirname(skill)], skillPaths: [skill] },
    });
  });

  it('honors repository skill opt-outs while retaining automatic siblings and explicit personal skills', async () => {
    const vault = path.join(workspace, 'worktree', 'content');
    await fs.mkdir(vault, { recursive: true });
    await writeFile('worktree/.git', 'gitdir: /synthetic/repo/worktrees/notes\n');
    const disabled = await writeFile('worktree/.github/skills/review/SKILL.md', '---\nname: review\n---\n');
    const enabled = await writeFile('worktree/.agents/skills/notes/SKILL.md', '---\nname: notes\n---\n');
    const personal = await writeFile('personal/skills/edit/SKILL.md', '---\nname: edit\n---\n');

    const resolution = await resolveCopilotSelectedResources(selection({
      disabledRepositorySkillPaths: [disabled],
      selectedSkillPaths: [disabled, personal],
    }), vault);

    expect(resolution.resources?.skillPaths).toEqual([personal, enabled]);
    expect(resolution.problems).toEqual([]);
  });

  it('uses native persistent authentication only for explicitly opted-in MCP selections', async () => {
    const configPath = await writeFile('config/mcp.json', JSON.stringify({
      mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp' } },
    }));
    const resolution = await resolveCopilotSelectedResources(selection({
      rememberMcpSignIns: true,
      selectedMcpServers: [{ configPath, name: 'notes' }],
    }));

    expect(resolution.resources).toMatchObject({ mcpOAuthTokenStorage: 'persistent' });
    expect(resolution.problems).toEqual([]);
  });

  it('finds the physical repository of a linked vault instead of its lexical parent repository', async () => {
    const actual = path.join(workspace, 'actual');
    const directVault = path.join(actual, 'content');
    const linkedVault = path.join(workspace, 'outer', 'linked-vault');
    await fs.mkdir(directVault, { recursive: true });
    await fs.mkdir(path.join(actual, '.git'));
    await fs.mkdir(path.join(workspace, 'outer', '.git'), { recursive: true });
    await fs.symlink(directVault, linkedVault, 'junction');
    const actualSkill = await writeFile('actual/.github/skills/review/SKILL.md', '---\nname: review\n---\n');
    await writeFile('outer/.github/skills/wrong/SKILL.md', '---\nname: wrong\n---\n');

    const direct = await resolveCopilotSelectedResources(selection(), directVault);
    const linked = await resolveCopilotSelectedResources(selection(), linkedVault);

    expect(direct.problems).toEqual([]);
    expect(direct.resources?.skillPaths).toEqual([await fs.realpath(actualSkill)]);
    expect(linked).toEqual(direct);
  });

  it.each([false, true])('keeps repository opt-outs equivalent across vault aliases (linked vault: %s)', async (linked) => {
    const directVault = path.join(workspace, 'repo');
    const linkedVault = path.join(workspace, 'linked-vault');
    await fs.mkdir(path.join(directVault, '.git'), { recursive: true });
    await fs.symlink(directVault, linkedVault, 'junction');
    const skill = await writeFile('repo/.agents/skills/review/SKILL.md', '---\nname: review\n---\n');
    const alias = path.join(linkedVault, '.agents', 'skills', 'review', 'SKILL.md');
    const choices = selection({
      selectedSkillPaths: [linked ? alias : skill],
      disabledRepositorySkillPaths: [linked ? skill : alias],
    });

    const resolution = await resolveCopilotSelectedResources(choices, linked ? linkedVault : directVault);

    expect(resolution).toEqual({ problems: [], resources: null });
    expect(choices.selectedSkillPaths).toEqual([linked ? alias : skill]);
    expect(choices.disabledRepositorySkillPaths).toEqual([linked ? skill : alias]);
  });

  it('resolves explicit path aliases to one stable physical skill identity without rewriting references', async () => {
    const skill = await writeFile('custom/review/SKILL.md', '---\nname: review\n---\n');
    const linkedRoot = path.join(workspace, 'linked-custom');
    await fs.symlink(path.join(workspace, 'custom'), linkedRoot, 'junction');
    const alias = path.join(linkedRoot, 'review', 'SKILL.md');
    const choices = selection({ selectedSkillPaths: [skill, alias] });

    const throughAlias = await resolveCopilotSelectedResources(selection({ selectedSkillPaths: [alias] }));
    const together = await resolveCopilotSelectedResources(choices);
    const direct = await resolveCopilotSelectedResources(selection({ selectedSkillPaths: [skill] }));

    expect(direct.resources?.skillPaths).toEqual([skill]);
    expect(throughAlias).toEqual(direct);
    expect(together).toEqual(direct);
    expect(choices.selectedSkillPaths).toEqual([skill, alias]);
  });

  it('keeps the package directory when SKILL.md links to shared instruction content', async () => {
    const content = await writeFile('shared/instructions.md', '---\nname: linked-content\n---\n');
    const directory = path.join(workspace, 'custom', 'linked-content');
    await fs.mkdir(directory, { recursive: true });
    const skill = path.join(directory, 'SKILL.md');
    await fs.symlink(content, skill, 'file');

    const resolution = await resolveCopilotSelectedResources(selection({ selectedSkillPaths: [skill] }));

    expect(resolution).toEqual({
      problems: [],
      resources: { mcpServers: {}, skillDirectories: [directory], skillPaths: [skill] },
    });
  });

  it('keeps shared home skill roots opt-in when home is the containing repository', async () => {
    const home = path.join(workspace, 'home');
    const vault = path.join(home, 'content');
    await fs.mkdir(vault, { recursive: true });
    await fs.mkdir(path.join(home, '.git'));
    await writeFile('home/.agents/skills/global-agent/SKILL.md', '---\nname: global-agent\n---\n');
    await writeFile('home/.claude/skills/global-claude/SKILL.md', '---\nname: global-claude\n---\n');
    await writeFile('home/.copilot/skills/global-copilot/SKILL.md', '---\nname: global-copilot\n---\n');
    const repository = await writeFile('home/.github/skills/repo-review/SKILL.md', '---\nname: repo-review\n---\n');
    const local = await writeFile('home/content/.agents/skills/local/SKILL.md', '---\nname: local\n---\n');

    const resolution = await resolveCopilotSelectedResources(selection(), vault);

    expect(resolution.problems).toEqual([]);
    expect(resolution.resources?.skillPaths).toEqual([repository, local]);
  });

  it('does not turn an alias of a personal skill root into an automatic repository source', async () => {
    const vault = path.join(workspace, 'repo');
    await fs.mkdir(path.join(vault, '.git'), { recursive: true });
    await fs.mkdir(path.join(vault, '.agents'));
    const personal = await writeFile('home/.claude/skills/global/SKILL.md', '---\nname: global\n---\n');
    await fs.symlink(path.join(workspace, 'home', '.claude', 'skills'), path.join(vault, '.agents', 'skills'), 'junction');

    const automatic = await resolveCopilotSelectedResources(selection(), vault);
    const explicit = await resolveCopilotSelectedResources(selection({ selectedSkillPaths: [personal] }), vault);

    expect(automatic).toEqual({ problems: [], resources: null });
    expect(explicit.resources?.skillPaths).toEqual([personal]);
  });

  it('reports ambiguous default command names without handing either definition to the runtime', async () => {
    const vault = path.join(workspace, 'repo', 'content');
    await fs.mkdir(vault, { recursive: true });
    await fs.mkdir(path.join(workspace, 'repo', '.git'));
    const root = await writeFile('repo/.github/skills/review/SKILL.md', '---\nname: repo-review\n---\n');
    const local = await writeFile('repo/content/.agents/skills/review-copy/SKILL.md', '---\nname: repo-review\n---\n');
    const healthy = await writeFile('repo/.claude/skills/healthy/SKILL.md', '---\nname: healthy\n---\n');

    const resolution = await resolveCopilotSelectedResources(selection(), vault);

    expect(resolution.resources?.skillPaths).toEqual([healthy]);
    expect(resolution.problems).toEqual([
      `More than one enabled skill command is named repo-review: ${root}, ${local}. `
      + 'None of these packages is loaded. Disable competing sources under Resources.',
    ]);
  });

  it.each([false, true])('allows intentional resolution of duplicate names through opt-out and explicit choice (local: %s)', async (chooseLocal) => {
    const vault = path.join(workspace, 'repo', 'content');
    await fs.mkdir(vault, { recursive: true });
    await fs.mkdir(path.join(workspace, 'repo', '.git'));
    const root = await writeFile('repo/.github/skills/review/SKILL.md', '---\nname: repo-review\n---\n');
    const local = await writeFile('repo/content/.agents/skills/review-copy/SKILL.md', '---\nname: repo-review\n---\n');
    const chosen = chooseLocal ? local : root;
    const other = chooseLocal ? root : local;

    const resolution = await resolveCopilotSelectedResources(selection({
      disabledRepositorySkillPaths: [other], selectedSkillPaths: [chosen],
    }), vault);

    expect(resolution.problems).toEqual([]);
    expect(resolution.resources?.skillPaths).toEqual([chosen]);
  });

  it('applies the same command-name conflict rule to explicitly selected packages', async () => {
    const first = await writeFile('personal/review/SKILL.md', '---\nname: duplicate\n---\n');
    const second = await writeFile('custom/review-copy/SKILL.md', '---\nname: duplicate\n---\n');

    const resolution = await resolveCopilotSelectedResources(selection({
      selectedSkillPaths: [first, second],
    }));

    expect(resolution.resources).toBeNull();
    expect(resolution.problems).toEqual([
      `More than one enabled skill command is named duplicate: ${first}, ${second}. `
      + 'None of these packages is loaded. Disable competing sources under Resources.',
    ]);
  });

  it('resolves a selected stdio server from its own configuration file', async () => {
    const configPath = await writeFile('config/mcp.json', JSON.stringify({
      mcpServers: {
        notes: {
          args: ['--vault'],
          command: '/usr/bin/notes-mcp',
          cwd: '/workspaces/notes',
          env: { NOTES_TOKEN: 'literal-token' },
          timeout: 15000,
          tools: ['search'],
        },
        unselected: { command: '/usr/bin/other' },
      },
    }));

    const resolution = await resolveCopilotSelectedResources(selection({
      selectedMcpServers: [{ configPath, name: 'notes' }],
    }));

    expect(resolution.problems).toEqual([]);
    expect(resolution.resources).toEqual({
      mcpServers: {
        notes: {
          args: ['--vault'],
          command: '/usr/bin/notes-mcp',
          env: { NOTES_TOKEN: 'literal-token' },
          timeout: 15000,
          tools: ['search'],
          type: 'stdio',
          workingDirectory: '/workspaces/notes',
        },
      },
      skillDirectories: [],
      skillPaths: [],
    });
  });

  it('resolves a selected remote server with its headers', async () => {
    const configPath = await writeFile('config/remote.json', JSON.stringify({
      mcpServers: {
        docs: {
          headers: { Authorization: 'Bearer literal' },
          type: 'sse',
          url: 'https://example.test/mcp',
        },
      },
    }));

    const resolution = await resolveCopilotSelectedResources(selection({
      selectedMcpServers: [{ configPath, name: 'docs' }],
    }));

    expect(resolution.problems).toEqual([]);
    expect(resolution.resources?.mcpServers).toEqual({
      docs: {
        headers: { Authorization: 'Bearer literal' },
        type: 'sse',
        url: 'https://example.test/mcp',
      },
    });
  });

  it('reports a selection whose configuration or server is gone', async () => {
    const configPath = await writeFile('config/mcp.json', JSON.stringify({
      mcpServers: { present: { command: '/usr/bin/present' } },
    }));

    const resolution = await resolveCopilotSelectedResources(selection({
      selectedMcpServers: [
        { configPath, name: 'renamed' },
        { configPath: path.join(workspace, 'gone.json'), name: 'notes' },
      ],
    }));

    expect(resolution.resources).toBeNull();
    expect(resolution.problems).toEqual([
      expect.stringContaining('renamed'),
      expect.stringContaining('gone.json'),
    ]);
  });

  it('refuses a server whose credentials the SDK cannot carry', async () => {
    const configPath = await writeFile('config/oauth.json', JSON.stringify({
      mcpServers: {
        corporate: {
          oauth: { clientId: 'abc' },
          type: 'http',
          url: 'https://example.test/mcp',
        },
      },
    }));

    const resolution = await resolveCopilotSelectedResources(selection({
      selectedMcpServers: [{ configPath, name: 'corporate' }],
    }));

    expect(resolution.resources).toBeNull();
    expect(resolution.problems).toEqual([expect.stringContaining('oauth')]);
  });

  it.each([
    ['tools', 'read_note'],
    ['tools', ['read_note', 7]],
    ['tools', null],
    ['args', '--read-only'],
    ['args', ['--read-only', false]],
    ['type', false],
    ['type', ''],
    ['timeout', '5000'],
    ['timeout', 0],
    ['timeout', -1],
    ['workingDirectory', false],
    ['workingDirectory', ''],
    ['cwd', ['not-a-directory']],
  ])('refuses a malformed %s field without broadening the server configuration',
    async (field, value) => {
      const configPath = await writeFile('config/invalid.json', JSON.stringify({
        mcpServers: { notes: { command: '/usr/bin/notes-mcp', [field]: value } },
      }));

      const resolution = await resolveCopilotSelectedResources(selection({
        selectedMcpServers: [{ configPath, name: 'notes' }],
      }));

      expect(resolution.resources).toBeNull();
      expect(resolution.problems).toEqual([expect.stringContaining(field)]);
    });

  it('keeps explicit empty arguments and a deny-all tool restriction', async () => {
    const configPath = await writeFile('config/empty.json', JSON.stringify({
      mcpServers: { notes: { args: [], command: 'notes-mcp', tools: [] } },
    }));

    const resolution = await resolveCopilotSelectedResources(selection({
      selectedMcpServers: [{ configPath, name: 'notes' }],
    }));

    expect(resolution.problems).toEqual([]);
    expect(resolution.resources?.mcpServers.notes).toEqual({
      args: [], command: 'notes-mcp', tools: [], type: 'stdio',
    });
  });

  it('reports malformed JSON without exposing its contents', async () => {
    const configPath = await writeFile('config/private.json', 'SYNTHETIC_SECRET invalid JSON');

    const resolution = await resolveCopilotSelectedResources(selection({
      selectedMcpServers: [{ configPath, name: 'notes' }],
    }));

    expect(resolution.resources).toBeNull();
    expect(resolution.problems).toEqual([
      `The MCP configuration at ${configPath} is not valid JSON.`,
    ]);
  });

  it('rejects relative references before resolving them against the process directory', async () => {
    const configPath = await writeFile('config/relative.json', JSON.stringify({
      mcpServers: { notes: { command: 'notes-mcp' } },
    }));
    const skillPath = await writeFile('skills/relative/SKILL.md', '# skill');
    const resolution = await resolveCopilotSelectedResources(selection({
      selectedMcpServers: [{
        configPath: path.relative(process.cwd(), configPath), name: 'notes',
      }],
      selectedSkillPaths: [path.relative(process.cwd(), skillPath)],
    }));

    expect(resolution.resources).toBeNull();
    expect(resolution.problems).toEqual([
      expect.stringContaining('absolute path'),
      expect.stringContaining('absolute path'),
    ]);
  });

  it('rejects a skill reference to a file other than SKILL.md', async () => {
    const otherPath = await writeFile('skills/unselected/README.md', '# readme');
    await writeFile('skills/unselected/SKILL.md', '# should not become selected');

    const resolution = await resolveCopilotSelectedResources(selection({
      selectedSkillPaths: [otherPath],
    }));

    expect(resolution.resources).toBeNull();
    expect(resolution.problems).toEqual([expect.stringContaining('SKILL.md')]);
  });

  it('refuses two selected servers that would share one name', async () => {
    const first = await writeFile('config/first.json', JSON.stringify({
      mcpServers: { docs: { command: '/usr/bin/first' } },
    }));
    const second = await writeFile('config/second.json', JSON.stringify({
      mcpServers: { docs: { command: '/usr/bin/second' } },
    }));

    const resolution = await resolveCopilotSelectedResources(selection({
      selectedMcpServers: [
        { configPath: first, name: 'docs' },
        { configPath: second, name: 'docs' },
      ],
    }));

    expect(resolution.resources).toBeNull();
    expect(resolution.problems).toEqual([expect.stringContaining('docs')]);
  });

  it('resolves a selected skill to the package directory the CLI is pointed at', async () => {
    const skillPath = await writeFile('skills/review/SKILL.md', '---\nname: review\n---\n');

    const resolution = await resolveCopilotSelectedResources(selection({
      selectedSkillPaths: [skillPath, path.join(workspace, 'skills', 'gone', 'SKILL.md')],
    }));

    expect(resolution.resources).toEqual({
      mcpServers: {},
      skillDirectories: [path.join(workspace, 'skills', 'review')],
      skillPaths: [skillPath],
    });
    expect(resolution.problems).toEqual([expect.stringContaining('gone')]);
  });
});
