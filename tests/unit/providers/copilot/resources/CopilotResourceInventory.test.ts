import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { discoverCopilotRepositorySkills, discoverCopilotResources } from '@/providers/copilot/resources/CopilotResourceInventory';

let workspace: string;

jest.mock('node:os', () => ({
  ...jest.requireActual<typeof os>('node:os'),
  homedir: () => path.join(workspace, 'home'),
}));

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-resources-')));
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

function homeDirectory(): string {
  return path.join(workspace, 'home');
}

function vaultDirectory(): string {
  return path.join(workspace, 'vault');
}

function discover(overrides: {
  additionalMcpConfigPaths?: string[];
  additionalSkillRoots?: string[];
  homeDirectory?: string;
  vaultDirectory?: string;
} = {}) {
  return discoverCopilotResources({
    additionalMcpConfigPaths: overrides.additionalMcpConfigPaths ?? [],
    additionalSkillRoots: overrides.additionalSkillRoots ?? [],
    homeDirectory: overrides.homeDirectory ?? homeDirectory(),
    vaultDirectory: overrides.vaultDirectory ?? vaultDirectory(),
  });
}

describe('discoverCopilotResources', () => {
  it('reports personal, vault, and custom MCP servers with their source', async () => {
    await writeFile('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: {
        notes: { command: '/usr/bin/notes-mcp', env: { NOTES_TOKEN: 'a-secret-value' } },
      },
    }));
    await writeFile('vault/.mcp.json', JSON.stringify({
      mcpServers: { docs: { type: 'http', url: 'https://example.test/mcp' } },
    }));
    const customPath = await writeFile('elsewhere/private.json', JSON.stringify({
      mcpServers: { wiki: { command: '/opt/wiki-mcp', tools: ['search'] } },
    }));

    const inventory = await discover({ additionalMcpConfigPaths: [customPath] });

    expect(inventory.mcpServers).toEqual([
      {
        configPath: path.join(homeDirectory(), '.copilot', 'mcp-config.json'),
        name: 'notes',
        scope: 'personal',
        transport: 'stdio',
      },
      {
        configPath: path.join(vaultDirectory(), '.mcp.json'),
        name: 'docs',
        scope: 'vault',
        transport: 'http',
      },
      {
        configPath: customPath,
        name: 'wiki',
        scope: 'custom',
        toolRestriction: ['search'],
        transport: 'stdio',
      },
    ]);
    expect(JSON.stringify(inventory)).not.toContain('a-secret-value');
  });

  it('reports a malformed configuration instead of dropping it silently', async () => {
    await writeFile('home/.copilot/mcp-config.json', '{ not json');
    await writeFile('vault/.github/mcp.json', JSON.stringify({ servers: {} }));

    const inventory = await discover();

    expect(inventory.mcpServers).toEqual([]);
    expect(inventory.problems).toHaveLength(2);
    expect(inventory.problems[0]).toContain(path.join('.copilot', 'mcp-config.json'));
    expect(inventory.problems[1]).toContain('mcpServers');
  });

  it('reports invalid JSON without exposing configuration contents', async () => {
    const configPath = await writeFile(
      'home/.copilot/mcp-config.json', 'SYNTHETIC_SECRET invalid JSON',
    );

    const inventory = await discover();

    expect(inventory.problems).toEqual([
      `Could not read the MCP configuration at ${configPath}: invalid JSON`,
    ]);
    expect(inventory.mcpServers).toEqual([]);
  });

  it('names a duplicated server rather than merging the two definitions', async () => {
    await writeFile('home/.copilot/mcp-config.json', JSON.stringify({
      mcpServers: { docs: { command: '/usr/bin/personal-docs' } },
    }));
    await writeFile('vault/.mcp.json', JSON.stringify({
      mcpServers: { docs: { command: '/usr/bin/vault-docs' } },
    }));

    const inventory = await discover();

    expect(inventory.mcpServers).toHaveLength(2);
    expect(inventory.problems).toEqual([expect.stringContaining('docs')]);
  });

  it('lists a skill package under each standard and custom root', async () => {
    await writeFile(
      'home/.copilot/skills/notes-review/SKILL.md',
      '---\nname: notes-review\ndescription: Reviews notes\n---\nbody',
    );
    await writeFile('vault/.github/skills/vault-skill/SKILL.md', '# no frontmatter');
    const customRoot = path.join(workspace, 'custom-skills');
    await writeFile('custom-skills/private-skill/SKILL.md', '---\nname: private\n---\n');

    const inventory = await discover({ additionalSkillRoots: [customRoot] });

    expect(inventory.skills).toEqual([
      {
        commandName: 'notes-review',
        description: 'Reviews notes',
        directory: path.join(homeDirectory(), '.copilot', 'skills', 'notes-review'),
        path: path.join(homeDirectory(), '.copilot', 'skills', 'notes-review', 'SKILL.md'),
        scope: 'personal',
      },
      {
        commandName: 'vault-skill',
        directory: path.join(vaultDirectory(), '.github', 'skills', 'vault-skill'),
        path: path.join(vaultDirectory(), '.github', 'skills', 'vault-skill', 'SKILL.md'),
        scope: 'vault',
      },
      {
        commandName: 'private',
        directory: path.join(customRoot, 'private-skill'),
        path: path.join(customRoot, 'private-skill', 'SKILL.md'),
        scope: 'custom',
      },
    ]);
  });

  it('accepts a custom root that is itself one skill package', async () => {
    const customRoot = path.join(workspace, 'one-skill');
    await writeFile('one-skill/SKILL.md', '---\nname: solo\n---\n');

    const inventory = await discover({ additionalSkillRoots: [customRoot] });

    expect(inventory.skills.map(skill => skill.commandName)).toEqual(['solo']);
  });

  it('reports a custom source that is missing or not absolute', async () => {
    const inventory = await discover({
      additionalMcpConfigPaths: [path.join(workspace, 'absent.json')],
      additionalSkillRoots: ['relative/skills'],
    });

    expect(inventory.mcpServers).toEqual([]);
    expect(inventory.skills).toEqual([]);
    expect(inventory.problems).toEqual([
      expect.stringContaining('absent.json'),
      expect.stringContaining('relative/skills'),
    ]);
  });

  it('names two skills that would answer to the same command', async () => {
    await writeFile('home/.copilot/skills/review/SKILL.md', '---\nname: review\n---\n');
    await writeFile('home/.agents/skills/review/SKILL.md', '---\nname: review\n---\n');

    const inventory = await discover();

    expect(inventory.skills).toHaveLength(2);
    expect(inventory.problems).toEqual([expect.stringContaining('review')]);
  });

  it('marks repository skills as automatic without duplicating root-vault or custom discoveries', async () => {
    await fs.mkdir(path.join(vaultDirectory(), '.git'), { recursive: true });
    const skillPath = await writeFile('vault/.github/skills/review/SKILL.md', '---\nname: review\n---\n');

    const inventory = await discover({
      additionalSkillRoots: [path.join(vaultDirectory(), '.github', 'skills')],
    });

    expect(inventory.skills).toEqual([{
      commandName: 'review',
      directory: path.dirname(skillPath),
      path: skillPath,
      scope: 'repository',
    }]);
    expect(inventory.problems).toEqual([]);
  });

  it('uses the nearest Git root and does not inherit a surrounding repository', async () => {
    await fs.mkdir(path.join(workspace, '.git'));
    await writeFile('.github/skills/outer/SKILL.md', '---\nname: outer\n---\n');
    await writeFile('vault/.git', 'gitdir: /synthetic/worktrees/vault\n');
    const skillPath = await writeFile('vault/.claude/skills/inner/SKILL.md', '---\nname: inner\n---\n');
    const nestedVault = path.join(vaultDirectory(), 'content');
    await fs.mkdir(nestedVault);

    const discovered = await discoverCopilotRepositorySkills(nestedVault);

    expect(discovered.skills.map(skill => skill.path)).toEqual([skillPath]);
    expect(discovered.problems).toEqual([]);
  });

  it('does not automatically enable skills for a non-repository vault', async () => {
    await writeFile('vault/.agents/skills/local/SKILL.md', '---\nname: local\n---\n');

    const discovered = await discoverCopilotRepositorySkills(vaultDirectory());
    const inventory = await discover();

    expect(discovered).toEqual({ skills: [], problems: [] });
    expect(inventory.skills[0].scope).toBe('vault');
  });

  it('reports an unreadable repository skill instead of silently omitting it', async () => {
    await fs.mkdir(path.join(vaultDirectory(), '.git'), { recursive: true });
    const skillPath = path.join(vaultDirectory(), '.github', 'skills', 'broken', 'SKILL.md');
    await fs.mkdir(skillPath, { recursive: true });

    const discovered = await discoverCopilotRepositorySkills(vaultDirectory());
    const inventory = await discover();

    expect(discovered.skills).toEqual([]);
    expect(discovered.problems).toEqual([expect.stringContaining(skillPath)]);
    expect(inventory.problems).toEqual([expect.stringContaining(skillPath)]);
  });

  it('keeps home packages personal even when the home directory is the Git root', async () => {
    await fs.mkdir(path.join(homeDirectory(), '.git'), { recursive: true });
    const agent = await writeFile('home/.agents/skills/global-agent/SKILL.md', '---\nname: global-agent\n---\n');
    const claude = await writeFile('home/.claude/skills/global-claude/SKILL.md', '---\nname: global-claude\n---\n');
    const vault = path.join(homeDirectory(), 'content');
    await fs.mkdir(vault);

    const inventory = await discover({ vaultDirectory: vault });

    expect(inventory.problems).toEqual([]);
    expect(inventory.skills.map(skill => ({ path: skill.path, scope: skill.scope }))).toEqual([
      { path: agent, scope: 'personal' }, { path: claude, scope: 'personal' },
    ]);
  });

  it('classifies aliased personal skill roots before assigning repository defaults', async () => {
    await fs.mkdir(path.join(vaultDirectory(), '.git'), { recursive: true });
    await fs.mkdir(path.join(vaultDirectory(), '.agents'));
    const personal = await writeFile('home/.claude/skills/global/SKILL.md', '---\nname: global\n---\n');
    await fs.symlink(path.join(homeDirectory(), '.claude', 'skills'), path.join(vaultDirectory(), '.agents', 'skills'), 'junction');

    const inventory = await discover();

    expect(inventory.problems).toEqual([]);
    expect(inventory.skills).toEqual([expect.objectContaining({ path: personal, scope: 'personal' })]);
  });
});
