import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ProviderSessionLifecycle } from '@/core/execution';
import type { CopilotSdkClient } from '@/providers/copilot/sdk/CopilotSdkPort';
import { copilotSdkRuntime } from '@/providers/copilot/sdk/CopilotSdkRuntime';

import { createDeferred } from '../../../unit/providers/copilot/sdk/FakeCopilotSdkRuntime';

const cli = path.resolve(__dirname, '../../../fixtures/copilot/protocol4-cli.js');
const auxiliaryTimeout = expect.objectContaining({ category: 'transport', message: expect.stringContaining('10 minutes') });

it.each<[ProviderSessionLifecycle, string, number, unknown]>([
  ['persistent', 'completion RPC', 90 * 24 * 60 * 60 * 1000, 'completed'],
  ['persistent', 'event fallback', 90 * 24 * 60 * 60 * 1000, 'completed'],
  ['ephemeral', 'completion RPC', 600_000, auxiliaryTimeout],
])('waits for %s turns according to their lifecycle (%s)', async (lifecycle, prompt, elapsedMs, expected) => {
  const home = await mkdtemp(path.join(tmpdir(), 'claudian-turn-deadline-'));
  const asked = createDeferred();
  const answer = createDeferred();
  let client: CopilotSdkClient | undefined;
  try {
    client = await copilotSdkRuntime.createClient({
      baseDirectory: home, cliPath: cli, environment: { HOME: home }, workingDirectory: home,
    });
    const session = await client.createSession({
      lifecycle, availableTools: [], model: 'fixture', workingDirectory: home,
      systemMessage: { mode: 'replace', content: 'Fixture.' }, onEvent: () => {},
      onPermissionRequest: async () => ({ kind: 'reject' }),
      onUserInputRequest: async () => {
        asked.resolve();
        await answer.promise;
        return { answer: 'Continue', wasFreeform: true };
      },
    });
    // Cross several SDK long-timer chunks without faking the fixture CLI's stdio.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate'] });
    let finished = false;
    const result = session.send(prompt).then(() => 'completed', (error: unknown) => error)
      .finally(() => { finished = true; });
    await asked.promise;
    await jest.advanceTimersByTimeAsync(elapsedMs);
    expect(finished).toBe(lifecycle === 'ephemeral');
    answer.resolve();
    expect(await result).toEqual(expected);
  } finally {
    answer.resolve();
    jest.useRealTimers();
    try { await client?.forceStop(); } finally { await rm(home, { force: true, recursive: true }); }
  }
});
