import * as fs from 'node:fs';
import * as path from 'node:path';

import { isExistingFile } from '../../../utils/cliBinaryLocator';
import {
  isCopilotNpmLoaderPath,
  isCopilotNpmPackageLoader,
  resolveCopilotNativeBinary,
} from './CopilotNativeCliBinary';

/**
 * Windows launcher scripts that `child_process.spawn` cannot start without a shell. Node
 * refuses to run them directly, so a path ending in one of these exists but is not a
 * launchable CLI.
 */
const WINDOWS_SHIM_EXTENSIONS: readonly string[] = ['.cmd', '.bat', '.ps1'];

/** A rooted reference such as `C:\\tools\\copilot.js` or a UNC share. */
const DRIVE_QUALIFIED_PATH = /^[a-zA-Z]:[\\/]/;

/**
 * How a launcher writes "the directory this shim lives in".
 *
 * `cmd` launchers use the batch expansion `%~dp0` directly, or copy it into `dp0` with a
 * `SET dp0=%~dp0` line and expand `%dp0%` from then on. PowerShell launchers assign the
 * same directory to `$basedir`. All of them then name the JavaScript entry relative to it,
 * which for a launcher under `node_modules\.bin` is a parent-relative path.
 */
const SHIM_DIRECTORY_MARKERS: readonly RegExp[] = [
  /^%~dp0%?/i,
  /^%dp0%/i,
  /^\$basedir/i,
  /^\$PSScriptRoot/i,
];

/** The `SET dp0=...` line a cmd launcher defines its own directory with. */
const SHIM_DP0_ASSIGNMENT = /^\s*(?:@?SET)\s+"?dp0=([^"\r\n]*)"?\s*$/im;

/** Batch and PowerShell argument separators, so a quoted target is read on its own. */
const SHIM_TOKEN_SEPARATOR = /["'\s]+/;

/** The suffix the SDK tests for when it decides to launch the CLI through Node. */
const LOWERCASE_JS_SUFFIX = '.js';

/** The same suffix however it is spelled, which the filesystem may still resolve. */
const MIXED_CASE_JS_SUFFIX = /\.js$/i;

export interface CopilotCliEntryEnvironment {
  readonly arch: string;
  readonly fileExists: (filePath: string) => boolean;
  /**
   * What the filesystem calls the file at this path, or null when there is none. Two
   * paths naming one file share it; two paths naming different files never do.
   */
  readonly fileIdentity: (filePath: string) => string | null;
  readonly isMuslLinux: () => boolean;
  readonly platform: NodeJS.Platform;
  readonly readFile: (filePath: string) => string | null;
  readonly realPath: (filePath: string) => string | null;
}

/**
 * Resolves a discovered `copilot` path to the executable the SDK should own.
 *
 * The path has to be absolute before anything else is read from it. The SDK spawns the
 * CLI with the vault as the working directory, so a relative path — configured or found
 * on the host's PATH — names vault content rather than an install, and fails closed here.
 *
 * The SDK spawns a path ending in a lowercase `.js` through the Node executable and
 * anything else directly, so a native binary or a shebang script passes through
 * untouched. On Windows npm installs the CLI as a `copilot.cmd` launcher, which `spawn`
 * rejects; the launcher names the package's JavaScript entry, so that entry is resolved
 * instead. A JavaScript entry spelled in another case is rewritten to the spelling the
 * SDK recognises, but only where the filesystem identifies both spellings as one file.
 *
 * Every supported npm install then lands on `@github/copilot`'s `npm-loader.js`, directly
 * or through the symlink npm puts on PATH, and that loader only `spawnSync`s the native
 * binary for the host platform. Handing it to the SDK would leave the SDK owning a Node
 * process whose child keeps running when the loader is stopped, so the platform package's
 * own executable is resolved and given to the SDK instead.
 *
 * A path that is not absolute, a launcher that names nothing resolvable, an entry the
 * filesystem tells apart from its lowercase spelling, and a Copilot install with no
 * platform package all return null rather than a path that only fails at spawn time,
 * launches the wrong program, or leaves a process nothing can stop.
 */
export function resolveCopilotCliEntry(
  cliPath: string | null,
  environment: Partial<CopilotCliEntryEnvironment> = {},
): string | null {
  const resolved: CopilotCliEntryEnvironment = {
    arch: environment.arch ?? process.arch,
    fileExists: environment.fileExists ?? isExistingFile,
    fileIdentity: environment.fileIdentity ?? fileIdentityQuietly,
    isMuslLinux: environment.isMuslLinux ?? isMuslLinuxHost,
    platform: environment.platform ?? process.platform,
    readFile: environment.readFile ?? readFileQuietly,
    realPath: environment.realPath ?? realPathQuietly,
  };

  const candidate = toAbsoluteCliPath(cliPath, resolved.platform);
  if (!candidate) {
    return null;
  }
  const target = resolved.platform === 'win32' && isWindowsCliShim(candidate)
    ? resolveShimTarget(candidate, resolved.readFile, resolved.fileExists)
    : candidate;
  if (target === null) {
    return null;
  }
  const entry = normalizeJavaScriptSuffix(target, resolved.fileIdentity);
  if (entry === null) {
    return null;
  }

  const loader = resolveNpmLoaderPath(entry, resolved);
  return loader ? resolveCopilotNativeBinary(loader, resolved) : entry;
}

/**
 * The candidate as the canonical absolute path the SDK will spawn, or null when it is not
 * one.
 *
 * The SDK spawns the CLI with the vault as the working directory, so a path that is not
 * absolute names a file beside the user's notes rather than an install: a note, an
 * attachment, or a synced folder called `copilot` is what a signed-in turn would run, and
 * the same setting would mean a different program in every vault. There is nothing to
 * fall back to once a path is ambiguous, so an entry that is not absolute is left
 * unresolved for the caller to report as the configuration failure it is — including for
 * a discovered one, because a relative entry on the host's own PATH resolves against that
 * same working directory.
 *
 * A Windows path is absolute only when it names a drive or a UNC share, which is the same
 * distinction a launcher's own references are read with: `\tools\copilot.exe` and
 * `C:copilot.exe` are both resolved against the working directory's drive, which is the
 * vault's. What is left is normalized, so a path that walks through itself names its file
 * once and the SDK identity that path belongs to holds still.
 */
function toAbsoluteCliPath(
  cliPath: string | null,
  platform: NodeJS.Platform,
): string | null {
  const candidate = cliPath?.trim();
  if (!candidate) {
    return null;
  }
  if (platform !== 'win32') {
    return path.posix.isAbsolute(candidate) ? path.posix.normalize(candidate) : null;
  }
  return DRIVE_QUALIFIED_PATH.test(candidate) || candidate.startsWith('\\\\')
    ? path.win32.normalize(candidate)
    : null;
}

/**
 * The `@github/copilot` launcher an entry leads to, or null when it leads to none.
 *
 * A POSIX install puts a symlink on PATH rather than the launcher itself, so the link is
 * followed before the name is read. A launcher belonging to another package leads
 * nowhere: this rule is about the CLI Claudian drives, not about every file npm named
 * `npm-loader.js`.
 */
function resolveNpmLoaderPath(
  entry: string,
  environment: CopilotCliEntryEnvironment,
): string | null {
  const named = isCopilotNpmLoaderPath(entry, environment.platform)
    ? entry
    : linkedLoaderPath(entry, environment);
  return named && isCopilotNpmPackageLoader(named, environment) ? named : null;
}

function linkedLoaderPath(
  entry: string,
  environment: CopilotCliEntryEnvironment,
): string | null {
  const linked = environment.realPath(entry);
  return linked && isCopilotNpmLoaderPath(linked, environment.platform) ? linked : null;
}

/**
 * Rewrites a `.JS` suffix to the `.js` the SDK tests for.
 *
 * Nothing tells the SDK to launch through Node other than that suffix, so a path spelled
 * any other way is handed to the process launcher as if it were an executable, which no
 * platform can start. Rewriting it only preserves which file is launched where the
 * filesystem calls both spellings the same file, and existence does not say that: on a
 * case-sensitive filesystem `copilot.JS` and `copilot.js` can both exist and be different
 * programs, so an existence check would silently swap one for the other. The two names
 * are compared by what the filesystem identifies them as instead, and a filesystem that
 * tells them apart — or that identifies neither — leaves the entry unresolved for the
 * caller to report as the configuration failure it is.
 */
function normalizeJavaScriptSuffix(
  cliPath: string,
  fileIdentity: (filePath: string) => string | null,
): string | null {
  if (!MIXED_CASE_JS_SUFFIX.test(cliPath) || cliPath.endsWith(LOWERCASE_JS_SUFFIX)) {
    return cliPath;
  }
  const normalized = cliPath.slice(0, -LOWERCASE_JS_SUFFIX.length) + LOWERCASE_JS_SUFFIX;
  const identity = fileIdentity(cliPath);
  return identity !== null && identity === fileIdentity(normalized) ? normalized : null;
}

export function isWindowsCliShim(cliPath: string): boolean {
  return WINDOWS_SHIM_EXTENSIONS.includes(path.win32.extname(cliPath).toLowerCase());
}

function resolveShimTarget(
  shimPath: string,
  readFile: (filePath: string) => string | null,
  fileExists: (filePath: string) => boolean,
): string | null {
  const contents = readFile(shimPath);
  if (!contents) {
    return null;
  }

  const shimDirectory = resolveShimDirectory(shimPath, contents);
  for (const token of contents.split(SHIM_TOKEN_SEPARATOR)) {
    if (!token.toLowerCase().endsWith('.js')) {
      continue;
    }
    const resolved = resolveShimReference(token, shimDirectory);
    if (resolved && fileExists(resolved)) {
      return resolved;
    }
  }
  return null;
}

/**
 * The directory `%dp0%` and `%~dp0` name. A launcher that assigns `dp0` itself decides
 * that, and `%~dp0` inside the assignment is still its own directory.
 */
function resolveShimDirectory(shimPath: string, contents: string): string {
  const ownDirectory = path.win32.dirname(shimPath);
  const assigned = SHIM_DP0_ASSIGNMENT.exec(contents)?.[1]?.trim();
  if (!assigned) {
    return ownDirectory;
  }
  if (DRIVE_QUALIFIED_PATH.test(assigned) || assigned.startsWith('\\\\')) {
    return path.win32.normalize(assigned);
  }
  const expanded = stripShimDirectoryMarker(assigned);
  return expanded === null
    ? ownDirectory
    : path.win32.resolve(ownDirectory, toWindowsSeparators(expanded) || '.');
}

/**
 * Shim references are relative to the directory the launcher named. An absolute reference
 * is taken as written, and a parent-relative one is resolved from that directory, which is
 * how npm points a `node_modules\.bin` launcher at the package beside it. A reference with
 * no directory marker is only accepted inside `node_modules`, so a stray `.js` word in a
 * comment cannot become the CLI path.
 */
function resolveShimReference(reference: string, shimDirectory: string): string | null {
  if (!reference) {
    return null;
  }
  if (DRIVE_QUALIFIED_PATH.test(reference) || reference.startsWith('\\\\')) {
    return path.win32.normalize(reference);
  }

  const relative = stripShimDirectoryMarker(reference);
  if (relative === null || !relative) {
    return null;
  }
  return path.win32.resolve(shimDirectory, toWindowsSeparators(relative));
}

/**
 * Removes the marker naming the launcher's own directory, leaving the path relative to it.
 * Returns null for a reference that names no directory and lies outside `node_modules`.
 */
function stripShimDirectoryMarker(reference: string): string | null {
  for (const marker of SHIM_DIRECTORY_MARKERS) {
    if (marker.test(reference)) {
      return reference.replace(marker, '').replace(/^[\\/]+/, '');
    }
  }
  const withoutSeparator = reference.replace(/^[\\/]+/, '');
  return withoutSeparator.startsWith('node_modules') ? withoutSeparator : null;
}

function toWindowsSeparators(reference: string): string {
  return reference.replace(/\//g, '\\');
}

function readFileQuietly(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function realPathQuietly(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

/**
 * What the filesystem calls the file at this path: its device and inode, which two names
 * for one file share and two names for different files do not.
 *
 * `realpath` cannot answer this. It resolves symlinks but leaves the spelling as given,
 * so on macOS it returns two different paths for two names of one file.
 */
function fileIdentityQuietly(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return null;
  }
}

/**
 * True on a Linux host whose C library is musl rather than glibc, which decides which of
 * the two Linux platform packages npm installed.
 *
 * Node reports a glibc runtime version in its process report on a glibc host and reports
 * none on a musl one, which is the same signal `detect-libc` reads for the launcher,
 * without Claudian taking that dependency.
 */
function isMuslLinuxHost(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  try {
    const report = process.report?.getReport() as
      { header?: { glibcVersionRuntime?: string } } | undefined;
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}
