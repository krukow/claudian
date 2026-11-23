import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderConversationHistoryService } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import { CopilotConversationHistoryService } from '@/providers/copilot/history/CopilotConversationHistoryService';
import { resolveCopilotHomeDirectory } from '@/providers/copilot/runtime/CopilotRuntimeEnvironment';

function createConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    createdAt: 0,
    id: 'conversation-1',
    lastActivityAt: 0,
    messages: [],
    providerId: 'copilot',
    sessionId: 'copilot-session-1',
    title: 'Conversation',
    ...overrides,
  } as Conversation;
}

describe('CopilotConversationHistoryService', () => {
  const service = new CopilotConversationHistoryService();

  it('resolves the native session reference for Copilot conversations only', () => {
    expect(service.resolveSessionIdForConversation(createConversation()))
      .toBe('copilot-session-1');
    expect(service.resolveSessionIdForConversation(createConversation({ providerId: 'grok' })))
      .toBeNull();
    expect(service.resolveSessionIdForConversation(createConversation({ sessionId: null })))
      .toBeNull();
    expect(service.resolveSessionIdForConversation(null)).toBeNull();
  });

  it('does not claim to know whether a native session still exists', async () => {
    await expect(service.getConversationSessionAvailability(createConversation()))
      .resolves.toBe('unknown');
  });

  it('reports a conversation without a session reference as missing', async () => {
    await expect(service.getConversationSessionAvailability(
      createConversation({ sessionId: null }),
    )).resolves.toBe('missing');
  });

  it('resets rather than deletes when the runtime lost the session', async () => {
    const conversation = createConversation();

    await expect(service.resolveMissingConversationSession(
      conversation,
      '/vault',
      'copilot-session-1',
    )).resolves.toBe('reset');
    expect(conversation.sessionId).toBeNull();
  });

  /**
   * The runtime reports which session it lost. A report naming a session the conversation
   * no longer refers to is stale — it arrived after the conversation moved on — so the
   * reference it does hold is left alone.
   */
  it.each<[string, string | undefined, string | null]>([
    ['the report names another session', 'copilot-session-old', 'copilot-session-1'],
    ['no session was reported', undefined, 'copilot-session-1'],
  ])('preserves the reference when %s', async (_label, missingId, expected) => {
    const conversation = createConversation();

    await expect(service.resolveMissingConversationSession(
      conversation,
      '/vault',
      missingId,
    )).resolves.toBe('preserve');
    expect(conversation.sessionId).toBe(expected);
  });

  it('preserves a conversation that refers to no native session', async () => {
    const conversation = createConversation({ sessionId: null });

    await expect(service.resolveMissingConversationSession(
      conversation,
      '/vault',
      'copilot-session-1',
    )).resolves.toBe('preserve');
    expect(conversation.sessionId).toBeNull();
  });

  it('advertises no fork support, matching the capability contract', () => {
    expect(service.isPendingForkConversation()).toBe(false);
    expect(() => service.buildForkProviderState()).toThrow(/does not support forking/);
  });
});

describe('Copilot transcript restoration', () => {
  const service: ProviderConversationHistoryService = new CopilotConversationHistoryService();
  const sessionId = 'copilot-session-1';
  const timestamp = '2026-11-02T07:00:00.000Z';
  const record = (type: string, data: Record<string, unknown>) =>
    JSON.stringify({ type, data, id: randomUUID(), timestamp, parentId: null });
  const copied = (line: string) => JSON.stringify({ ...JSON.parse(line), checkpoint: true });
  const link = (previousFile: string) => record('session.journal_link', { version: 1, sessionId, previousFile });
  const start = record('session.start', { sessionId, version: 1 });
  const checkpointStart = copied(start);
  const journal = (...lines: string[]) => `${lines.join('\n')}\n`;
  let directory: string;
  let vaultPath: string;
  let transcriptPath: string;
  let transcript: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'claudian-copilot-history-'));
    jest.replaceProperty(process, 'env', {
      ...process.env,
      HOME: directory,
      LOCALAPPDATA: directory,
      XDG_STATE_HOME: directory,
    });
    vaultPath = path.join(directory, 'vault');
    transcriptPath = path.join(
      resolveCopilotHomeDirectory(vaultPath),
      'session-state',
      'copilot-session-1',
      'events.jsonl',
    );
    // Native event shapes captured from Claudian's CLI store; all content is synthetic.
    transcript = await readFile(
      path.join(__dirname, '../../../../fixtures/copilot/history.jsonl'),
      'utf8',
    );
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, transcript);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('restores a metadata-only conversation from its vault-owned native transcript without changing it', async () => {
    const conversation = createConversation();

    await service.hydrateConversationHistory(conversation, vaultPath);

    expect(conversation.messages).toMatchObject([
      {
        role: 'user',
        content: 'Summarize this note.',
        userMessageId: 'user-1',
        timestamp: Date.parse('2026-11-02T07:00:01.000Z'),
      },
      {
        role: 'assistant',
        content: 'The note describes a garden.',
        assistantMessageId: 'assistant-1',
        timestamp: Date.parse('2026-11-02T07:00:03.000Z'),
      },
    ]);
    expect(conversation.sessionId).toBe('copilot-session-1');
    expect(await readFile(transcriptPath, 'utf8')).toBe(transcript);
  });

  it('restores ordered reasoning, tool results, and resumed turns without internal or duplicate messages', async () => {
    const nativeHistory = await readFile(
      path.join(__dirname, '../../../../fixtures/copilot/history-tools.jsonl'),
      'utf8',
    );
    await writeFile(transcriptPath, nativeHistory);
    const conversation = createConversation();

    await service.hydrateConversationHistory(conversation, vaultPath);

    expect(conversation.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'Summarize this note.'],
      ['assistant', 'Let me read it.The note describes a garden.'],
      ['user', 'What grows there?'],
      ['assistant', 'Roses and mint.'],
    ]);
    expect(conversation.messages[1].contentBlocks).toEqual([
      { type: 'thinking', content: 'I need the note first.' },
      { type: 'text', content: 'Let me read it.' },
      { type: 'tool_use', toolId: 'tool-1' },
      { type: 'tool_use', toolId: 'tool-2' },
      { type: 'text', content: 'The note describes a garden.' },
    ]);
    expect(conversation.messages[1].toolCalls).toMatchObject([
      { id: 'tool-1', name: 'view', input: { path: 'garden.md' }, status: 'completed', result: 'The garden has roses and mint.' },
      { id: 'tool-2', name: 'view', input: { path: 'missing.md' }, status: 'error', result: 'File not found.' },
    ]);
    expect(conversation.messages[3].contentBlocks).toEqual([
      { type: 'thinking', content: 'Use the note\'s plant list.' },
      { type: 'text', content: 'Roses and mint.' },
    ]);
    expect(await readFile(transcriptPath, 'utf8')).toBe(nativeHistory);
  });

  it('projects only original events across linked journals, including a tool completed after rotation', async () => {
    const session = path.dirname(transcriptPath);
    const question = record('user.message', { content: 'Check the note.' });
    const resume = record('session.resume', { eventCount: 6, resumeTime: timestamp });
    const answer = record('assistant.message', { messageId: 'result', content: 'Found mint.' });
    const root = journal(
      start, question,
      record('assistant.message', { messageId: 'answer', content: 'Checking.' }),
      record('tool.execution_start', { toolName: 'view', toolCallId: 'read-note', arguments: {} }),
    );
    const middle = journal(
      link('events.2.jsonl'), checkpointStart,
      copied(question),
      record('tool.execution_complete', { toolCallId: 'read-note', success: true, result: { content: 'Mint.' } }),
      resume, answer,
    );
    const head = journal(
      link('events.10.jsonl'),
      copied(resume), copied(answer),
      record('user.message', { content: 'Thanks.' }),
    );
    await writeFile(path.join(session, 'events.2.jsonl'), root);
    await writeFile(path.join(session, 'events.10.jsonl'), middle);
    await writeFile(path.join(session, 'events.3.jsonl'), 'unlinked archive');
    await writeFile(transcriptPath, head);
    const conversation = createConversation();

    await service.hydrateConversationHistory(conversation, vaultPath);

    expect(conversation.messages.map(({ role, content }) => [role, content])).toEqual([
      ['user', 'Check the note.'], ['assistant', 'Checking.Found mint.'], ['user', 'Thanks.'],
    ]);
    expect(conversation.messages[1].toolCalls).toMatchObject([
      { id: 'read-note', status: 'completed', result: 'Mint.' },
    ]);
    expect(await readFile(path.join(session, 'events.2.jsonl'), 'utf8')).toBe(root);
    expect(await readFile(path.join(session, 'events.10.jsonl'), 'utf8')).toBe(middle);
    expect(await readFile(transcriptPath, 'utf8')).toBe(head);
  });

  it.each([
    ['missing predecessor', link('events.1.jsonl'), undefined, /Could not read/],
    ['wrong link owner', link('events.1.jsonl').replace(sessionId, 'other'), undefined, /link/],
    ['wrong link version', record('session.journal_link', { sessionId, version: 4, previousFile: 'events.1.jsonl' }), undefined, /link/],
    ['checkpoint link', copied(link('events.1.jsonl')), undefined, /link/],
    ['noncanonical name', link('events.01.jsonl'), undefined, /link/],
    ['path instead of name', link('../other/events.1.jsonl'), undefined, /link/],
    ['number outside u64', link('events.18446744073709551616.jsonl'), undefined, /link/],
    ['misplaced link', journal(record('session.start', { sessionId }), link('events.1.jsonl')), undefined, /first record/],
    ['cycle', link('events.1.jsonl'), journal(link('events.1.jsonl'), checkpointStart), /link/],
    ['wrong root owner', link('events.1.jsonl'), journal(record('session.start', { sessionId: 'other' })), /selected session/],
    ['incomplete archive', link('events.1.jsonl'), record('session.start', { sessionId }), /Incomplete/],
  ] as const)('rejects %s without publishing partial history', async (_label, header, archive, error) => {
    await writeFile(transcriptPath, journal(header, checkpointStart));
    if (archive !== undefined) await writeFile(path.join(path.dirname(transcriptPath), 'events.1.jsonl'), archive);
    const conversation = createConversation();
    await expect(service.hydrateConversationHistory(conversation, vaultPath)).rejects.toThrow(error);
    expect(conversation.messages).toEqual([]);
  });

  it.each([
    ['missing header', ''],
    ['unmarked header', journal(record('session.start', { sessionId }))],
    ['wrong header type', journal(copied(record('user.message', { content: 'Replay only.' })))],
    ['wrong session', journal(copied(record('session.start', { sessionId: 'other' })))],
    ['unterminated checkpoint', checkpointStart],
    ['checkpoint after original', journal(checkpointStart, record('user.message', { content: 'New.' }), checkpointStart)],
  ])('rejects a malformed replay checkpoint: %s', async (_label, suffix) => {
    await writeFile(path.join(path.dirname(transcriptPath), 'events.1.jsonl'), transcript);
    await writeFile(transcriptPath, journal(link('events.1.jsonl')) + suffix);
    await expect(service.hydrateConversationHistory(createConversation(), vaultPath))
      .rejects.toMatchObject({ name: 'CopilotHistoryError' });
  });

  it('preserves the live message projection instead of replacing it from disk', async () => {
    const messages: Conversation['messages'] = [
      { id: 'live-user', role: 'user', content: 'A new turn.', timestamp: 5 },
      { id: 'live-assistant', role: 'assistant', content: 'Still streaming', timestamp: 6 },
    ];
    const conversation = createConversation({ messages });

    await service.hydrateConversationHistory(conversation, vaultPath);

    expect(conversation.messages).toBe(messages);
  });

  it('does not publish an old transcript after the conversation changes its native binding', async () => {
    const conversation = createConversation();
    const hydration = service.hydrateConversationHistory(conversation, vaultPath);
    conversation.sessionId = 'copilot-session-2';

    await hydration;

    expect(conversation.sessionId).toBe('copilot-session-2');
    expect(conversation.messages).toEqual([]);
  });

  it('does not overwrite messages published while native history is being read', async () => {
    const conversation = createConversation();
    const hydration = service.hydrateConversationHistory(conversation, vaultPath);
    const liveMessages: Conversation['messages'] = [
      { id: 'live-user', role: 'user', content: 'New input.', timestamp: 5 },
    ];
    conversation.messages = liveMessages;

    await hydration;

    expect(conversation.messages).toBe(liveMessages);
  });

  it('keeps interrupted tool calls visible without presenting them as still running', async () => {
    const nativeHistory = await readFile(
      path.join(__dirname, '../../../../fixtures/copilot/history-tools.jsonl'),
      'utf8',
    );
    const interrupted = nativeHistory.split('\n').slice(0, 7).join('\n');
    await writeFile(transcriptPath, interrupted);
    const conversation = createConversation();

    await service.hydrateConversationHistory(conversation, vaultPath);

    expect(conversation.messages[1].toolCalls).toMatchObject([
      { id: 'tool-1', status: 'error', result: 'Tool execution did not complete.' },
      { id: 'tool-2', status: 'error', result: 'Tool execution did not complete.' },
    ]);
  });

  it.each([false, true])('restores standalone reasoning once when an aggregate follows: %s', async withAggregate => {
    const events = transcript.split('\n').filter(Boolean).slice(0, 3);
    events.push(JSON.stringify({
      type: 'assistant.reasoning',
      data: { reasoningId: 'reasoning-1', content: 'Consider the plants.' },
      id: 'reasoning-event',
      timestamp: '2026-11-02T07:00:02.500Z',
      parentId: 'turn-start-1',
    }));
    if (withAggregate) {
      events.push(JSON.stringify({
        type: 'assistant.message',
        data: { messageId: 'assistant-1', content: 'Roses.', reasoningText: 'Consider the plants.' },
        id: 'assistant-event-1',
        timestamp: '2026-11-02T07:00:03.000Z',
        parentId: 'reasoning-event',
      }));
    }
    await writeFile(transcriptPath, events.join('\n'));
    const conversation = createConversation();

    await service.hydrateConversationHistory(conversation, vaultPath);

    expect(conversation.messages[1].contentBlocks).toEqual([
      { type: 'thinking', content: 'Consider the plants.' },
      ...(withAggregate ? [{ type: 'text', content: 'Roses.' }] : []),
    ]);
  });

  it.each([
    { providerId: 'copilot' as const, sessionId: null },
    { providerId: 'claude' as const, sessionId: 'copilot-session-1' },
  ])('does not hydrate a conversation without a Copilot binding: %j', async binding => {
    const conversation = createConversation(binding);
    await service.hydrateConversationHistory(conversation, vaultPath);
    expect(conversation.messages).toEqual([]);
  });

  it.each([
    ['missing', null],
    ['malformed JSON', '{not json}\n'],
    ['wrong session', transcript => transcript.replace('copilot-session-1', 'another-session')],
    ['invalid message', transcript => transcript.replace('"content":"Summarize this note."', '"content":42')],
    ['empty file', ''],
  ] satisfies Array<[string, string | null | ((transcript: string) => string)]>)(
    'reports %s history without changing the conversation binding',
    async (_label, replacement) => {
      if (replacement === null) {
        await rm(transcriptPath);
      } else {
        await writeFile(transcriptPath, typeof replacement === 'function' ? replacement(transcript) : replacement);
      }
      const conversation = createConversation();

      await expect(service.hydrateConversationHistory(conversation, vaultPath))
        .rejects.toMatchObject({ name: 'CopilotHistoryError' });
      expect(conversation.messages).toEqual([]);
      expect(conversation.sessionId).toBe('copilot-session-1');
    },
  );

  it.each(['../outside', '/absolute', '..\\outside', 'C:\\outside'])(
    'refuses a session reference containing a path: %s',
    async sessionId => {
      await expect(service.hydrateConversationHistory(createConversation({ sessionId }), vaultPath))
        .rejects.toThrow('Invalid Copilot session reference');
    },
  );

  it('refuses a transcript symlink outside the vault-owned Copilot home', async () => {
    const outsidePath = path.join(directory, 'outside.jsonl');
    await writeFile(outsidePath, transcript);
    await rm(transcriptPath);
    await symlink(outsidePath, transcriptPath);

    await expect(service.hydrateConversationHistory(createConversation(), vaultPath))
      .rejects.toThrow('outside this vault\'s session store');
    expect(await readFile(outsidePath, 'utf8')).toBe(transcript);
  });

  it('refuses a transcript symlink to another session in the same vault-owned home', async () => {
    const sibling = path.join(path.dirname(transcriptPath), '../another-session/events.jsonl');
    await mkdir(path.dirname(sibling), { recursive: true });
    await writeFile(sibling, transcript);
    await rm(transcriptPath);
    await symlink(sibling, transcriptPath);

    await expect(service.hydrateConversationHistory(createConversation(), vaultPath))
      .rejects.toThrow('outside this vault\'s session store');
  });

  it('refuses a numbered journal symlink outside the selected session', async () => {
    const session = path.dirname(transcriptPath);
    const sibling = path.join(session, '../another-session/events.1.jsonl');
    await mkdir(path.dirname(sibling), { recursive: true });
    await writeFile(sibling, transcript);
    await symlink(sibling, path.join(session, 'events.1.jsonl'));
    await writeFile(transcriptPath, journal(link('events.1.jsonl'), checkpointStart));
    await expect(service.hydrateConversationHistory(createConversation(), vaultPath))
      .rejects.toThrow('outside this vault\'s session store');
  });

  it.each(['session', 'vault home'])('refuses an aliased %s directory', async component => {
    const selected = component === 'session' ? path.dirname(transcriptPath) : resolveCopilotHomeDirectory(vaultPath);
    const other = path.join(path.dirname(selected), 'another-owner');
    await rename(selected, other);
    await symlink(other, selected, 'dir');
    await expect(service.hydrateConversationHistory(createConversation(), vaultPath))
      .rejects.toThrow('outside this vault\'s session store');
  });

  it('uses the runtime-owned home, not provider configuration or another vault', async () => {
    const conversation = createConversation();
    await service.hydrateConversationHistory(conversation, vaultPath, {
      environment: { HOME: path.join(directory, 'untrusted'), COPILOT_HOME: directory },
    });
    expect(conversation.messages).toHaveLength(2);
    await expect(service.hydrateConversationHistory(
      createConversation(),
      path.join(directory, 'another-vault'),
    )).rejects.toThrow('Could not read');
  });
});
