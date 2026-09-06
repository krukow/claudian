import { existsSync } from 'node:fs';
import path from 'node:path';

import { CopilotCliResolver } from '@/providers/copilot/runtime/CopilotCliResolver';
import {
  buildCopilotRuntimeEnvironment,
  resolveCopilotTrustedPath,
} from '@/providers/copilot/runtime/CopilotRuntimeEnvironment';
import type { CopilotSdkClient } from '@/providers/copilot/sdk/CopilotSdkPort';
import { copilotSdkRuntime } from '@/providers/copilot/sdk/CopilotSdkRuntime';

/**
 * A `COPILOT_HOME` the Copilot CLI has already been signed in to, which opts this in.
 *
 * There is no default: the CLI records which account a home belongs to inside that home,
 * so only the operator knows which one is signed in, and guessing would turn a real
 * failure into a skipped run on one machine and a false failure on another.
 */
const signedInHome = process.env.CLAUDIAN_COPILOT_KEYCHAIN_SMOKE_HOME?.trim();

/** The names a `gh` executable can have on the platforms Claudian supports. */
const GH_EXECUTABLE_NAMES = ['gh', 'gh.exe', 'gh.cmd', 'gh.bat'];

function ghDirectoriesOn(searchPath: string): string[] {
  return searchPath
    .split(path.delimiter)
    .filter(entry => entry && GH_EXECUTABLE_NAMES.some(
      name => existsSync(path.join(entry, name)),
    ));
}

/** The PATH the CLI is given, with every directory holding a `gh` removed. */
function withoutGh(searchPath: string): string {
  const excluded = new Set(ghDirectoriesOn(searchPath));
  return searchPath
    .split(path.delimiter)
    .filter(entry => entry && !excluded.has(entry))
    .join(path.delimiter);
}

/**
 * Proves against a real Copilot CLI that the client Claudian builds can sign in from the
 * CLI's own credential store.
 *
 * The CLI can also authenticate through the `gh` CLI, which is not a fallback Claudian
 * promises: a host without `gh` must still work. So `gh` is removed from the PATH the CLI
 * is handed, and every directory holding one is proven gone before the CLI is started —
 * an authenticated answer can then only have come out of the keychain. That is also what
 * makes this worth running: `mode: 'empty'` passed this test on a machine with `gh`
 * installed and failed it everywhere else, which is exactly the failure no unit test at
 * the SDK boundary can see.
 *
 * It runs only when `CLAUDIAN_COPILOT_KEYCHAIN_SMOKE_HOME` names a signed-in
 * `COPILOT_HOME`, so nothing here depends on a machine being signed in. Nothing it prints
 * comes from the CLI's account: a sign-in status message carries the login it belongs to.
 */
const describeWhenSignedIn = signedInHome ? describe : describe.skip;

describeWhenSignedIn('Copilot keychain sign-in against the installed CLI', () => {
  jest.setTimeout(180_000);

  let client: CopilotSdkClient | null = null;

  afterAll(async () => {
    await client?.stop().catch(() => undefined);
    await client?.forceStop().catch(() => undefined);
    client = null;
  });

  it('signs in from the CLI keychain with no gh on the path', async () => {
    const cliPath = new CopilotCliResolver().resolve(undefined, '', '');
    if (!cliPath) {
      throw new Error(
        'No `copilot` CLI was found on this host, so there is nothing to sign in with.',
      );
    }

    const environment = buildCopilotRuntimeEnvironment({
      baseDirectory: signedInHome as string,
      cliPath,
      providerEnvironment: {},
      trustedPath: withoutGh(resolveCopilotTrustedPath(cliPath)),
    });

    expect(ghDirectoriesOn(environment.PATH ?? '')).toEqual([]);

    client = await copilotSdkRuntime.createClient({
      baseDirectory: signedInHome as string,
      cliPath,
      environment,
      workingDirectory: process.cwd(),
    });

    expect((await client.getAuthStatus()).isAuthenticated).toBe(true);
  });
});
