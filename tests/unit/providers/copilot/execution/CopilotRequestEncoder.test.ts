import type { ProviderExecutionRequest } from '@/core/execution';
import {
  describeUnsupportedInput,
  encodeAdditionalDirectories,
  encodePrompt,
  encodeReasoningEffort,
  encodeSessionIdentity,
  encodeSystemMessage,
  encodeToolSelection,
} from '@/providers/copilot/execution/CopilotRequestEncoder';
import { isCopilotReasoningEffort } from '@/providers/copilot/models';

function createRequest(
  overrides: Partial<ProviderExecutionRequest> = {},
): ProviderExecutionRequest {
  return {
    configuration: {
      model: 'copilot/gpt-5',
      systemInstructions: { kind: 'provider-default' },
    },
    input: [{ text: 'Summarize this note.', type: 'text' }],
    signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
    ...overrides,
  } as ProviderExecutionRequest;
}

describe('encodeToolSelection', () => {
  it('denies every tool for a passive turn', () => {
    expect(encodeToolSelection({ kind: 'passive' })).toEqual({ availableTools: [] });
  });

  /**
   * Named independently of the provider catalog: these are the tools Copilot CLI 1.0.83
   * registers for a Claudian session that cannot change anything.
   */
  it('allows only the read-only builtins for a read-only turn', () => {
    const selection = encodeToolSelection({ kind: 'read-only' });

    expect([...(selection.availableTools ?? [])].sort()).toEqual([
      'builtin:ask_user',
      'builtin:glob',
      'builtin:grep',
      'builtin:list_bash',
      'builtin:read_bash',
      'builtin:view',
      'builtin:web_fetch',
    ]);
    expect(selection.excludedTools).toBeUndefined();
  });

  it('leaves every mutating builtin out of a read-only turn', () => {
    const allowed = new Set(encodeToolSelection({ kind: 'read-only' }).availableTools ?? []);

    for (const name of [
      'bash',
      'create',
      'edit',
      'factories_manage',
      'run_factory',
      'sql',
      'stop_bash',
      'task',
      'write_agent',
    ]) {
      expect(allowed.has(`builtin:${name}`)).toBe(false);
    }
  });

  it('denies a tool the captured catalog does not know about', () => {
    const allowed = new Set(encodeToolSelection({ kind: 'read-only' }).availableTools ?? []);

    for (const name of ['builtin:powershell', 'builtin:apply_patch', 'mcp:anything']) {
      expect(allowed.has(name)).toBe(false);
    }
  });

  /**
   * An allow-list names tools in provider-neutral terms, so it is qualified here the way
   * the read-only list is: to `builtin:`, so an MCP or custom tool that happens to share
   * a name is not permitted by a caller that only meant the builtin.
   */
  it('qualifies an explicit allow-list to the builtins it names, deduplicated', () => {
    expect(encodeToolSelection({
      kind: 'allow-list',
      names: ['view', 'builtin:view', ' glob '],
    })).toEqual({ availableTools: ['builtin:view', 'builtin:glob'] });
  });

  /**
   * A name the captured catalog does not know is a tool Claudian cannot say anything
   * about, and a name qualified to another source is not the builtin the allow-list
   * meant. Both are dropped rather than handed to the CLI to interpret.
   */
  it('drops an allow-listed name the catalog does not know', () => {
    expect(encodeToolSelection({
      kind: 'allow-list',
      names: ['view', 'powershell', 'mcp:view', 'custom:anything', '', '   '],
    })).toEqual({ availableTools: ['builtin:view'] });
  });

  /**
   * The agent and factory families are excluded from every policy, so naming one in an
   * allow-list does not make it available either.
   */
  it('never allow-lists a tool from the families Claudian renders nothing for', () => {
    const selection = encodeToolSelection({
      kind: 'allow-list',
      names: [
        'factories_manage',
        'list_agents',
        'read_agent',
        'run_factory',
        'task',
        'write_agent',
        'builtin:task',
        'view',
      ],
    });

    expect(selection).toEqual({ availableTools: ['builtin:view'] });
  });

  /** An allow-list naming nothing Copilot offers denies every tool rather than all of them. */
  it('denies every tool when an allow-list names none Copilot offers', () => {
    expect(encodeToolSelection({ kind: 'allow-list', names: ['powershell'] }))
      .toEqual({ availableTools: [] });
  });

  /**
   * The allow-list is stated for every policy, because omitting it is what asks the CLI
   * for its own ambient defaults. A policy that restricts nothing says so as the widest
   * pattern the SDK defines for one source — every builtin, and nothing an MCP server or
   * a custom agent registered — rather than by saying nothing at all.
   */
  it.each(['provider-default', 'unrestricted'] as const)(
    'allows every builtin and no other source for a %s turn',
    (kind) => {
      expect(encodeToolSelection({ kind }).availableTools).toEqual(['builtin:*']);
    },
  );

  it('never grants a blanket allow, even when the policy is unrestricted', () => {
    for (const kind of ['provider-default', 'unrestricted'] as const) {
      expect(JSON.stringify(encodeToolSelection({ kind }))).not.toContain('allow-all');
    }
  });

  /**
   * Claudian surfaces no subagent and no factory: `capabilities.ts` advertises neither,
   * there is no adapter for either, and nothing renders what they would produce. A turn
   * that started one would run work the user can neither watch nor stop, so the families
   * are excluded from the policies that otherwise leave the CLI's own defaults alone.
   *
   * The names are written out rather than derived from the provider catalog, so a change
   * to what Claudian believes the CLI offers has to be re-stated deliberately.
   */
  it.each(['provider-default', 'unrestricted'] as const)(
    'excludes the task and factory families from a %s turn',
    (kind) => {
      expect([...(encodeToolSelection({ kind }).excludedTools ?? [])].sort()).toEqual([
        'factories_manage',
        'list_agents',
        'read_agent',
        'run_factory',
        'task',
        'write_agent',
      ]);
    },
  );

  /**
   * An exclusion is a deny rule, so it is written bare — the form the SDK matches across
   * every source — rather than qualified to `builtin:`, which would leave a same-named
   * MCP or custom tool available.
   */
  it.each(['provider-default', 'unrestricted'] as const)(
    'denies the excluded families across every tool source for a %s turn',
    (kind) => {
      for (const name of encodeToolSelection({ kind }).excludedTools ?? []) {
        expect(name).not.toContain(':');
      }
    },
  );

  it.each(['provider-default', 'unrestricted'] as const)(
    'keeps the main-agent tools available to a %s turn',
    (kind) => {
      const excluded = new Set(encodeToolSelection({ kind }).excludedTools ?? []);

      for (const name of [
        'ask_user',
        'bash',
        'create',
        'edit',
        'glob',
        'grep',
        'list_bash',
        'read_bash',
        'sql',
        'stop_bash',
        'view',
        'web_fetch',
      ]) {
        expect(excluded.has(name)).toBe(false);
      }
    },
  );

  it('leaves the task and factory families out of a read-only turn', () => {
    const allowed = new Set(encodeToolSelection({ kind: 'read-only' }).availableTools ?? []);

    for (const name of [
      'factories_manage',
      'list_agents',
      'read_agent',
      'run_factory',
      'task',
      'write_agent',
    ]) {
      expect(allowed.has(`builtin:${name}`)).toBe(false);
      expect(allowed.has(name)).toBe(false);
    }
  });
});

describe('encodeSystemMessage', () => {
  it('replaces the CLI prompt for explicit instructions', () => {
    expect(encodeSystemMessage(createRequest({
      configuration: {
        model: 'copilot/gpt-5',
        systemInstructions: { instructions: 'Only answer in French.', kind: 'explicit' },
      },
    }), {})).toEqual({ content: 'Only answer in French.', mode: 'replace' });
  });

  it('appends the shared Claudian prompt for the provider-default path', () => {
    const message = encodeSystemMessage(createRequest(), {
      userName: 'Ada',
      vaultPath: '/vault',
    });

    expect(message.mode).toBe('append');
    expect(message.content).toContain('/vault');
    expect(message.content).toContain('Ada');
  });

  it('includes the requested dynamic sections', () => {
    const message = encodeSystemMessage(createRequest({
      configuration: {
        model: 'copilot/gpt-5',
        systemInstructions: {
          dynamicSections: ['## Active Note\n\nnote.md'],
          kind: 'provider-default',
        },
      },
    }), { vaultPath: '/vault' });

    expect(message.content).toContain('## Active Note');
  });
});

describe('encodePrompt', () => {
  it('joins text blocks and ignores non-text input', () => {
    expect(encodePrompt(createRequest({
      input: [
        { text: 'First line', type: 'text' },
        { image: { data: '', id: 'i', mediaType: 'image/png', name: 'a', size: 0, source: 'file' }, type: 'image' },
        { text: 'Second line', type: 'text' },
      ],
    } as Partial<ProviderExecutionRequest>))).toBe('First line\nSecond line');
  });

  it('returns an empty prompt when there is no text', () => {
    expect(encodePrompt(createRequest({ input: [] }))).toBe('');
  });

  /**
   * The turn carries the note it was sent from, and the selection the user had open,
   * exactly as every other provider does: the CLI reads the vault itself, but only a
   * prompt says which note the question is about.
   */
  it('carries the linked note and the editor selection into the prompt', () => {
    const prompt = encodePrompt(createRequest({
      context: {
        editorSelection: {
          mode: 'selection',
          notePath: 'Notes/Daily.md',
          selectedText: 'the selected sentence',
        },
        linkedContent: { path: 'Notes/Daily.md' },
      },
    }));

    expect(prompt).toContain('Summarize this note.');
    expect(prompt).toContain('Notes/Daily.md');
    expect(prompt).toContain('the selected sentence');
  });

  it('carries the browser and canvas selections into the prompt', () => {
    const prompt = encodePrompt(createRequest({
      context: {
        browserSelection: {
          selectedText: 'a quoted page',
          source: 'browser',
          title: 'Page',
          url: 'https://example.test',
        },
        canvasSelection: { canvasPath: 'Boards/Plan.canvas', nodeIds: ['node-1'] },
      },
    } as Partial<ProviderExecutionRequest>));

    expect(prompt).toContain('https://example.test');
    expect(prompt).toContain('Boards/Plan.canvas');
  });
});

describe('describeUnsupportedInput', () => {
  /**
   * `COPILOT_PROVIDER_CAPABILITIES` advertises no image support and the CLI receives a
   * text prompt, so an attached image cannot reach the turn. Dropping it silently would
   * answer a question about a picture the model never saw.
   */
  it('names the images a turn could not send', () => {
    const notice = describeUnsupportedInput(createRequest({
      input: [
        { text: 'What is in these?', type: 'text' },
        { image: { data: 'x', id: 'i1', mediaType: 'image/png', name: 'chart.png', size: 1, source: 'file' }, type: 'image' },
        { image: { data: 'y', id: 'i2', mediaType: 'image/png', name: 'photo.png', size: 1, source: 'paste' }, type: 'image' },
      ],
    } as Partial<ProviderExecutionRequest>));

    expect(notice).toContain('chart.png');
    expect(notice).toContain('photo.png');
    expect(notice).toContain('Copilot');
  });

  it('says nothing about a turn whose input is entirely text', () => {
    expect(describeUnsupportedInput(createRequest())).toBeNull();
  });
});

describe('encodeAdditionalDirectories', () => {
  it('merges external context paths with workspace roots and deduplicates', () => {
    expect(encodeAdditionalDirectories(createRequest({
      configuration: {
        externalWorkspaceRoots: ['/repo', '/notes'],
        model: 'copilot/gpt-5',
        systemInstructions: { kind: 'provider-default' },
      },
      context: { externalContextPaths: ['/notes', ' '] },
    }))).toEqual(['/notes', '/repo']);
  });
});

describe('encodeReasoningEffort', () => {
  it('passes through an effort the SDK union accepts', () => {
    expect(encodeReasoningEffort(createRequest({
      configuration: {
        model: 'copilot/gpt-5',
        reasoning: ' high ',
        systemInstructions: { kind: 'provider-default' },
      },
    }), isCopilotReasoningEffort)).toBe('high');
  });

  it('drops an effort the SDK union does not declare', () => {
    expect(encodeReasoningEffort(createRequest({
      configuration: {
        model: 'copilot/gpt-5',
        reasoning: 'ultra',
        systemInstructions: { kind: 'provider-default' },
      },
    }), isCopilotReasoningEffort)).toBeUndefined();
  });
});

describe('encodeSessionIdentity', () => {
  const base = {
    additionalDirectories: ['/repo'],
    systemMessage: { content: 'prompt', mode: 'append' } as const,
    toolSelection: { availableTools: ['builtin:read'] },
    workingDirectory: '/vault',
  };

  it('is stable across argument ordering', () => {
    expect(encodeSessionIdentity({
      ...base,
      additionalDirectories: ['/repo', '/notes'],
    })).toBe(encodeSessionIdentity({
      ...base,
      additionalDirectories: ['/notes', '/repo'],
    }));
  });

  it('changes when a session-bound input changes', () => {
    const identity = encodeSessionIdentity(base);

    expect(encodeSessionIdentity({ ...base, workingDirectory: '/other' })).not.toBe(identity);
    expect(encodeSessionIdentity({
      ...base,
      systemMessage: { content: 'other', mode: 'append' },
    })).not.toBe(identity);
    expect(encodeSessionIdentity({
      ...base,
      toolSelection: { availableTools: [] },
    })).not.toBe(identity);
  });
});
