import {
  COPILOT_BUILTIN_TOOL_CATALOG,
  COPILOT_MUTATING_BUILTIN_TOOLS,
  COPILOT_READ_ONLY_BUILTIN_TOOLS,
  COPILOT_READ_ONLY_PERMISSION_KINDS,
  COPILOT_READ_ONLY_TOOL_FILTERS,
  COPILOT_UNSUPPORTED_BUILTIN_TOOLS,
  COPILOT_UNSUPPORTED_TOOL_FILTERS,
} from '@/providers/copilot/execution/CopilotBuiltinTools';

/**
 * The expected names are written out here rather than derived from the catalog, so a
 * change to what the provider believes the CLI offers has to be re-stated deliberately.
 * Recapture with `session.tools.getCurrentMetadata` before changing them.
 */
const CAPTURED_BUILTIN_TOOLS = [
  'ask_user',
  'bash',
  'create',
  'edit',
  'factories_manage',
  'glob',
  'grep',
  'list_agents',
  'list_bash',
  'read_agent',
  'read_bash',
  'run_factory',
  'sql',
  'stop_bash',
  'task',
  'view',
  'web_fetch',
  'write_agent',
];

/**
 * The tools that start, inspect, or author work outside the turn the user is watching:
 * the background-agent family and the factory family. Claudian advertises neither
 * capability and renders nothing either of them would produce.
 */
const CAPTURED_UNSUPPORTED_TOOLS = [
  'factories_manage',
  'list_agents',
  'read_agent',
  'run_factory',
  'task',
  'write_agent',
];

describe('Copilot builtin tool catalog', () => {
  it('records the tools Copilot CLI 1.0.83 registers for a Claudian session', () => {
    expect([...COPILOT_BUILTIN_TOOL_CATALOG].sort()).toEqual(CAPTURED_BUILTIN_TOOLS);
  });

  it('names the task and factory families the provider does not support', () => {
    expect([...COPILOT_UNSUPPORTED_BUILTIN_TOOLS].sort()).toEqual(CAPTURED_UNSUPPORTED_TOOLS);
  });

  it('splits the catalog into read-only, mutating, and unsupported groups without overlap', () => {
    const groups = [
      COPILOT_READ_ONLY_BUILTIN_TOOLS,
      COPILOT_MUTATING_BUILTIN_TOOLS,
      COPILOT_UNSUPPORTED_BUILTIN_TOOLS,
    ];
    const names = groups.flatMap(group => [...group]);

    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(CAPTURED_BUILTIN_TOOLS);
  });

  it('carries no name the capture did not contain', () => {
    for (const name of [
      ...COPILOT_READ_ONLY_BUILTIN_TOOLS,
      ...COPILOT_MUTATING_BUILTIN_TOOLS,
      ...COPILOT_UNSUPPORTED_BUILTIN_TOOLS,
    ]) {
      expect(CAPTURED_BUILTIN_TOOLS).toContain(name);
    }
  });

  it('qualifies read-only filters by source so a same-named tool cannot match', () => {
    for (const filter of COPILOT_READ_ONLY_TOOL_FILTERS) {
      expect(filter.startsWith('builtin:')).toBe(true);
    }
  });

  /**
   * An allow-list is narrowed by source so an unknown same-named tool is not permitted; a
   * deny-list is written bare for the opposite reason, so the same name from another
   * source is refused too.
   */
  it('leaves unsupported filters unqualified so every source is denied', () => {
    expect([...COPILOT_UNSUPPORTED_TOOL_FILTERS].sort()).toEqual(CAPTURED_UNSUPPORTED_TOOLS);
  });

  it('treats only read and url as permission kinds that change nothing', () => {
    expect([...COPILOT_READ_ONLY_PERMISSION_KINDS].sort()).toEqual(['read', 'url']);
  });
});
