import assert from 'node:assert/strict';
import test from 'node:test';

import { findProcessSpawnUsages } from './processSpawnDetector.mjs';

function reasons(source) {
  return findProcessSpawnUsages(source, 'sample.ts').map(usage => usage.reason);
}

test('a RegExp match is not process spawning', () => {
  assert.deepEqual(reasons("const match = /^copilot-(\\d+)$/.exec(sessionId);"), []);
  assert.deepEqual(reasons('const found = SESSION_PATTERN.exec(line)?.[1];'), []);
  assert.deepEqual(reasons('new RegExp(source).exec(text);'), []);
});

test('a method that only shares a name with a spawn API is not process spawning', () => {
  assert.deepEqual(reasons('await this.forkConversation(sourceSessionId);'), []);
  assert.deepEqual(reasons('await store.exec(statement);'), []);
  assert.deepEqual(reasons('const spawned = pool.spawn();'), []);
  assert.deepEqual(reasons("import { fork } from './conversationFork';\nfork(conversation);"), []);
});

test('importing child_process is process spawning', () => {
  for (const source of [
    "import { spawn } from 'child_process';",
    "import { execFile } from 'node:child_process';",
    "import * as childProcess from 'node:child_process';",
    "import childProcess from 'child_process';",
    "const { spawnSync } = require('child_process');",
    "const cp = require('node:child_process');",
    "const { exec } = await import('node:child_process');",
  ]) {
    assert.deepEqual(reasons(source), ["imports 'child_process'"], source);
  }
});

test('calling a child_process API through its import is process spawning', () => {
  assert.deepEqual(
    reasons("import { spawn } from 'node:child_process';\nspawn(cliPath, args);"),
    ["imports 'child_process'", 'calls spawn()'],
  );
  assert.deepEqual(
    reasons("import * as cp from 'node:child_process';\ncp.execFile(cliPath, args);"),
    ["imports 'child_process'", 'calls cp.execFile()'],
  );
  assert.deepEqual(
    reasons("const cp = require('child_process');\ncp.exec(command);"),
    ["imports 'child_process'", 'calls cp.exec()'],
  );
});

test('a cross-spawn import is process spawning', () => {
  assert.deepEqual(
    reasons("import spawn from 'cross-spawn';\nspawn(cliPath, args);"),
    ["imports 'cross-spawn'", 'calls spawn()'],
  );
});

test('a bare spawn call with no import is reported without an import reason', () => {
  assert.deepEqual(reasons('spawnSync(cliPath, args);'), ['calls spawnSync()']);
});

test('re-exporting child_process is process spawning', () => {
  for (const source of [
    "export { spawn } from 'node:child_process';",
    "export * from 'child_process';",
    "export { spawn as launch } from 'child_process';",
    "export * as childProcess from 'node:child_process';",
  ]) {
    assert.deepEqual(reasons(source), ["imports 'child_process'"], source);
  }
});

test('an import-equals require of child_process is process spawning', () => {
  assert.deepEqual(
    reasons("import cp = require('child_process');\ncp.spawn(command);"),
    ["imports 'child_process'", 'calls cp.spawn()'],
  );
});

test('reaching require through an object is process spawning', () => {
  assert.deepEqual(
    reasons("globalThis.require('child_process').spawn(command);"),
    ["imports 'child_process'"],
  );
});

/**
 * A specifier the gate cannot read could name anything, including `child_process`. It is
 * reported rather than resolved, because a gate that silently passes what it cannot read
 * is not a gate.
 */
test('a module specifier the gate cannot read is reported', () => {
  assert.deepEqual(
    reasons("const cp = require('child' + '_process');\ncp.spawn(command);"),
    ['requires a module specifier that cannot be read'],
  );
  assert.deepEqual(
    reasons('const loaded = await import(moduleName);'),
    ['requires a module specifier that cannot be read'],
  );
});

test('a static module specifier is read rather than reported', () => {
  assert.deepEqual(reasons("const sdk = await import('./copilotSdkModule');"), []);
  assert.deepEqual(reasons("export { CopilotClient } from '@github/copilot-sdk';"), []);
});
