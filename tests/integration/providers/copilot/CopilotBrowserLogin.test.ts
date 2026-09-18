import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CopilotBrowserLogin } from '@/providers/copilot/runtime/CopilotBrowserLogin';
import type { CopilotClientIdentity } from '@/providers/copilot/sdk/CopilotClientFactory';

let directory = '';

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'claudian-login-'));
  copyFileSync(path.join(__dirname, 'native-fixtures', 'LoginCli.cjs'), path.join(directory, 'copilot.js'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function identity(mode = 'success'): CopilotClientIdentity {
  return {
    baseDirectory: directory,
    cliPath: path.join(directory, 'copilot.js'),
    environment: {
      COPILOT_HOME: directory,
      LOGIN_FIXTURE_MODE: mode,
      LOGIN_FIXTURE_STARTED: path.join(directory, 'started'),
      LOGIN_FIXTURE_STOPPED: path.join(directory, 'stopped'),
    },
    workingDirectory: directory,
  };
}

describe('CopilotBrowserLogin process boundary', () => {
  it('initializes a new private state home before starting sign-in', async () => {
    const current = identity();
    const home = path.join(directory, 'new-state-home');
    await new CopilotBrowserLogin().signIn({
      ...current,
      baseDirectory: home,
      environment: { ...current.environment, COPILOT_HOME: home },
    }, new AbortController().signal);

    expect(JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8')))
      .toEqual({ storeTokenPlaintext: false });
  });

  it('uses browser login with secure storage, without replacing other CLI settings', async () => {
    writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
      storeTokenPlaintext: true, theme: 'dark',
    }));
    const urls: string[] = [];

    await new CopilotBrowserLogin().signIn(identity(), new AbortController().signal, url => {
      urls.push(url);
    });

    expect(urls).toEqual([
      'https://github.com/login/oauth/authorize?client_id=synthetic&state=synthetic',
    ]);
    expect(JSON.parse(readFileSync(path.join(directory, 'settings.json'), 'utf8')))
      .toEqual({ storeTokenPlaintext: false, theme: 'dark' });
    expect(existsSync(path.join(directory, 'started'))).toBe(true);
  });

  it('waits for the login process to stop when browser sign-in is cancelled', async () => {
    const cancellation = new AbortController();
    const login = new CopilotBrowserLogin().signIn(identity('wait'), cancellation.signal, () => {
      cancellation.abort(new Error('Cancelled by the user.'));
    });

    await expect(login).rejects.toThrow('Cancelled by the user.');
    expect(readFileSync(path.join(directory, 'stopped'), 'utf8')).toBe('stopped');
  });

  it('terminates a login that outlives the browser approval deadline', async () => {
    await expect(new CopilotBrowserLogin(1_000).signIn(
      identity('wait'), new AbortController().signal,
    )).rejects.toThrow('timed out');
    expect(readFileSync(path.join(directory, 'stopped'), 'utf8')).toBe('stopped');
  });

  it('does not report success when the native login failed', async () => {
    await expect(new CopilotBrowserLogin().signIn(
      identity('fail'), new AbortController().signal,
    )).rejects.toThrow('sign-in did not complete');
  });

  it('reports unsupported browser login without starting authentication', async () => {
    await expect(new CopilotBrowserLogin().signIn(
      identity('unsupported'), new AbortController().signal,
    )).rejects.toThrow('supports browser sign-in');
    expect(existsSync(path.join(directory, 'started'))).toBe(false);
  });

  it('does not overwrite unreadable CLI settings or expose their contents', async () => {
    writeFileSync(path.join(directory, 'settings.json'), 'SYNTHETIC_PRIVATE_DATA malformed JSON');

    await expect(new CopilotBrowserLogin().signIn(
      identity(), new AbortController().signal,
    )).rejects.toThrow('Could not read Copilot state settings. Sign-in was not started.');
    expect(existsSync(path.join(directory, 'started'))).toBe(false);
    expect(readFileSync(path.join(directory, 'settings.json'), 'utf8'))
      .toBe('SYNTHETIC_PRIVATE_DATA malformed JSON');
  });
});
