import * as path from 'node:path';

/** A rooted reference such as `C:\\tools\\copilot.js` or a UNC share. */
const DRIVE_QUALIFIED_PATH = /^[a-zA-Z]:[\\/]/;

/**
 * What counts as a path Claudian may hand the Copilot CLI process, and the canonical form
 * of one.
 *
 * The SDK spawns the CLI with the vault as its working directory, so anything the CLI is
 * given that is not absolute — the executable it launches, the data directory it writes
 * agent state into — is resolved against vault content. The same setting would then mean
 * a different place in every vault, and would name a note, an attachment, or a synced
 * folder rather than an install or a state directory.
 *
 * On Windows only a drive-qualified or UNC path is absolute in that sense. `\\tools\\x`
 * and `C:x` are resolved against the working directory's drive, which is the vault's,
 * even though `path.win32.isAbsolute` accepts the first of them.
 *
 * What is left is normalized, so a path that walks through itself names its place once
 * and the identity it belongs to holds still.
 */
export function toAbsoluteCopilotPath(
  value: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const candidate = value?.trim();
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

export function isAbsoluteCopilotPath(
  value: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return toAbsoluteCopilotPath(value, platform) !== null;
}

/**
 * Whether a root holds a path, or is that path — decided lexically, the way the platform
 * the CLI runs on reads the two.
 *
 * The question this answers is asked about places that do not exist yet: the directory
 * Claudian is choosing for a store it has not created, under host locations that may name
 * nothing on this machine. So no filesystem is consulted here. A directory the vault will
 * hold the moment it is created is already held as far as this is concerned, which
 * resolving through `realpath` alone would deny.
 *
 * Two spellings can still reach one place, which no comparison of spellings can see;
 * `isCopilotPathWithinRootThroughLinks` in `CopilotCanonicalPath` asks this first and
 * then asks it again of the names the filesystem gives both sides.
 *
 * Both sides are normalized first, so a path that walks through itself is read as the
 * place it names, and a trailing separator makes no difference. Windows compares without
 * regard to case, because that is how it resolves the two paths to one directory.
 */
export function isCopilotPathWithinRoot(
  candidate: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const comparableRoot = toComparableCopilotPath(root, platform, paths);
  const comparableCandidate = toComparableCopilotPath(candidate, platform, paths);
  if (!comparableRoot || !comparableCandidate) {
    return false;
  }
  if (comparableCandidate === comparableRoot) {
    return true;
  }
  const prefix = comparableRoot.endsWith(paths.sep)
    ? comparableRoot
    : `${comparableRoot}${paths.sep}`;
  return comparableCandidate.startsWith(prefix);
}

function toComparableCopilotPath(
  value: string,
  platform: NodeJS.Platform,
  paths: typeof path.posix,
): string {
  const candidate = value.trim();
  if (!candidate) {
    return '';
  }
  const normalized = paths.normalize(candidate);
  const trimmed = normalized.length > 1 && normalized.endsWith(paths.sep)
    ? normalized.slice(0, -1)
    : normalized;
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}
