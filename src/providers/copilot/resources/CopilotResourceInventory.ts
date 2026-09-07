import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parseFrontmatter } from '../../../utils/frontmatter';
import { isAbsoluteCopilotPath } from '../runtime/CopilotAbsolutePath';

/** Where a configuration file or skill root was found. */
export type CopilotResourceScope = 'personal' | 'vault' | 'custom';

export interface CopilotDiscoveredMcpServer {
  readonly configPath: string;
  readonly name: string;
  readonly scope: CopilotResourceScope;
  /** Tool names the source config restricts the server to, when it restricts them. */
  readonly toolRestriction?: readonly string[];
  readonly transport: string;
}

export interface CopilotDiscoveredSkill {
  readonly commandName: string;
  readonly description?: string;
  /** The package directory holding `SKILL.md`, which is what the CLI is pointed at. */
  readonly directory: string;
  readonly path: string;
  readonly scope: CopilotResourceScope;
}

export interface CopilotResourceInventory {
  readonly mcpServers: readonly CopilotDiscoveredMcpServer[];
  readonly problems: readonly string[];
  readonly skills: readonly CopilotDiscoveredSkill[];
}

export interface CopilotResourceDiscoveryOptions {
  readonly additionalMcpConfigPaths: readonly string[];
  readonly additionalSkillRoots: readonly string[];
  readonly homeDirectory: string;
  readonly vaultDirectory: string;
}

const SKILL_FILE = 'SKILL.md';

/**
 * Reads what this computer offers, without enabling any of it.
 *
 * Only non-secret identity is returned: a server's name, the file it is declared in, and
 * the tool names that file restricts it to. Commands, arguments, environment entries,
 * URLs, and headers are deliberately left behind, because this inventory is what the
 * settings surface renders and what a selection is written from, while the definitions
 * themselves are read again at session time and never leave memory.
 */
export async function discoverCopilotResources(
  options: CopilotResourceDiscoveryOptions,
): Promise<CopilotResourceInventory> {
  const problems: string[] = [];
  const mcpServers = await discoverMcpServers(options, problems);
  const skills = await discoverSkills(options, problems);
  return {
    mcpServers,
    problems: [
      ...problems,
      ...describeDuplicates(mcpServers.map(server => server.name), 'MCP server'),
      ...describeDuplicates(skills.map(skill => skill.commandName), 'skill command'),
    ],
    skills,
  };
}

async function discoverMcpServers(
  options: CopilotResourceDiscoveryOptions,
  problems: string[],
): Promise<CopilotDiscoveredMcpServer[]> {
  const servers: CopilotDiscoveredMcpServer[] = [];
  for (const source of listMcpConfigSources(options, problems)) {
    const document = await readJsonFile(source.path);
    if (document.kind === 'absent') {
      if (source.scope === 'custom') {
        problems.push(`No MCP configuration file at ${source.path}.`);
      }
      continue;
    }
    if (document.kind === 'unreadable') {
      problems.push(`Could not read the MCP configuration at ${source.path}: ${document.reason}`);
      continue;
    }
    const declared = isRecord(document.value) ? document.value.mcpServers : undefined;
    if (!isRecord(declared)) {
      problems.push(`The MCP configuration at ${source.path} has no mcpServers map.`);
      continue;
    }
    for (const [name, definition] of Object.entries(declared)) {
      if (!isRecord(definition)) {
        problems.push(`The server ${name} in ${source.path} is not a server definition.`);
        continue;
      }
      const toolRestriction = readToolRestriction(definition);
      servers.push({
        configPath: source.path,
        name,
        scope: source.scope,
        ...(toolRestriction ? { toolRestriction } : {}),
        transport: readTransport(definition),
      });
    }
  }
  return servers;
}

async function discoverSkills(
  options: CopilotResourceDiscoveryOptions,
  problems: string[],
): Promise<CopilotDiscoveredSkill[]> {
  const skills: CopilotDiscoveredSkill[] = [];
  for (const source of listSkillRootSources(options, problems)) {
    const rootPackage = await readSkillPackage(source.path, source.scope);
    if (rootPackage) {
      skills.push(rootPackage);
      continue;
    }
    const entries = await readDirectory(source.path);
    if (entries.kind === 'absent') {
      if (source.scope === 'custom') {
        problems.push(`No skill root at ${source.path}.`);
      }
      continue;
    }
    if (entries.kind === 'unreadable') {
      problems.push(`Could not read the skill root at ${source.path}: ${entries.reason}`);
      continue;
    }
    for (const name of entries.names) {
      const skill = await readSkillPackage(path.join(source.path, name), source.scope);
      if (skill) {
        skills.push(skill);
      }
    }
  }
  return skills;
}

interface CopilotResourceSource {
  readonly path: string;
  readonly scope: CopilotResourceScope;
}

function listMcpConfigSources(
  options: CopilotResourceDiscoveryOptions,
  problems: string[],
): CopilotResourceSource[] {
  return [
    {
      path: path.join(options.homeDirectory, '.copilot', 'mcp-config.json'),
      scope: 'personal' as const,
    },
    { path: path.join(options.vaultDirectory, '.mcp.json'), scope: 'vault' as const },
    {
      path: path.join(options.vaultDirectory, '.github', 'mcp.json'),
      scope: 'vault' as const,
    },
    ...toCustomSources(options.additionalMcpConfigPaths, 'MCP configuration', problems),
  ];
}

function listSkillRootSources(
  options: CopilotResourceDiscoveryOptions,
  problems: string[],
): CopilotResourceSource[] {
  return [
    { path: path.join(options.homeDirectory, '.copilot', 'skills'), scope: 'personal' as const },
    { path: path.join(options.homeDirectory, '.agents', 'skills'), scope: 'personal' as const },
    {
      path: path.join(options.vaultDirectory, '.github', 'skills'),
      scope: 'vault' as const,
    },
    { path: path.join(options.vaultDirectory, '.agents', 'skills'), scope: 'vault' as const },
    { path: path.join(options.vaultDirectory, '.claude', 'skills'), scope: 'vault' as const },
    ...toCustomSources(options.additionalSkillRoots, 'skill root', problems),
  ];
}

/**
 * A custom source names one place on this computer, so a relative path is refused rather
 * than resolved: it would name a different place depending on what happened to be the
 * working directory when the CLI was started.
 */
function toCustomSources(
  paths: readonly string[],
  label: string,
  problems: string[],
): CopilotResourceSource[] {
  const sources: CopilotResourceSource[] = [];
  for (const candidate of paths) {
    if (!isAbsoluteCopilotPath(candidate)) {
      problems.push(`The ${label} ${candidate} is not an absolute path.`);
      continue;
    }
    sources.push({ path: path.normalize(candidate), scope: 'custom' });
  }
  return sources;
}

async function readSkillPackage(
  directory: string,
  scope: CopilotResourceScope,
): Promise<CopilotDiscoveredSkill | null> {
  const skillPath = path.join(directory, SKILL_FILE);
  const content = await readTextFile(skillPath);
  if (content === null) {
    return null;
  }
  const frontmatter = parseFrontmatter(content)?.frontmatter ?? {};
  const name = readNonEmptyString(frontmatter.name) ?? path.basename(directory);
  const description = readNonEmptyString(frontmatter.description);
  return {
    commandName: name,
    ...(description ? { description } : {}),
    directory,
    path: skillPath,
    scope,
  };
}

function describeDuplicates(names: readonly string[], label: string): string[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([name]) => (
      `More than one ${label} is named ${name}. Selecting one of them does not select `
      + 'the other; the Copilot CLI can only run one of two identical names.'
    ));
}

type JsonRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'parsed'; readonly value: unknown }
  | { readonly kind: 'unreadable'; readonly reason: string };

async function readJsonFile(filePath: string): Promise<JsonRead> {
  const content = await readTextFile(filePath);
  if (content === null) {
    return { kind: 'absent' };
  }
  try {
    return { kind: 'parsed', value: JSON.parse(content) };
  } catch {
    return { kind: 'unreadable', reason: 'invalid JSON' };
  }
}

type DirectoryRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'listed'; readonly names: readonly string[] }
  | { readonly kind: 'unreadable'; readonly reason: string };

async function readDirectory(directory: string): Promise<DirectoryRead> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return {
      kind: 'listed',
      names: entries
        .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
        .map(entry => entry.name)
        .sort(),
    };
  } catch (error) {
    return isMissing(error)
      ? { kind: 'absent' }
      : { kind: 'unreadable', reason: describeFailure(error) };
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readTransport(definition: Record<string, unknown>): string {
  const declared = readNonEmptyString(definition.type);
  return declared ?? 'stdio';
}

function readToolRestriction(
  definition: Record<string, unknown>,
): readonly string[] | null {
  const tools = definition.tools;
  if (!Array.isArray(tools)) {
    return null;
  }
  const names = tools.filter((tool): tool is string => typeof tool === 'string');
  return names.includes('*') ? null : names;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
