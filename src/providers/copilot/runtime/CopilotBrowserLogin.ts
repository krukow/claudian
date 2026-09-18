import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ManagedStdioProcess } from '@/core/process/ManagedStdioProcess';

import type { CopilotClientIdentity } from '../sdk/CopilotClientFactory';
import { isAbsoluteCopilotPath } from './CopilotAbsolutePath';

const LOGIN_TIMEOUT_MS = 300_000;
const HELP_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT = 32_768;
const HELP_FAILURE_GUIDANCE =
  'Check the installed Copilot CLI version and path. Sign-in was not started.';

export class CopilotBrowserLogin {
  constructor(private readonly timeoutMs = LOGIN_TIMEOUT_MS) {}

  async signIn(
    identity: CopilotClientIdentity,
    signal: AbortSignal,
    onAuthorizationUrl?: (url: string) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    if (!isAbsoluteCopilotPath(identity.cliPath) || !isAbsoluteCopilotPath(identity.baseDirectory)) {
      throw new Error('Copilot sign-in requires an absolute CLI path and a private state directory.');
    }
    await fs.mkdir(identity.baseDirectory, { recursive: true, mode: 0o700 });
    const help = await runLoginCommand(identity, 'check-support', signal, HELP_TIMEOUT_MS);
    if (!help.includes('--web-flow')) {
      throw new Error('Update the installed Copilot CLI to a version that supports browser sign-in.');
    }
    await requireSecureCredentialStorage(identity.baseDirectory);
    signal.throwIfAborted();
    await runLoginCommand(
      identity, 'sign-in', signal, this.timeoutMs, onAuthorizationUrl,
    );
  }
}

async function requireSecureCredentialStorage(home: string): Promise<void> {
  const settingsPath = path.join(home, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('The Copilot state settings must contain a JSON object.');
    }
    settings = value as Record<string, unknown>;
  } catch (error) {
    if (!isMissing(error)) {
      throw new Error('Could not read Copilot state settings. Sign-in was not started.', { cause: error });
    }
  }
  const temporary = path.join(home, `.claudian-login-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify({ ...settings, storeTokenPlaintext: false }), {
      mode: 0o600,
    });
    await fs.rename(temporary, settingsPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function runLoginCommand(
  identity: CopilotClientIdentity,
  phase: 'check-support' | 'sign-in',
  signal: AbortSignal,
  timeoutMs: number,
  onAuthorizationUrl?: (url: string) => void,
): Promise<string> {
  signal.throwIfAborted();
  const checkingSupport = phase === 'check-support';
  const args = ['login', checkingSupport ? '--help' : '--web-flow'];
  const failureMessage = checkingSupport
    ? `Could not check Copilot browser sign-in support. ${HELP_FAILURE_GUIDANCE}`
    : 'Copilot sign-in did not complete. Retry browser approval and check that your '
      + 'system credential store is available. Plaintext credential storage is not enabled.';
  const isScript = identity.cliPath.endsWith('.js');
  const proc = new ManagedStdioProcess({
    args: isScript ? [identity.cliPath, ...args] : args,
    command: isScript ? process.execPath : identity.cliPath,
    cwd: identity.baseDirectory,
    env: {
      ...identity.environment,
      COPILOT_HOME: identity.baseDirectory,
      ...(isScript ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    stderrBufferLimit: 1_024,
  });
  let output = '';
  let authorizationUrl: string | null = null;
  let timer: number | undefined;
  let abort: (() => void) | undefined;
  const onData = (chunk: Buffer | string): void => {
    output = `${output}${chunk.toString()}`.slice(-OUTPUT_LIMIT);
    if (!onAuthorizationUrl || authorizationUrl) {
      return;
    }
    const candidate = output.match(
      /https:\/\/github\.com\/login\/oauth\/authorize\?[-A-Za-z0-9_.~!$&'()*+,;=:@%/?]+/,
    )?.[0];
    if (candidate && /[\r\n]/.test(output.slice(output.indexOf(candidate) + candidate.length))) {
      authorizationUrl = candidate;
      onAuthorizationUrl(candidate);
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason instanceof Error
        ? signal.reason
        : new Error('Copilot connection cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      timer = window.setTimeout(() => reject(new Error(
        checkingSupport
          ? `Checking Copilot browser sign-in support timed out. ${HELP_FAILURE_GUIDANCE}`
          : 'Copilot sign-in timed out. Select Connect Copilot to try again.',
      )), timeoutMs);
      proc.onError(() => reject(new Error(
        checkingSupport ? failureMessage : 'Could not launch Copilot sign-in. Check the CLI path.',
      )));
      proc.onClose(state => {
        if (state.code === 0) {
          resolve();
        } else {
          reject(new Error(failureMessage));
        }
      });
      proc.start();
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      // A non-TTY login refuses the CLI's optional plaintext-storage consent prompt.
      proc.stdin.end();
    });
    signal.throwIfAborted();
    return output;
  } finally {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
    if (abort) {
      signal.removeEventListener('abort', abort);
    }
    await proc.shutdown();
    if (proc.isStarted()) {
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onData);
    }
  }
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
