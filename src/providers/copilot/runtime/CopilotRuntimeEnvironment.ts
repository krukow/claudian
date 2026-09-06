import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import { getEnhancedPath } from '../../../utils/env';
import { toAbsoluteCopilotPath } from './CopilotAbsolutePath';
import {
  canonicalizeCopilotHostPath,
  type CopilotPathCanonicalizer,
  isCopilotPathWithinRootThroughLinks,
} from './CopilotCanonicalPath';

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
 *
 * The spelling here is the one the CLI receives. A host sets these variables in whichever
 * case its own conventions use, so which of them Claudian reads is decided without regard
 * to case in {@link resolveTrustedHostEnvironment}.
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
 * The forwarded keys under one spelling, so the host base is read without regard to case.
 *
 * Routing and TLS trust are conventionally spelled in lowercase outside Windows —
 * `https_proxy` and `no_proxy` are what a shell profile, an onboarding script, and curl's
 * own documentation set — and Windows resolves environment variables case-insensitively,
 * so `Path` and `HTTPS_PROXY` are one variable there. Matching the exact spelling only
 * would drop the proxy or certificate authority the host imposes and send an
 * already-signed-in CLI direct instead.
 */
const FORWARDED_ENVIRONMENT_KEYS_BY_LOWERCASE: ReadonlyMap<string, string> = new Map(
  FORWARDED_ENVIRONMENT_KEYS.map(key => [key.toLowerCase(), key]),
);

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

/**
 * The host entries the CLI receives: only the keys the forwarded base names, each under
 * that base's own spelling, matched without regard to case.
 *
 * The vault says nothing here — this is the environment the user already runs Obsidian
 * in, and the reason it is read case-insensitively is that the variables on it are
 * conventionally spelled in lowercase outside Windows. One variable must reach the CLI
 * once, and which spelling won cannot depend on the order a host enumerates its
 * environment in, so two rules decide it: the forwarded base's own spelling wins whenever
 * it carries a value, and otherwise the last remaining spelling by code unit does, the
 * same "last spelling wins" rule the configured environment resolves by. An empty value
 * is read as absent throughout, so a spelling the host left empty neither reaches the CLI
 * nor hides the one it filled in.
 */
function resolveTrustedHostEnvironment(
  source: NodeJS.ProcessEnv,
): ReadonlyMap<string, string> {
  const resolved = new Map<string, { key: string; value: string }>();
  for (const [key, value] of Object.entries(source)) {
    const forwardedKey = FORWARDED_ENVIRONMENT_KEYS_BY_LOWERCASE.get(key.toLowerCase());
    if (!forwardedKey || typeof value !== 'string' || !value) {
      continue;
    }
    const held = resolved.get(forwardedKey);
    if (!held || outranksHostSpelling(key, held.key, forwardedKey)) {
      resolved.set(forwardedKey, { key, value });
    }
  }
  return new Map([...resolved].map(([key, { value }]) => [key, value]));
}

function outranksHostSpelling(
  candidate: string,
  held: string,
  forwardedKey: string,
): boolean {
  if (candidate === forwardedKey) {
    return true;
  }
  if (held === forwardedKey) {
    return false;
  }
  return compareCodeUnits(candidate, held) > 0;
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
 *
 * Both halves are resolved to one spelling before they are applied, so a variable the
 * host and the vault name in different cases is one variable to the CLI rather than two
 * entries whose winner the CLI decides.
 */
export function buildCopilotRuntimeEnvironment(
  input: CopilotRuntimeEnvironmentInput,
): Record<string, string> {
  const source = input.processEnvironment ?? process.env;
  const environment: Record<string, string> = {};

  const forwarded = resolveTrustedHostEnvironment(source);
  for (const key of FORWARDED_ENVIRONMENT_KEYS) {
    const value = forwarded.get(key);
    if (value) {
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
 *
 * The answer is always absolute, and always outside the vault. The CLI is spawned with
 * the vault as its working directory, so a relative `COPILOT_HOME` would put this vault's
 * agent state inside the notes it exists to stay out of — and every host variable this is
 * built from is untrusted input that can name a relative location, or an absolute one the
 * vault holds under that spelling or under the name the filesystem gives it. A variable
 * that does either is read as naming nothing, and the next candidate answers instead.
 *
 * `canonicalize` is what reads the filesystem, and it is a parameter so a host whose
 * links this machine does not have can be stood in for.
 *
 * Throws when the vault holds every location this host names, which a vault opened on the
 * filesystem root does: there is no directory left that keeps agent state out of the
 * notes, and answering with one inside them is the single thing this must never do.
 */
export function resolveCopilotHomeDirectory(
  vaultPath: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  canonicalize: CopilotPathCanonicalizer = canonicalizeCopilotHostPath,
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const vaultKey = createHash('sha256')
    .update(paths.resolve(vaultPath))
    .digest('hex')
    .slice(0, 16);
  return resolveApplicationStateHome(vaultPath, vaultKey, environment, platform, canonicalize);
}

/**
 * Validate the complete prospective store, since an existing application or per-vault
 * subdirectory can itself be a symlink. Temporary locations remain last-resort choices
 * because their state is not expected to survive.
 */
function resolveApplicationStateHome(
  vaultPath: string,
  vaultKey: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  canonicalize: CopilotPathCanonicalizer,
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const directoryName = platform === 'win32' || platform === 'darwin'
    ? 'Claudian'
    : 'claudian';

  for (const candidate of stateRootCandidates(environment, platform)) {
    const absolute = toAbsoluteCopilotPath(candidate, platform);
    if (!absolute) continue;
    const home = paths.join(absolute, directoryName, 'copilot', vaultKey);
    if (!isCopilotPathWithinRootThroughLinks(home, vaultPath, platform, canonicalize)) {
      return home;
    }
  }
  throw new Error(
    `Copilot session state cannot be stored outside the vault at ${vaultPath}: this vault `
    + 'holds every application-state and temporary location this host names. Open the '
    + 'vault on a folder rather than on the whole filesystem, so agent data can be kept '
    + 'out of your notes.',
  );
}

/**
 * Every location this vault's store may live under, best first: what the platform names
 * for application state, then what the host names as temporary, then the temporary
 * locations every host has.
 *
 * The last two are constants rather than anything derived from the vault or the working
 * directory, which are the two places this fallback exists to avoid. There are two of
 * them so a vault opened on the first is not handed its own notes back.
 */
function* stateRootCandidates(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Generator<string | undefined> {
  yield* applicationStateRoots(environment, platform);
  yield* temporaryRoots(environment);
  yield* platform === 'win32'
    ? ['C:\\Temp', 'C:\\Windows\\Temp']
    : ['/tmp', '/var/tmp'];
}

function* applicationStateRoots(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Generator<string | undefined> {
  if (platform === 'win32') {
    yield environment.LOCALAPPDATA;
    for (const home of homeDirectories(environment, platform)) {
      yield path.win32.join(home, 'AppData', 'Local');
    }
    return;
  }
  if (platform === 'darwin') {
    for (const home of homeDirectories(environment, platform)) {
      yield path.posix.join(home, 'Library', 'Application Support');
    }
    return;
  }

  yield environment.XDG_STATE_HOME;
  for (const home of homeDirectories(environment, platform)) {
    yield path.posix.join(home, '.local', 'state');
  }
}

function* homeDirectories(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Generator<string> {
  for (const candidate of [environment.HOME, environment.USERPROFILE, homeDirectoryQuietly()]) {
    const absolute = toAbsoluteCopilotPath(candidate, platform);
    if (absolute) {
      yield absolute;
    }
  }
}

/** The temporary locations this host names, in the order the platform reads them. */
function* temporaryRoots(environment: NodeJS.ProcessEnv): Generator<string | undefined> {
  yield environment.TMPDIR;
  yield environment.TEMP;
  yield environment.TMP;
  yield temporaryDirectoryQuietly();
}

function homeDirectoryQuietly(): string | undefined {
  try {
    return os.homedir();
  } catch {
    return undefined;
  }
}

function temporaryDirectoryQuietly(): string | undefined {
  try {
    return os.tmpdir();
  } catch {
    return undefined;
  }
}
