import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import { getEnhancedPath } from '../../../utils/env';

/**
 * Environment variables the Copilot CLI needs from the host to locate a shell, resolve
 * TLS trust, and reach the network through a proxy.
 *
 * These are inherited from the host process and only from there. Proxy reachability and
 * TLS trust decide where the CLI's requests go and which certificates it accepts, while
 * the CLI is signed in with the user's own GitHub credential, so they are read from the
 * environment the user already runs Obsidian in rather than from anything the vault can
 * say. Nothing else from `process.env` is forwarded: the CLI receives this minimal base
 * plus the provider's configured entries.
 */
const FORWARDED_ENVIRONMENT_KEYS: readonly string[] = [
  'ALL_PROXY',
  'APPDATA',
  'COMSPEC',
  'CURL_CA_BUNDLE',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'REQUESTS_CA_BUNDLE',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
];

/**
 * Environment variables that reach the CLI from provider settings.
 *
 * Provider entries decide the environment of a process Claudian spawns with the user's
 * own credentials, and they are stored in plain text inside a vault that syncs and can be
 * shared, so they are named rather than filtered: a denial list would have to keep pace
 * with every switch a CLI release adds, while this list refuses the ones nobody has
 * thought of yet.
 *
 * Only locale is on it. Proxy reachability and TLS trust are deliberately not: they say
 * where an already-authenticated CLI sends its requests and which certificates it
 * accepts, so a vault entry would be enough to route that CLI through someone else's
 * proxy or make it trust someone else's certificate authority. What a network or an
 * enterprise host imposes is inherited from the host process instead, through
 * {@link FORWARDED_ENVIRONMENT_KEYS} — that environment is the one the user already runs
 * Obsidian in, and whoever controls it controls the app already.
 *
 * Nothing here names a credential, an endpoint the CLI would present its credential to,
 * or a variable that makes Node or Electron load code: the CLI launches through
 * `process.execPath`, so a loader, debug, or bootstrap variable would turn a settings
 * entry into code running inside the spawned runtime.
 *
 * Sign-in belongs to the CLI and its OS keychain entry. Claudian owns no GitHub
 * credential and offers nowhere to keep one.
 */
export const COPILOT_CONFIGURABLE_ENVIRONMENT_KEYS: readonly string[] = [
  'LANG',
  'LC_ALL',
];

/**
 * The configurable keys under the one spelling the forwarded base uses.
 *
 * Windows resolves environment variables without regard to case, so `https_proxy` and
 * `HTTPS_PROXY` are the same variable to the CLI, and a configured entry written in
 * another case must replace the forwarded value rather than sit beside it. The match is
 * case-insensitive on every platform: which entries Claudian accepts, and what the CLI
 * ends up with, cannot depend on where the vault is opened.
 */
const CONFIGURABLE_ENVIRONMENT_KEYS_BY_LOWERCASE: ReadonlyMap<string, string> = new Map(
  COPILOT_CONFIGURABLE_ENVIRONMENT_KEYS.map(key => [key.toLowerCase(), key]),
);

function resolveConfigurableEnvironmentKey(key: string): string | undefined {
  return CONFIGURABLE_ENVIRONMENT_KEYS_BY_LOWERCASE.get(key.trim().toLowerCase());
}

/**
 * The configured entries exactly as the CLI receives them: only the keys the allow-list
 * names, each under the allow-list's own spelling, the last of two spellings winning, and
 * ordered by key so the same environment always reads the same way.
 *
 * Everything that has to agree on what a configured environment is goes through here.
 * Resolution is lossy on purpose — `lang` and `LANG` are one variable to the CLI, and an
 * entry the allow-list does not name is not one at all — so a caller that read the
 * settings text instead would disagree with the process that was started. The
 * environment fingerprint is such a caller: it identifies the runtime a session and a
 * discovered catalog belong to, and two texts that resolve to one environment name one
 * runtime while two that resolve differently name two.
 */
export function resolveCopilotConfigurableEnvironment(
  providerEnvironment: Readonly<Record<string, string>>,
): Record<string, string> {
  const resolved = new Map<string, string>();
  for (const [key, value] of Object.entries(providerEnvironment)) {
    const configurableKey = resolveConfigurableEnvironmentKey(key);
    if (configurableKey && typeof value === 'string') {
      resolved.set(configurableKey, value);
    }
  }
  return Object.fromEntries(
    [...resolved].sort(([left], [right]) => compareCodeUnits(left, right)),
  );
}

/**
 * Orders keys by code unit rather than by `localeCompare`, so the order does not depend
 * on the collation the host happens to ship.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export interface CopilotRuntimeEnvironmentInput {
  /** Absolute `COPILOT_HOME` for this vault. */
  readonly baseDirectory: string;
  /** Absolute path to the resolved CLI, which decides how the SDK spawns it. */
  readonly cliPath: string;
  /** PATH from `resolveCopilotTrustedPath`, which no vault setting contributes to. */
  readonly trustedPath: string;
  /** Provider-configured environment entries the user opted into. */
  readonly providerEnvironment: Readonly<Record<string, string>>;
  readonly processEnvironment?: NodeJS.ProcessEnv;
}

/**
 * Builds the PATH the CLI process runs with, from the host's own resolution and the CLI
 * Claudian resolved — never from a vault setting.
 *
 * The CLI resolves everything it runs against this PATH: the Node interpreter for a
 * JavaScript entry, Git, a shell, and the executables a turn's tools call. A PATH entry
 * typed into the vault would therefore choose those binaries for a CLI that is already
 * signed in, which is why `PATH` is neither forwarded from provider settings nor read
 * here. Obsidian starts with a minimal PATH, so the host locations a GUI app does not
 * inherit — Homebrew, nvm, volta, fnm — still come from `getEnhancedPath`.
 */
export function resolveCopilotTrustedPath(cliPath: string): string {
  return getEnhancedPath(undefined, cliPath);
}

/**
 * True when the SDK will launch the CLI as a script through `process.execPath` rather
 * than executing it directly. Under Obsidian that executable is Electron, which starts a
 * second app window unless it is told to behave as Node.
 *
 * The SDK tests for a lowercase `.js` suffix, so this mirrors that exactly: telling
 * Electron to behave as Node for a path the SDK would launch directly only hides the
 * failure. `resolveCopilotCliEntry` narrows a path spelled another way before it gets
 * here.
 */
export function isCopilotJavaScriptEntrypoint(cliPath: string): boolean {
  return cliPath.trim().endsWith('.js');
}

/**
 * Builds the complete environment for the Copilot CLI process.
 *
 * The CLI does not inherit `process.env`. It receives the forwarded host base, then the
 * configured entries the allow-list names, and finally the keys Claudian owns outright:
 * where session data lands, which executables the CLI resolves against, and whether
 * Electron behaves as Node. Nothing else reaches it, so a CLI switch that would let the
 * runtime act without asking has no way in from either side.
 */
export function buildCopilotRuntimeEnvironment(
  input: CopilotRuntimeEnvironmentInput,
): Record<string, string> {
  const source = input.processEnvironment ?? process.env;
  const environment: Record<string, string> = {};

  for (const key of FORWARDED_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value) {
      environment[key] = value;
    }
  }

  for (const [key, value] of Object.entries(
    resolveCopilotConfigurableEnvironment(input.providerEnvironment),
  )) {
    environment[key] = value;
  }

  environment.COPILOT_HOME = input.baseDirectory;
  environment.PATH = input.trustedPath;
  if (isCopilotJavaScriptEntrypoint(input.cliPath)) {
    environment.ELECTRON_RUN_AS_NODE = '1';
  }
  return environment;
}

/**
 * Resolves `COPILOT_HOME` to a per-vault directory in the OS application-state location.
 *
 * Copilot session state is agent data, not vault content, so it is deliberately kept out
 * of the vault: it must not be indexed, synced as notes, or picked up by Claudian's own
 * vault-relative tooling. The vault path is hashed so two vaults never share a store and
 * the directory name carries no user path information.
 */
export function resolveCopilotHomeDirectory(
  vaultPath: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const vaultKey = createHash('sha256')
    .update(path.resolve(vaultPath))
    .digest('hex')
    .slice(0, 16);
  return path.join(resolveApplicationStateRoot(environment, platform), 'copilot', vaultKey);
}

function resolveApplicationStateRoot(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const home = environment.HOME || environment.USERPROFILE || os.homedir();

  if (platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA;
    return localAppData
      ? path.join(localAppData, 'Claudian')
      : path.join(home, 'AppData', 'Local', 'Claudian');
  }

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claudian');
  }

  const xdgStateHome = environment.XDG_STATE_HOME;
  return xdgStateHome
    ? path.join(xdgStateHome, 'claudian')
    : path.join(home, '.local', 'state', 'claudian');
}
