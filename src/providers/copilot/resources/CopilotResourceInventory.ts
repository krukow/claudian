import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseFrontmatter } from '../../../utils/frontmatter';
import { isAbsoluteCopilotPath } from '../runtime/CopilotAbsolutePath';
import { canonicalizeCopilotHostPath } from '../runtime/CopilotCanonicalPath';
import { copilotSkillPathKey } from './CopilotResourceSettings';

/** Where a configuration file or skill root was found. */
export type CopilotResourceScope = 'personal' | 'vault' | 'repository' | 'custom';

export interface CopilotDiscoveredMcpServer {
  readonly configPath: string;
  readonly name: string;
  readonly scope: CopilotResourceScope;
  /** Tool names the source config restricts the server to, when it restricts them. */
  readonly toolRestriction?: readonly string[];
  readonly transport: string;
}

export interface CopilotSkillPackage {
  readonly commandName: string;
  readonly description?: string;
  /** The package directory holding `SKILL.md`, which is what the CLI is pointed at. */
  readonly directory: string;
  readonly path: string;
}

export interface CopilotDiscoveredSkill extends CopilotSkillPackage {
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
  const sources = new Map<string, CopilotResourceSource>();
  for (const source of [
    ...listSkillRootSources(options, problems),
    ...await listRepositorySkillSources(options.vaultDirectory, options.homeDirectory, problems),
  ]) {
    const key = skillSourceKey(source);
    if (sources.get(key)?.scope !== 'personal') {
      sources.set(key, source);
    }
  }
  const discovered = await discoverSkillsFromSources([...sources.values()], problems);
  const skillsByPath = new Map<string, CopilotDiscoveredSkill>();
  for (const skill of discovered) {
    const key = copilotSkillPathKey(skill.path);
    if (skill.scope === 'repository' || !skillsByPath.has(key)) {
      skillsByPath.set(key, skill);
    }
  }
  const skills = [...skillsByPath.values()];
  return {
    mcpServers,
    problems: [
      ...problems,
      ...describeDuplicates(mcpServers.map(server => server.name), 'MCP server'),
      ...describeDuplicates(skills.map(skill => skill.commandName.toLowerCase()), 'skill command'),
    ],
    skills,
  };
}

export async function discoverCopilotRepositorySkills(
  vaultDirectory: string,
  disabledSkillPaths: readonly string[] = [],
): Promise<Pick<CopilotResourceInventory, 'skills' | 'problems'>> {
  const problems: string[] = [];
  const sources = await listRepositorySkillSources(vaultDirectory, os.homedir(), problems);
  const excluded = new Set(disabledSkillPaths.map(copilotSkillPathKey));
  return { skills: await discoverSkillsFromSources(sources, problems, excluded), problems };
}

async function listRepositorySkillSources(
  vaultDirectory: string,
  homeDirectory: string,
  problems: string[],
): Promise<CopilotResourceSource[]> {
  if (!path.isAbsolute(vaultDirectory)) return [];
  let physicalVault: string;
  try {
    physicalVault = await fs.realpath(vaultDirectory);
  } catch (error) {
    if (!isMissing(error)) {
      problems.push(`Could not inspect the vault at ${vaultDirectory}: ${describeFailure(error)}`);
    }
    return [];
  }
  const repositoryRoot = await findRepositoryRoot(physicalVault, problems);
  if (!repositoryRoot) return [];
  const personalRoots = new Set(personalSkillSources(homeDirectory)
    .map(skillSourceKey));
  return [...new Set([repositoryRoot, physicalVault])].flatMap(directory => (
    standardSkillSources(directory, 'repository')
  )).filter(source => !personalRoots.has(skillSourceKey(source)));
}

async function findRepositoryRoot(vaultDirectory: string, problems: string[]): Promise<string | null> {
  let directory = vaultDirectory;
  while (true) {
    const marker = path.join(directory, '.git');
    try {
      const entry = await fs.stat(marker);
      if (entry.isDirectory() || entry.isFile()) return directory;
    } catch (error) {
      if (!isMissing(error)) {
        problems.push(`Could not inspect the repository at ${marker}: ${describeFailure(error)}`);
        return null;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
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

async function discoverSkillsFromSources(
  sources: readonly CopilotResourceSource[],
  problems: string[],
  excluded: ReadonlySet<string> = new Set(),
): Promise<CopilotDiscoveredSkill[]> {
  const skills: CopilotDiscoveredSkill[] = [];
  for (const source of sources) {
    if (excluded.has(copilotSkillPathKey(path.join(source.path, SKILL_FILE)))) continue;
    const rootPackage = await readSkillPackage(source.path, source.scope, problems);
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
      const directory = path.join(source.path, name);
      if (excluded.has(copilotSkillPathKey(path.join(directory, SKILL_FILE)))) continue;
      const skill = await readSkillPackage(directory, source.scope, problems);
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

function skillSourceKey(source: CopilotResourceSource): string {
  return canonicalizeCopilotHostPath(source.path, process.platform) ?? source.path;
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
    ...personalSkillSources(options.homeDirectory),
    ...standardSkillSources(options.vaultDirectory, 'vault'),
    ...toCustomSources(options.additionalSkillRoots, 'skill root', problems),
  ];
}

function personalSkillSources(homeDirectory: string): CopilotResourceSource[] {
  return ['.copilot', '.agents', '.claude'].map(folder => ({
    path: path.join(homeDirectory, folder, 'skills'),
    scope: 'personal',
  }));
}

function standardSkillSources(directory: string, scope: CopilotResourceScope): CopilotResourceSource[] {
  return ['.github', '.agents', '.claude'].map(folder => ({
    path: path.join(directory, folder, 'skills'),
    scope,
  }));
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
  problems: string[],
): Promise<CopilotDiscoveredSkill | null> {
  const result = await readCopilotSkillPackage(directory);
  if (result.kind === 'unreadable') {
    problems.push(`Could not read the skill at ${path.join(directory, SKILL_FILE)}: ${result.reason}`);
    return null;
  }
  if (result.kind === 'absent') {
    return null;
  }
  return { ...result.skill, scope };
}

type CopilotSkillPackageRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'read'; readonly skill: CopilotSkillPackage }
  | { readonly kind: 'unreadable'; readonly reason: string };

export async function readCopilotSkillPackage(directory: string): Promise<CopilotSkillPackageRead> {
  const skillPath = path.join(directory, SKILL_FILE);
  const content = await readTextFile(skillPath);
  if (content.kind !== 'read') return content;
  const frontmatter = parseFrontmatter(content.text)?.frontmatter ?? {};
  const name = readNonEmptyString(frontmatter.name) ?? path.basename(directory);
  const description = readNonEmptyString(frontmatter.description);
  return {
    kind: 'read',
    skill: {
      commandName: name,
      ...(description ? { description } : {}),
      directory,
      path: skillPath,
    },
  };
}

export function findCopilotDuplicateNames(names: readonly string[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name);
    else seen.add(name);
  }
  return duplicates;
}

function describeDuplicates(names: readonly string[], label: string): string[] {
  return [...findCopilotDuplicateNames(names)].map(name => (
    `More than one ${label} is named ${name}. Disable competing sources to choose one; `
    + 'the Copilot CLI can only run one of two identical names.'
  ));
}

type JsonRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'parsed'; readonly value: unknown }
  | { readonly kind: 'unreadable'; readonly reason: string };

async function readJsonFile(filePath: string): Promise<JsonRead> {
  const content = await readTextFile(filePath);
  if (content.kind !== 'read') return content;
  try {
    return { kind: 'parsed', value: JSON.parse(content.text) };
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

type TextRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'read'; readonly text: string }
  | { readonly kind: 'unreadable'; readonly reason: string };

async function readTextFile(filePath: string): Promise<TextRead> {
  try {
    return { kind: 'read', text: await fs.readFile(filePath, 'utf8') };
  } catch (error) {
    return isMissing(error)
      ? { kind: 'absent' }
      : { kind: 'unreadable', reason: describeFailure(error) };
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
