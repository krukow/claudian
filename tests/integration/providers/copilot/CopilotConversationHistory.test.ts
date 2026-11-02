import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { App } from 'obsidian';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { computeConversationInputDigest } from '@/core/bootstrap/ConversationInputLedgerStorage';
import { ConversationPersistenceStore } from '@/core/bootstrap/ConversationPersistenceStore';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { registerBuiltInProviders } from '@/providers';
import { resolveCopilotHomeDirectory } from '@/providers/copilot/runtime/CopilotRuntimeEnvironment';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';

describe('Copilot history after reloading Claudian metadata', () => {
  let directory: string;
  let vaultPath: string;
  let transcriptPath: string;
  let transcript: string;
  let persistence: ConversationPersistenceStore;
  let repository: ConversationRepository;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'claudian-copilot-reload-'));
    jest.replaceProperty(process, 'env', {
      ...process.env,
      HOME: directory,
      LOCALAPPDATA: directory,
      XDG_STATE_HOME: directory,
    });
    vaultPath = path.join(directory, 'vault');
    transcriptPath = path.join(
      resolveCopilotHomeDirectory(vaultPath),
      'session-state', 'copilot-session-1', 'events.jsonl',
    );
    transcript = await readFile(path.join(__dirname, '../../../fixtures/copilot/history-tools.jsonl'), 'utf8');
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, transcript);

    const files = new Map<string, string>();
    const folders = new Set<string>();
    const app = new App();
    Object.assign(app.vault.adapter, {
      exists: async (name: string) => files.has(name) || folders.has(name),
      read: async (name: string) => {
        const content = files.get(name);
        if (content === undefined) throw new Error(`Missing fixture file: ${name}`);
        return content;
      },
      write: async (name: string, content: string) => { files.set(name, content); },
      mkdir: async (name: string) => { folders.add(name); },
    });
    persistence = new ConversationPersistenceStore(new VaultFileAdapter(app), `device-${'c'.repeat(64)}`);
    await persistence.saveMetadata({
      id: 'saved-chat',
      providerId: 'copilot',
      title: 'Garden notes',
      createdAt: 1,
      lastActivityAt: 1,
      sessionId: 'copilot-session-1',
      selectedModel: 'copilot/gpt-5.3-codex',
    });
    await persistence.saveInputLedger('saved-chat', {
      schemaVersion: 1,
      conversationId: 'saved-chat',
      records: [{
        schemaVersion: 1,
        id: 'accepted-input',
        state: 'accepted',
        userTurnOrdinal: 1,
        timestamp: Date.parse('2026-11-02T07:00:01.000Z'),
        rawDisplayText: 'Summarize this note.',
        canonicalText: 'Summarize this note.',
        context: { linkedContent: { path: 'garden.md' } },
        images: [],
        contentDigest: computeConversationInputDigest({ visibleText: 'Summarize this note.', images: [] }),
      }],
    });

    registerBuiltInProviders();
    const settings = {};
    updateCopilotProviderSettings(settings, {
      enabled: true,
      discoveredModels: [{
        rawId: 'gpt-5.3-codex',
        displayName: 'Codex',
        reasoningEfforts: [],
        supportsReasoning: false,
        supportsVision: false,
      }],
      visibleModels: ['gpt-5.3-codex'],
    });
    repository = new ConversationRepository({
      getSettings: () => settings,
      getVaultPath: () => vaultPath,
      persistence,
      onConversationDeleted: async () => {},
    });
    const record = await persistence.metadataReader.load('saved-chat');
    if (!record) throw new Error('Saved metadata is missing.');
    await repository.adoptMetadataConversations([{
      conversation: {
        ...record.metadata,
        providerId: 'copilot',
        sessionId: record.metadata.sessionId ?? null,
        messages: [],
      },
      needsMigration: record.needsMigration,
      source: record.source,
    }]);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('loads native messages on history selection and restores accepted input context', async () => {
    expect(await persistence.metadataReader.loadMetadata('saved-chat')).not.toHaveProperty('messages');
    expect(repository.getSync('saved-chat')?.messages).toEqual([]);

    const conversation = await repository.switchTo('saved-chat');

    expect(conversation?.messages.map(message => message.content)).toEqual([
      'Summarize this note.',
      'Let me read it.The note describes a garden.',
      'What grows there?',
      'Roses and mint.',
    ]);
    expect(conversation?.messages[0]).toMatchObject({
      displayContent: 'Summarize this note.',
      userMessageId: 'user-1',
      executionInput: {
        canonicalText: 'Summarize this note.',
        context: { linkedContent: { path: 'garden.md' } },
      },
    });
    expect((await repository.switchTo('saved-chat'))?.messages).toHaveLength(4);
    expect(await readFile(transcriptPath, 'utf8')).toBe(transcript);
    expect((await persistence.metadataReader.loadMetadata('saved-chat'))?.sessionId)
      .toBe('copilot-session-1');
  });

  it('retries failed hydration without deleting or resetting the conversation', async () => {
    await rm(transcriptPath);
    await expect(repository.switchTo('saved-chat')).rejects.toThrow('Could not read');
    expect(repository.getSync('saved-chat')?.sessionId).toBe('copilot-session-1');
    expect(await persistence.isDeleted('saved-chat')).toBe(false);

    await writeFile(transcriptPath, transcript);
    expect((await repository.switchTo('saved-chat'))?.messages).toHaveLength(4);
  });
});
