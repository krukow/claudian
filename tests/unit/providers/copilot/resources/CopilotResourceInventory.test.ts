import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { discoverCopilotResources } from '@/providers/copilot/resources/CopilotResourceInventory';

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-resources-'));
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
} = {}) {
  return discoverCopilotResources({
    additionalMcpConfigPaths: overrides.additionalMcpConfigPaths ?? [],
    additionalSkillRoots: overrides.additionalSkillRoots ?? [],
    homeDirectory: homeDirectory(),
    vaultDirectory: vaultDirectory(),
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
});
