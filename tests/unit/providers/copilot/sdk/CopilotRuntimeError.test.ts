import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';

import type { ProviderExecutionErrorCategory } from '@/core/execution';
import {
  copilotAuthenticationError,
  copilotConfigurationError,
  copilotMissingSessionError,
  CopilotRuntimeError,
  describeError,
  isCopilotRecoverableCategory,
  resolveCopilotNativeReset,
  toCopilotRuntimeError,
  toCopilotSendError,
} from '@/providers/copilot/sdk/CopilotRuntimeError';

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  spawn: () => { throw new Error('Native processes are forbidden in error-classification tests.'); },
}));

describe('Copilot runtime error constructors', () => {
  it('marks a configuration failure as unrecoverable', () => {
    const error = copilotConfigurationError('The Copilot CLI was not found.');

    expect(error.category).toBe('configuration');
    expect(error.recoverable).toBe(false);
  });

  it('marks an authentication failure as recoverable', () => {
    expect(copilotAuthenticationError('Not signed in.')).toMatchObject({
      category: 'authentication',
      recoverable: true,
    });
  });

  it('carries the missing session id so chat can offer a reset', () => {
    expect(copilotMissingSessionError('Session not found', 'session-7')).toMatchObject({
      category: 'provider-session-missing',
      missingProviderSessionId: 'session-7',
    });
  });
});

describe('Copilot failure category contract', () => {
  it.each<[ProviderExecutionErrorCategory, boolean]>([
    ['authentication', true],
    ['configuration', false],
    ['process-exited', true],
    ['provider', true],
    ['provider-session-missing', true],
    ['transport', true],
    ['unknown', true],
  ])('reports %s as recoverable=%s wherever it is raised', (category, recoverable) => {
    expect(isCopilotRecoverableCategory(category)).toBe(recoverable);
    expect(new CopilotRuntimeError(category, 'boom').recoverable).toBe(recoverable);
  });

  it.each<[ProviderExecutionErrorCategory, string]>([
    ['authentication', 'client'],
    ['configuration', 'none'],
    ['process-exited', 'client'],
    ['provider', 'none'],
    ['provider-session-missing', 'session'],
    ['transport', 'client'],
    ['unknown', 'none'],
  ])('drops %s native state down to %s', (category, reset) => {
    expect(resolveCopilotNativeReset(category)).toBe(reset);
    expect(new CopilotRuntimeError(category, 'boom').nativeReset).toBe(reset);
  });
});

describe('toCopilotRuntimeError', () => {
  it('passes a categorized provider error through unchanged', () => {
    const original = copilotConfigurationError('Bad configuration.');

    expect(toCopilotRuntimeError(original)).toBe(original);
  });

  it.each<[string, ProviderExecutionErrorCategory]>([
    ['Session abc does not exist', 'provider-session-missing'],
    ['Request failed: 401 Unauthorized', 'authentication'],
    ['You are not authenticated with GitHub', 'authentication'],
    ['copilot process exited with code 1', 'process-exited'],
    ['spawn copilot ENOENT', 'configuration'],
    ['Copilot CLI not found at /nope/copilot: ENOENT', 'configuration'],
    ['spawn /opt/copilot EACCES', 'configuration'],
    ['read ECONNRESET', 'transport'],
    ['The connection closed unexpectedly', 'transport'],
    ['Unsupported protocol version 2', 'configuration'],
  ])('categorizes %j as %s', (message, category) => {
    expect(toCopilotRuntimeError(new Error(message)).category).toBe(category);
  });

  it('falls back to the caller-supplied category for an unrecognized failure', () => {
    expect(toCopilotRuntimeError(new Error('Something surprising'), 'provider').category)
      .toBe('provider');
    expect(toCopilotRuntimeError(new Error('Something surprising'), 'unknown').category)
      .toBe('unknown');
  });

  it('preserves the original failure as the cause', () => {
    const cause = new Error('Something surprising');

    expect(toCopilotRuntimeError(cause).cause).toBe(cause);
  });

  it('accepts values that are not Error instances', () => {
    expect(toCopilotRuntimeError('plain failure').message).toBe('plain failure');
    expect(toCopilotRuntimeError(undefined).message).toBe('Unknown Copilot error.');
  });

  it.each(['', 'Request session.mcp.oauth.login failed with message: '])(
    'reports missing Entra host configuration as non-retryable without RPC plumbing (%s)',
    prefix => {
      const cause = new Error(
        `${prefix}Microsoft Entra authentication requires the host to configure an Entra client ID`,
      );
      const error = toCopilotRuntimeError(cause);

      expect(error).toMatchObject({
        category: 'configuration', recoverable: false, nativeReset: 'none', cause,
      });
      expect(error.message).toContain('Claudian cannot sign in to this Microsoft MCP server');
      expect(error.message).toContain('close Obsidian');
      expect(error.message).toContain('Copilot CLI');
      expect(error.message).toContain('Automatic Microsoft reauthentication is not supported');
      expect(error.message).not.toContain('session.mcp.oauth.login');
    },
  );

  it('does not classify a different Microsoft sign-in failure as missing host configuration', () => {
    const cause = new Error('Microsoft Entra authentication failed: the service is unavailable.');

    expect(toCopilotRuntimeError(cause)).toMatchObject({
      category: 'provider', recoverable: true, message: cause.message, cause,
    });
  });
});

/**
 * The message `@github/copilot-sdk` throws from `CopilotClient.start` when the path it
 * was handed names nothing, quoted exactly from the SDK.
 *
 * Claudian resolves the CLI before every start, so this is what a path that stopped
 * naming a binary in between — an uninstall, an upgrade that moved it, a removable
 * volume — looks like. It carries no `ENOENT` and nothing else the categorizer reads, so
 * without recognizing it the SDK's own way of saying "wrong CLI path" was reported as a
 * transport failure the user was invited to retry, and the CLI cannot be reinstalled by
 * sending the turn again.
 */
describe('toCopilotRuntimeError for the SDK missing-CLI failure', () => {
  it.each([
    { cliPath: '/opt/homebrew/bin/copilot', hint: 'Ensure @github/copilot is installed.' },
    { cliPath: '/opt/homebrew/bin/copilot', hint: 'Set COPILOT_CLI_PATH to use a custom installation.' },
    { cliPath: '/opt/unauthorized/copilot', hint: 'Set COPILOT_CLI_PATH to use a custom installation.' },
    {
      cliPath: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@github\\copilot\\npm-loader.js',
      hint: 'Set COPILOT_CLI_PATH to use a custom installation.',
    },
  ])('reports the path $cliPath as unrecoverable configuration ($hint)', ({ cliPath, hint }) => {
    const original = new Error(`Copilot CLI not found at ${cliPath}. ${hint}`);
    const error = toCopilotRuntimeError(
      original,
      'transport',
    );

    expect(error.category).toBe('configuration');
    expect(error.recoverable).toBe(false);
    expect(error.nativeReset).toBe('none');
    expect(error.cause).toBe(original);
    expect(error.message).toContain(cliPath);
    expect(error.message).toContain('Settings > Claudian > Providers > Copilot');
    expect(error.message).not.toContain('COPILOT_CLI_PATH');
  });

  it('recognizes the installed SDK error rather than only a captured message fixture', async () => {
    const missingPath = path.join(tmpdir(), `claudian-missing-cli-${randomUUID()}`, 'copilot');
    const client = new CopilotClient({
      baseDirectory: path.join(tmpdir(), `claudian-missing-cli-state-${randomUUID()}`),
      connection: RuntimeConnection.forStdio({ path: missingPath, env: {} }),
      mode: 'empty',
    });
    try {
      const failure = await client.start().then(() => undefined, (error: unknown) => error);
      const error = toCopilotRuntimeError(failure, 'transport');

      expect(error).toMatchObject({ category: 'configuration', recoverable: false, nativeReset: 'none' });
      expect(error.message).toContain('Settings > Claudian > Providers > Copilot');
    } finally {
      await client.forceStop();
    }
  });
});

describe('toCopilotSendError', () => {
  it('reports a turn that never reached idle as an actionable transport failure', () => {
    const error = toCopilotSendError(
      new Error('Timeout after 600000ms waiting for session.idle'),
      600_000,
    );

    expect(error.category).toBe('transport');
    expect(error.nativeReset).toBe('client');
    expect(error.message).toContain('within 10 minutes');
    expect(error.message).toContain('send it again');
  });

  it('leaves a non-timeout send failure to the shared categorization', () => {
    expect(toCopilotSendError(new Error('read ECONNRESET'), 600_000).category)
      .toBe('transport');
    expect(toCopilotSendError(new Error('the model refused'), 600_000).category)
      .toBe('provider');
  });
});

describe('describeError', () => {  it('prefers the message and falls back to the error name', () => {
    const named = new Error('');
    named.name = 'TimeoutError';

    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError(named)).toBe('TimeoutError');
    expect(describeError('   ')).toBe('Unknown Copilot error.');
  });
});

describe('CopilotRuntimeError', () => {
  it('is an Error subclass carrying the provider-neutral category', () => {
    const error = new CopilotRuntimeError('transport', 'stream closed');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CopilotRuntimeError');
    expect(error.category).toBe('transport');
  });
});
