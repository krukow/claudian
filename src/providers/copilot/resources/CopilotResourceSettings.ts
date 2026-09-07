export interface CopilotMcpServerReference {
  readonly configPath: string;
  readonly name: string;
}

export interface CopilotResourceSettings {
  additionalMcpConfigPaths: string[];
  additionalSkillRoots: string[];
  selectedMcpServers: CopilotMcpServerReference[];
  selectedSkillPaths: string[];
}

export type CopilotResourcesByHost = Record<string, CopilotResourceSettings>;

export function normalizeCopilotResourcesByHost(value: unknown): CopilotResourcesByHost {
  if (!isRecord(value)) {
    return {};
  }
  const entries: Array<[string, CopilotResourceSettings]> = [];
  for (const [rawKey, resources] of Object.entries(value)) {
    const key = rawKey.trim();
    if (key && isRecord(resources)) {
      entries.push([key, normalizeCopilotResourceSettings(resources)]);
    }
  }
  return Object.fromEntries(entries);
}

export function normalizeCopilotResourceSettings(value: unknown): CopilotResourceSettings {
  const record = isRecord(value) ? value : {};
  return {
    additionalMcpConfigPaths: normalizeStringList(record.additionalMcpConfigPaths),
    additionalSkillRoots: normalizeStringList(record.additionalSkillRoots),
    selectedMcpServers: normalizeMcpReferences(record.selectedMcpServers),
    selectedSkillPaths: normalizeStringList(record.selectedSkillPaths),
  };
}

function normalizeMcpReferences(value: unknown): CopilotMcpServerReference[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const references = new Map<string, CopilotMcpServerReference>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const configPath = typeof entry.configPath === 'string' ? entry.configPath.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (configPath && name) {
      references.set(JSON.stringify([configPath, name]), { configPath, name });
    }
  }
  return [...references.values()];
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
