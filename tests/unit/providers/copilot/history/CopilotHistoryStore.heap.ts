// Standalone regression: node --max-old-space-size=64 --require tsx/cjs tests/unit/providers/copilot/history/CopilotHistoryStore.heap.ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { CopilotHistoryStore } from '@/providers/copilot/history/CopilotHistoryStore';
import { resolveCopilotHomeDirectory } from '@/providers/copilot/runtime/CopilotRuntimeEnvironment';

async function main(): Promise<void> {
  const scratch = path.resolve('.context');
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(path.join(scratch, 'copilot-history-heap-'));
  Object.assign(process.env, { HOME: home, LOCALAPPDATA: home, XDG_STATE_HOME: home });
  try {
    const sessionId = 'synthetic-session';
    const vault = path.join(home, 'vault');
    const directory = path.join(resolveCopilotHomeDirectory(vault), 'session-state', sessionId);
    await mkdir(directory, { recursive: true });
    const record = (type: string, data: Record<string, unknown>, checkpoint = false) =>
      JSON.stringify({ type, data, checkpoint, id: type, timestamp: '2026-01-01T00:00:00Z' }) + '\n';
    const discarded = record('system.message', { content: 'x'.repeat(64 * 1024) }).repeat(64);
    const expected: string[] = [];
    for (let i = 1; i <= 32; i++) {
      const message = `Visible message from numbered journal ${i}`;
      const header = i === 1 ? '' : record('session.journal_link', { previousFile: `events.${i - 1}.jsonl`, sessionId, version: 1 });
      const file = i === 32 ? 'events.jsonl' : `events.${i}.jsonl`;
      await writeFile(path.join(directory, file), header + record('session.start', { sessionId }, i !== 1)
        + discarded + record('user.message', { content: message }));
      expected.push(message);
    }
    const messages = await new CopilotHistoryStore().load(sessionId, vault);
    assert.deepEqual(messages.map(message => message.content), expected);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

void main();
