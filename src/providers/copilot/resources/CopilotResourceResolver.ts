import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { isAbsoluteCopilotPath } from '../runtime/CopilotAbsolutePath';
import type { CopilotSdkMcpServerConfig } from '../sdk/CopilotSdkPort';
import type { CopilotResourceSettings } from './CopilotResourceSettings';

export interface CopilotResolvedResources {
  readonly mcpServers: Readonly<Record<string, CopilotSdkMcpServerConfig>>;
  /** Package directories, because pointing the CLI at a parent root loads its siblings. */
  readonly skillDirectories: readonly string[];
  readonly skillPaths: readonly string[];
}

export interface CopilotResourceResolution {
  readonly problems: readonly string[];
  /** Null when nothing usable is selected, which is what a resource-free session asks for. */
  readonly resources: CopilotResolvedResources | null;
}

/**
 * Reads the definitions behind a selection, every time a session needs them.
 *
 * Only references are persisted, so this is where a server name and a configuration file
 * become the map the SDK is handed. The definitions stay in memory: they carry the
 * environment entries and headers their own file holds, which a vault that syncs must
 * never gain a copy of.
 *
 * A selection that no longer resolves is reported rather than dropped. A configuration
 * that moved, a server that was renamed, and a skill that was deleted are all things the
 * user chose and can fix, and a session that quietly ran without them would answer as if
 * the resource had never been asked for.
 */
export async function resolveCopilotSelectedResources(
  selection: CopilotResourceSettings,
): Promise<CopilotResourceResolution> {
  const problems: string[] = [];
  const mcpServers = await resolveMcpServers(selection, problems);
  const skills = await resolveSkills(selection, problems);
  const hasResources = Object.keys(mcpServers).length > 0 || skills.directories.length > 0;
  return {
    problems,
    resources: hasResources
      ? {
        mcpServers,
        skillDirectories: skills.directories,
        skillPaths: skills.paths,
      }
      : null,
  };
}

async function resolveMcpServers(
  selection: CopilotResourceSettings,
  problems: string[],
): Promise<Record<string, CopilotSdkMcpServerConfig>> {
  const resolved = new Map<string, CopilotSdkMcpServerConfig>();
  const claimedBy = new Map<string, string>();
  const documents = new Map<string, Record<string, unknown> | null>();

  for (const reference of selection.selectedMcpServers) {
    const claim = claimedBy.get(reference.name);
    if (claim !== undefined) {
      resolved.delete(reference.name);
      problems.push(
        `Two selected MCP servers are named ${reference.name}, in ${claim} and in `
        + `${reference.configPath}. Neither is started: the Copilot CLI identifies a `
        + 'server by that one name.',
      );
      continue;
    }
    claimedBy.set(reference.name, reference.configPath);

    if (!documents.has(reference.configPath)) {
      documents.set(reference.configPath, await readMcpDocument(reference.configPath, problems));
    }
    const declared = documents.get(reference.configPath);
    if (!declared) {
      continue;
    }
    const definition = declared[reference.name];
    if (!isRecord(definition)) {
      problems.push(
        `The MCP configuration at ${reference.configPath} no longer declares a server `
        + `named ${reference.name}.`,
      );
      continue;
    }
    const decoded = decodeMcpServer(definition, reference.name, reference.configPath);
    if (typeof decoded === 'string') {
      problems.push(decoded);
      continue;
    }
    resolved.set(reference.name, decoded);
  }
  return Object.fromEntries(resolved);
}

async function readMcpDocument(
  configPath: string,
  problems: string[],
): Promise<Record<string, unknown> | null> {
  if (!isAbsoluteCopilotPath(configPath)) {
    problems.push(`The MCP configuration at ${configPath} must use an absolute path.`);
    return null;
  }
  let content: string;
  try {
    content = await fs.readFile(configPath, 'utf8');
  } catch {
    problems.push(`The MCP configuration at ${configPath} could not be read.`);
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    const servers = isRecord(parsed) ? parsed.mcpServers : undefined;
    if (!isRecord(servers)) {
      problems.push(`The MCP configuration at ${configPath} has no mcpServers map.`);
      return null;
    }
    return servers;
  } catch {
    problems.push(`The MCP configuration at ${configPath} is not valid JSON.`);
    return null;
  }
}

/**
 * Fields the native runtime understands and the pinned SDK's own configuration cannot
 * express. Passing one of them would be silently dropping the mechanism the server is
 * reached with, so the selection is refused and says which field it was.
 */
const UNSUPPORTED_MCP_FIELDS = ['auth', 'clientId', 'clientSecret', 'deferTools', 'oauth', 'oidc'];

/** The decoded server, or the reason it cannot be handed to the SDK. */
function decodeMcpServer(
  definition: Record<string, unknown>,
  name: string,
  configPath: string,
): CopilotSdkMcpServerConfig | string {
  const invalidField = (field: string): string => (
    `The MCP server ${name} in ${configPath} has an invalid ${field} field.`
  );
  const unsupported = UNSUPPORTED_MCP_FIELDS.find(field => definition[field] !== undefined);
  if (unsupported) {
    return `The MCP server ${name} in ${configPath} is configured with ${unsupported}, `
      + 'which Claudian cannot pass to the Copilot SDK. Remove the selection or use a '
      + 'server definition without it.';
  }

  const type = definition.type === undefined ? 'stdio' : readString(definition.type);
  if (!type) {
    return invalidField('type');
  }
  const tools = readStringArray(definition.tools);
  if (tools === 'invalid') {
    return invalidField('tools');
  }
  const timeout = definition.timeout;
  if (timeout !== undefined && (
    typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0
  )) {
    return invalidField('timeout');
  }

  if (type === 'http' || type === 'sse') {
    const url = readString(definition.url);
    if (!url) {
      return `The MCP server ${name} in ${configPath} is a ${type} server without a url.`;
    }
    const headers = readStringRecord(definition.headers);
    if (headers === 'invalid') {
      return `The MCP server ${name} in ${configPath} has headers that are not text.`;
    }
    return {
      ...(headers ? { headers } : {}),
      ...(timeout === undefined ? {} : { timeout }),
      ...(tools ? { tools } : {}),
      type,
      url,
    };
  }

  if (type !== 'stdio' && type !== 'local') {
    return `The MCP server ${name} in ${configPath} uses the unsupported transport ${type}.`;
  }

  const command = readString(definition.command);
  if (!command) {
    return `The MCP server ${name} in ${configPath} is a local server without a command.`;
  }
  const env = readStringRecord(definition.env);
  if (env === 'invalid') {
    return `The MCP server ${name} in ${configPath} has environment values that are not text.`;
  }
  const args = readStringArray(definition.args);
  if (args === 'invalid') {
    return invalidField('args');
  }
  for (const field of ['workingDirectory', 'cwd']) {
    if (definition[field] !== undefined && !readString(definition[field])) {
      return invalidField(field);
    }
  }
  const workingDirectory = readString(definition.workingDirectory) ?? readString(definition.cwd);
  return {
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(timeout === undefined ? {} : { timeout }),
    ...(tools ? { tools } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
    command,
    type: 'stdio',
  };
}

async function resolveSkills(
  selection: CopilotResourceSettings,
  problems: string[],
): Promise<{ directories: string[]; paths: string[] }> {
  const directories: string[] = [];
  const paths: string[] = [];
  for (const skillPath of selection.selectedSkillPaths) {
    if (!isAbsoluteCopilotPath(skillPath)) {
      problems.push(`The selected skill at ${skillPath} must use an absolute path.`);
      continue;
    }
    if (path.basename(skillPath) !== 'SKILL.md') {
      problems.push(`The selected skill at ${skillPath} must name its SKILL.md file.`);
      continue;
    }
    if (!await isReadableFile(skillPath)) {
      problems.push(`The selected skill at ${skillPath} could not be read.`);
      continue;
    }
    const directory = path.dirname(skillPath);
    if (!directories.includes(directory)) {
      directories.push(directory);
    }
    paths.push(skillPath);
  }
  return { directories, paths };
}

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | 'invalid' | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string')) {
    return 'invalid';
  }
  return [...value];
}

/** The record, `undefined` when absent, and `'invalid'` when it holds anything but text. */
function readStringRecord(value: unknown): Record<string, string> | 'invalid' | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return 'invalid';
  }
  const entries: Array<[string, string]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      return 'invalid';
    }
    entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
