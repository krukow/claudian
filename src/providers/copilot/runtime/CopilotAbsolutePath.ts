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
