import * as path from 'node:path';

/** The launcher npm installs as the `copilot` bin of `@github/copilot`. */
const NPM_LOADER_FILENAME = 'npm-loader.js';

/** The package that ships the loader, and the prefix its platform packages carry. */
const COPILOT_NPM_PACKAGE = '@github/copilot';

/** Where npm may place a dependency relative to the package that declares it. */
const NODE_MODULES = 'node_modules';

/** The `path` flavour for one platform, whichever host this resolution describes. */
type PlatformPath = typeof path.win32;

export interface CopilotNativeBinaryEnvironment {
  readonly arch: string;
  readonly fileExists: (filePath: string) => boolean;
  readonly isMuslLinux: () => boolean;
  readonly platform: NodeJS.Platform;
  readonly readFile: (filePath: string) => string | null;
}

/**
 * True when a path names the npm launcher rather than an executable.
 *
 * The name is matched without regard to case because the filesystems Claudian runs on
 * resolve `NPM-Loader.js` and `npm-loader.js` to the same file, and a launcher reached
 * under either spelling starts the same Node process.
 */
export function isCopilotNpmLoaderPath(
  entryPath: string,
  platform: NodeJS.Platform,
): boolean {
  return pathFor(platform).basename(entryPath).toLowerCase() === NPM_LOADER_FILENAME;
}

/**
 * True when the launcher belongs to `@github/copilot` rather than to some other package
 * that happens to ship a file by that name.
 *
 * The package manifest is the answer when it can be read. A launcher npm placed without
 * one is still recognised by where it sits — the `copilot` directory of the `@github`
 * scope — so an install whose manifest was pruned is not mistaken for a foreign package.
 */
export function isCopilotNpmPackageLoader(
  loaderPath: string,
  environment: CopilotNativeBinaryEnvironment,
): boolean {
  const platformPath = pathFor(environment.platform);
  const packageDirectory = platformPath.dirname(loaderPath);
  const declaredName = readPackageName(packageDirectory, platformPath, environment);
  if (declaredName) {
    return declaredName === COPILOT_NPM_PACKAGE;
  }
  return platformPath.basename(packageDirectory).toLowerCase() === 'copilot'
    && platformPath.basename(platformPath.dirname(packageDirectory)).toLowerCase()
      === '@github';
}

/**
 * The native executable an `@github/copilot` launcher would have spawned, or null when
 * this host has no platform package to spawn.
 *
 * The launcher resolves `@github/copilot-<platform>-<arch>` through Node's own module
 * resolution and `spawnSync`s the binary inside it, so the same package is searched for
 * here: nested under the launcher's package, then outward through every `node_modules`
 * directory above it, which covers a hoisted install, a nested one, and a workspace root.
 */
export function resolveCopilotNativeBinary(
  loaderPath: string,
  environment: CopilotNativeBinaryEnvironment,
): string | null {
  const platformPath = pathFor(environment.platform);
  const packageDirectory = platformPath.dirname(loaderPath);

  for (const packageName of platformPackageNames(environment)) {
    for (const root of nodeModulesRoots(packageDirectory, platformPath)) {
      const directory = platformPath.join(root, ...packageName.split('/'));
      const binary = resolveNativeBinaryPath(directory, platformPath, environment);
      if (environment.fileExists(binary)) {
        return binary;
      }
    }
  }
  return null;
}

/**
 * The platform packages this host could have, in the order the launcher tries them.
 *
 * npm installs exactly one of them, chosen by the `os`, `cpu`, and `libc` fields, so the
 * order only decides which name is looked for first on a host where both Linux packages
 * were forced in.
 */
function platformPackageNames(
  environment: CopilotNativeBinaryEnvironment,
): readonly string[] {
  const tags = environment.platform === 'linux' && environment.isMuslLinux()
    ? ['linuxmusl', 'linux']
    : [environment.platform];
  return tags.map(tag => `${COPILOT_NPM_PACKAGE}-${tag}-${environment.arch}`);
}

/**
 * Every directory a dependency of the launcher's package could have been installed into,
 * nearest first. A directory that is itself a `node_modules` is one of them, which is what
 * finds the hoisted platform package sitting beside `@github/copilot`.
 */
function* nodeModulesRoots(
  packageDirectory: string,
  platformPath: PlatformPath,
): Generator<string> {
  const seen = new Set<string>();
  let current = packageDirectory;
  for (;;) {
    const candidates = platformPath.basename(current).toLowerCase() === NODE_MODULES
      ? [current, platformPath.join(current, NODE_MODULES)]
      : [platformPath.join(current, NODE_MODULES)];
    for (const candidate of candidates) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        yield candidate;
      }
    }
    const parent = platformPath.dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

/**
 * The executable inside a platform package. The manifest names it, and the conventional
 * name covers a manifest that cannot be read or that names an entry outside its own
 * package, which cannot be the binary npm installed.
 */
function resolveNativeBinaryPath(
  directory: string,
  platformPath: PlatformPath,
  environment: CopilotNativeBinaryEnvironment,
): string {
  const manifest = readManifest(directory, platformPath, environment);
  const declared = normalizeBinaryReference(readBinaryReference(manifest), platformPath);
  return platformPath.join(
    directory,
    declared ?? defaultBinaryName(environment.platform),
  );
}

function readBinaryReference(manifest: Record<string, unknown> | null): string {
  const exported = manifest?.exports;
  if (typeof exported === 'string') {
    return exported;
  }
  if (isRecord(exported) && typeof exported['.'] === 'string') {
    return exported['.'];
  }

  const bin = manifest?.bin;
  if (typeof bin === 'string') {
    return bin;
  }
  if (isRecord(bin)) {
    return Object.values(bin).find((value): value is string => typeof value === 'string')
      ?? '';
  }
  return '';
}

/** Keeps a manifest reference relative to its own package, or rejects it entirely. */
function normalizeBinaryReference(
  reference: string,
  platformPath: PlatformPath,
): string | null {
  const trimmed = reference.trim().replace(/^\.[\\/]/, '');
  if (!trimmed || platformPath.isAbsolute(trimmed)) {
    return null;
  }
  const normalized = platformPath.normalize(trimmed);
  return normalized.startsWith('..') ? null : normalized;
}

function defaultBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'copilot.exe' : 'copilot';
}

function readPackageName(
  directory: string,
  platformPath: PlatformPath,
  environment: CopilotNativeBinaryEnvironment,
): string {
  const name = readManifest(directory, platformPath, environment)?.name;
  return typeof name === 'string' ? name.trim() : '';
}

function readManifest(
  directory: string,
  platformPath: PlatformPath,
  environment: CopilotNativeBinaryEnvironment,
): Record<string, unknown> | null {
  const contents = environment.readFile(platformPath.join(directory, 'package.json'));
  if (!contents) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(contents);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pathFor(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
