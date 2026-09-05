import * as fs from 'node:fs';
import * as path from 'node:path';

import { isCopilotPathWithinRoot, toAbsoluteCopilotPath } from './CopilotAbsolutePath';

/**
 * What the filesystem calls a place, or null where this host cannot say.
 *
 * A canonicalizer is asked about directories that do not exist yet, so it answers for the
 * nearest place that does and carries the rest of the spelling along. Null is a real
 * answer: an unreadable root, a path spelled for another platform, and one that names no
 * place at all are all "no canonical name available here", and the caller falls back to
 * comparing spellings.
 *
 * It is a parameter rather than a fixed call so a host whose links this machine does not
 * have — macOS's `/var`, a vault on a network mount — can be stood in for exactly.
 */
export type CopilotPathCanonicalizer = (
  value: string,
  platform: NodeJS.Platform,
) => string | null;

/**
 * The canonical name this host gives a path, resolving every link on the way to it.
 *
 * `realpath` answers only for a path that exists, and the directories this is asked about
 * are ones Claudian is choosing rather than reading: a `COPILOT_HOME` that has never been
 * created, under a state directory the host may never have made. So the nearest existing
 * ancestor is resolved and the part that does not exist yet is appended to it — the same
 * best-effort resolution `resolveRealPath` performs for vault-relative paths in
 * `utils/path`.
 *
 * Only the host's own platform is answered for. A path spelled for another one names
 * nothing here, and resolving `C:\\Users\\person` against a POSIX filesystem would answer
 * with this process's working directory — the vault — which is the one place these
 * answers may never come from.
 */
export const canonicalizeCopilotHostPath: CopilotPathCanonicalizer = (value, platform) => {
  if (platform !== process.platform) {
    return null;
  }
  const absolute = toAbsoluteCopilotPath(value, platform);
  if (!absolute) {
    return null;
  }
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const suffix: string[] = [];
  let current = absolute;
  for (;;) {
    const resolved = realPathQuietly(current);
    if (resolved) {
      return suffix.length > 0 ? paths.join(resolved, ...suffix.reverse()) : resolved;
    }
    const parent = paths.dirname(current);
    if (parent === current) {
      return null;
    }
    suffix.push(paths.basename(current));
    current = parent;
  }
};

/**
 * Whether a root holds a path, or is that path — by spelling, and by the name the
 * filesystem gives both.
 *
 * The spelling is asked first and is enough on its own: it answers for a store that does
 * not exist yet under a host location that may name nothing on this machine, and a
 * directory the vault will hold the moment it is created is already held as far as this
 * is concerned.
 *
 * What the spelling cannot see is that two names reach one place. A vault kept behind a
 * link, a home directory that is a link into the vault, and macOS's `/var` — a link to
 * `/private/var`, which every temporary directory on that platform is reached through —
 * all give a candidate that reads as external and is written straight into the notes. So
 * both sides are canonicalized and compared again.
 *
 * Where either side has no canonical name here, the spelling stands rather than the
 * question going unanswered: a host that cannot be read must not turn a refusal into
 * consent.
 */
export function isCopilotPathWithinRootThroughLinks(
  candidate: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
  canonicalize: CopilotPathCanonicalizer = canonicalizeCopilotHostPath,
): boolean {
  if (isCopilotPathWithinRoot(candidate, root, platform)) {
    return true;
  }
  const canonicalRoot = canonicalize(root, platform);
  const canonicalCandidate = canonicalize(candidate, platform);
  if (!canonicalRoot || !canonicalCandidate) {
    return false;
  }
  return isCopilotPathWithinRoot(canonicalCandidate, canonicalRoot, platform);
}

/**
 * What the filesystem calls this path, or null when it cannot be read.
 *
 * `realpathSync.native` resolves the case a case-insensitive filesystem stores as well as
 * the links, so two spellings of one directory answer alike. A host without it, and a
 * path that cannot be read at all, fall back rather than failing the resolution.
 */
function realPathQuietly(value: string): string | null {
  try {
    return (fs.realpathSync.native ?? fs.realpathSync)(value);
  } catch {
    return null;
  }
}
