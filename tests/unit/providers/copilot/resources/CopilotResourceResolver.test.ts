import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveCopilotSelectedResources } from '@/providers/copilot/resources/CopilotResourceResolver';
import type { CopilotResourceSettings } from '@/providers/copilot/resources/CopilotResourceSettings';

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-resolver-'));
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
