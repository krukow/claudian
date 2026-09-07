/**
 * The built-in tools the Copilot CLI registers for a Claudian session.
 *
 * Captured from `session.tools.getCurrentMetadata` on Copilot CLI 1.0.83 with the exact
 * session configuration `CopilotSdkRuntime` builds, so it excludes tools Claudian turns
 * off (skills, MCP apps, memory, scheduling) and includes `ask_user`, which only exists
 * because Claudian wires a user-input handler.
 *
 * The catalog is a record of what the CLI offered, not a contract. Tool policy is derived
 * from the read-only group as an allow-list, so a tool this capture does not know about —
 * a newer builtin, a platform-specific shell, an MCP or custom tool — is unavailable to a
 * read-only turn rather than silently permitted.
 */
export const COPILOT_READ_ONLY_BUILTIN_TOOLS: readonly string[] = [
  'ask_user',
  'glob',
  'grep',
  'list_bash',
  'read_bash',
  'view',
  'web_fetch',
];

/**
 * Tools that change state or drive something that can: a shell, a file write, a process
 * kill, or a SQL statement. Recorded for completeness; the read-only policy is expressed
 * as the allow-list above.
 */
export const COPILOT_MUTATING_BUILTIN_TOOLS: readonly string[] = [
  'bash',
  'create',
  'edit',
  'sql',
  'stop_bash',
];

/**
 * Tools that start, inspect, or author work outside the turn the user is watching: the
 * background-agent family, and the factory family that authors and runs JavaScript.
 *
 * Claudian surfaces neither. `capabilities.ts` advertises no subagent support, there is
 * no subagent adapter, and nothing renders what either family would produce, so a turn
 * that started one would run work the user can neither watch nor stop. They are excluded
 * from every policy, including the ones that otherwise leave the CLI's own defaults
 * alone. Supporting them means building the surface first, not deleting this group.
 */
export const COPILOT_UNSUPPORTED_BUILTIN_TOOLS: readonly string[] = [
  'factories_manage',
  'list_agents',
  'read_agent',
  'run_factory',
  'task',
  'write_agent',
];

export const COPILOT_BUILTIN_TOOL_CATALOG: readonly string[] = [
  ...COPILOT_READ_ONLY_BUILTIN_TOOLS,
  ...COPILOT_MUTATING_BUILTIN_TOOLS,
  ...COPILOT_UNSUPPORTED_BUILTIN_TOOLS,
].sort();

/**
 * The builtins a policy may name. It is the captured catalog without the families
 * Claudian renders nothing for, so an allow-list is answered from what the CLI actually
 * offered rather than from whatever names a caller passed in.
 */
export const COPILOT_ALLOWABLE_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  ...COPILOT_READ_ONLY_BUILTIN_TOOLS,
  ...COPILOT_MUTATING_BUILTIN_TOOLS,
]);

/** Source-qualified filter patterns, so a same-named MCP or custom tool never matches. */
export const COPILOT_READ_ONLY_TOOL_FILTERS: readonly string[] =
  COPILOT_READ_ONLY_BUILTIN_TOOLS.map(name => `builtin:${name}`);

/**
 * Unqualified filter patterns, which the SDK matches across every tool source.
 *
 * An allow-list is narrowed by source so an unknown same-named tool is not permitted. A
 * deny-list is written for the opposite reason: a tool named `task` is refused whichever
 * source registered it.
 */
export const COPILOT_UNSUPPORTED_TOOL_FILTERS: readonly string[] =
  COPILOT_UNSUPPORTED_BUILTIN_TOOLS;

/**
 * Permission kinds a read-only turn may still reach the user with. Every other kind the
 * CLI defines — `shell`, `write`, `mcp`, `memory`, `custom-tool`, `hook`,
 * `extension-management`, `factory`, `extension-permission-access` — and every kind added
 * later is rejected without prompting.
 */
export const COPILOT_READ_ONLY_PERMISSION_KINDS: ReadonlySet<string> = new Set([
  'read',
  'url',
]);
