import {
  isWindowsCliShim,
  resolveCopilotCliEntry,
} from '@/providers/copilot/runtime/CopilotCliEntry';

/**
 * The `@github/copilot` install npm actually produces: a `npm-loader.js` whose only job
 * is to `spawnSync` the native binary from the platform package beside it. Launching the
 * loader would put a Node process between the SDK and the CLI, so these fixtures describe
 * the layouts the native binary has to be found through.
 */
interface NpmInstallFixture {
  /** What the host resolves for `copilot`, before any narrowing. */
  readonly discovered: string;
  readonly environment: {
    arch: string;
    fileExists: (filePath: string) => boolean;
    isMuslLinux: () => boolean;
    platform: NodeJS.Platform;
    readFile: (filePath: string) => string | null;
    realPath: (filePath: string) => string | null;
  };
  /** The native executable the SDK must be handed. */
  readonly nativeBinary: string;
}

interface NpmInstallOptions {
  readonly arch?: string;
  /** Where npm placed the platform package, when it is installed at all. */
  readonly platformPackageRoot?: 'hoisted' | 'nested' | 'absent';
  readonly platformTag?: string;
  readonly muslLinux?: boolean;
}

const POSIX_NPM_LOADER = '#!/usr/bin/env node\nimport{spawnSync}from"node:child_process";';

function npmInstall(
  platform: NodeJS.Platform,
  nodeModules: string,
  discovered: string,
  options: NpmInstallOptions = {},
): NpmInstallFixture {
  const separator = platform === 'win32' ? '\\' : '/';
  const join = (...segments: readonly string[]): string => segments.join(separator);
  const arch = options.arch ?? 'x64';
  const platformTag = options.platformTag ?? platform;
  const platformPackage = `copilot-${platformTag}-${arch}`;
  const binaryName = platform === 'win32' ? 'copilot.exe' : 'copilot';
  const loaderPackage = join(nodeModules, '@github', 'copilot');
  const platformPackageDirectory = options.platformPackageRoot === 'nested'
    ? join(loaderPackage, 'node_modules', '@github', platformPackage)
    : join(nodeModules, '@github', platformPackage);
  const loader = join(loaderPackage, 'npm-loader.js');
  const nativeBinary = join(platformPackageDirectory, binaryName);

  const files = new Map<string, string>([
    [loader, POSIX_NPM_LOADER],
    [join(loaderPackage, 'package.json'), JSON.stringify({
      bin: { copilot: 'npm-loader.js' },
      name: '@github/copilot',
    })],
  ]);
  if (options.platformPackageRoot !== 'absent') {
    files.set(nativeBinary, '');
    files.set(join(platformPackageDirectory, 'package.json'), JSON.stringify({
      bin: { [platformPackage]: binaryName },
      exports: { '.': `./${binaryName}` },
      name: `@github/${platformPackage}`,
    }));
  }

  return {
    discovered,
    environment: {
      arch,
      fileExists: filePath => files.has(filePath),
      isMuslLinux: () => options.muslLinux === true,
      platform,
      readFile: filePath => files.get(filePath) ?? null,
      realPath: filePath => (filePath === discovered ? loader : filePath),
    },
    nativeBinary,
  };
}

/** The launcher npm writes for a global `@github/copilot` install on Windows. */
const NPM_CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & '
  + '"%_prog%"  "%dp0%\\node_modules\\@github\\copilot\\npm-loader.js" %*',
].join('\r\n');

const NPM_PS1_SHIM = [
  '#!/usr/bin/env pwsh',
  '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
  '& "$basedir/node_modules/@github/copilot/npm-loader.js" $args',
].join('\n');

/** The launcher npm writes into `node_modules/.bin` for a local install. */
const NPM_BIN_CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & '
  + '"%_prog%"  "%dp0%\\..\\@github\\copilot\\npm-loader.js" %*',
].join('\r\n');

/** The launcher `cmd-shim` wrote before it moved the shim directory into `dp0`. */
const LEGACY_CMD_SHIM = [
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\..\\@github\\copilot\\npm-loader.js" %*',
  ') ELSE (',
  '  @SETLOCAL',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  '  node  "%~dp0\\..\\@github\\copilot\\npm-loader.js" %*',
  ')',
].join('\r\n');

const NPM_BIN_PS1_SHIM = [
  '#!/usr/bin/env pwsh',
  '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
  '',
  '$exe=""',
  'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
  '  $exe=".exe"',
  '}',
  'if (Test-Path "$basedir/node$exe") {',
  '  & "$basedir/node$exe"  "$basedir/../@github/copilot/npm-loader.js" $args',
  '} else {',
  '  & "node$exe"  "$basedir/../@github/copilot/npm-loader.js" $args',
  '}',
].join('\n');

/** A shim that points the CLI at an entry outside its own tree. */
const ABSOLUTE_TARGET_CMD_SHIM = [
  '@ECHO off',
  '"%_prog%"  "C:\\tools\\copilot\\npm-loader.js" %*',
].join('\r\n');

function windows(overrides: {
  readFile?: (filePath: string) => string | null;
  fileExists?: (filePath: string) => boolean;
  alsoExists?: readonly string[];
} = {}) {
  const present = new Set<string>([
    GLOBAL_NATIVE_BINARY,
    LOCAL_NATIVE_BINARY,
    ...(overrides.alsoExists ?? []),
  ]);
  return {
    arch: 'x64',
    fileExists: overrides.fileExists
      ?? ((filePath: string) => present.has(filePath)
        || filePath.endsWith('npm-loader.js')),
    isMuslLinux: () => false,
    platform: 'win32' as NodeJS.Platform,
    readFile: overrides.readFile ?? (() => NPM_CMD_SHIM),
    realPath: (filePath: string) => filePath,
  };
}

/** Where the launcher fixtures above put the native binary npm installed beside them. */
const GLOBAL_NATIVE_BINARY =
  'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@github\\copilot-win32-x64\\copilot.exe';
const LOCAL_NATIVE_BINARY =
  'C:\\project\\node_modules\\@github\\copilot-win32-x64\\copilot.exe';

describe('resolveCopilotCliEntry', () => {
  it('passes a POSIX executable through untouched', () => {
    expect(resolveCopilotCliEntry('/usr/local/bin/copilot', {
      fileExists: () => true,
      platform: 'darwin',
      readFile: () => null,
      realPath: filePath => filePath,
    })).toBe('/usr/local/bin/copilot');
  });

  it('passes a Windows executable through untouched', () => {
    expect(resolveCopilotCliEntry('C:\\Program Files\\copilot\\copilot.exe', windows()))
      .toBe('C:\\Program Files\\copilot\\copilot.exe');
  });

  it('resolves the native binary an npm cmd launcher leads to', () => {
    expect(resolveCopilotCliEntry('C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd', windows()))
      .toBe(GLOBAL_NATIVE_BINARY);
  });

  it('resolves the native binary a PowerShell launcher leads to', () => {
    expect(resolveCopilotCliEntry(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.ps1',
      windows({ readFile: () => NPM_PS1_SHIM }),
    )).toBe(GLOBAL_NATIVE_BINARY);
  });

  it('resolves a parent-relative entry a local npm launcher points at', () => {
    expect(resolveCopilotCliEntry(
      'C:\\project\\node_modules\\.bin\\copilot.cmd',
      windows({ readFile: () => NPM_BIN_CMD_SHIM }),
    )).toBe(LOCAL_NATIVE_BINARY);
  });

  it('resolves a parent-relative entry a legacy launcher points at', () => {
    expect(resolveCopilotCliEntry(
      'C:\\project\\node_modules\\.bin\\copilot.cmd',
      windows({ readFile: () => LEGACY_CMD_SHIM }),
    )).toBe(LOCAL_NATIVE_BINARY);
  });

  it('resolves a parent-relative entry a local PowerShell launcher points at', () => {
    expect(resolveCopilotCliEntry(
      'C:\\project\\node_modules\\.bin\\copilot.ps1',
      windows({ readFile: () => NPM_BIN_PS1_SHIM }),
    )).toBe(LOCAL_NATIVE_BINARY);
  });

  it('resolves an absolute entry a launcher points at', () => {
    expect(resolveCopilotCliEntry(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd',
      windows({ readFile: () => ABSOLUTE_TARGET_CMD_SHIM }),
    )).toBe('C:\\tools\\copilot\\npm-loader.js');
  });

  it('ignores a JavaScript name the launcher only mentions', () => {
    expect(resolveCopilotCliEntry(
      'C:\\project\\node_modules\\.bin\\copilot.cmd',
      windows({
        alsoExists: ['C:\\project\\node_modules\\.bin\\patch.js'],
        readFile: () => [
          '@ECHO off',
          'REM see also patch.js for the workaround',
          '"%_prog%"  "%dp0%\\..\\@github\\copilot\\npm-loader.js" %*',
        ].join('\r\n'),
      }),
    )).toBe(LOCAL_NATIVE_BINARY);
  });

  it('keeps the PATHEXT switch out of the resolved entry', () => {
    expect(resolveCopilotCliEntry(
      'C:\\project\\node_modules\\.bin\\copilot.cmd',
      windows({ readFile: () => NPM_BIN_CMD_SHIM }),
    )).toBe(LOCAL_NATIVE_BINARY);
  });

  it('resolves against the directory a quoted dp0 assignment names', () => {
    expect(resolveCopilotCliEntry(
      'C:\\project\\node_modules\\.bin\\copilot.cmd',
      windows({
        readFile: () => [
          '@ECHO off',
          'SET "dp0=%~dp0"',
          '"%_prog%"  "%dp0%\\..\\@github\\copilot\\npm-loader.js" %*',
        ].join('\r\n'),
      }),
    )).toBe(LOCAL_NATIVE_BINARY);
  });

  it('resolves against an absolute directory a dp0 assignment names', () => {
    expect(resolveCopilotCliEntry(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd',
      windows({
        readFile: () => [
          '@ECHO off',
          'SET dp0=C:\\tools\\copilot\\',
          '"%_prog%"  "%dp0%\\npm-loader.js" %*',
        ].join('\r\n'),
      }),
    )).toBe('C:\\tools\\copilot\\npm-loader.js');
  });

  it('fails closed when the launcher target is missing', () => {
    expect(resolveCopilotCliEntry(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd',
      windows({ fileExists: () => false }),
    )).toBeNull();
  });

  it('fails closed when a parent-relative launcher target is missing', () => {
    expect(resolveCopilotCliEntry(
      'C:\\project\\node_modules\\.bin\\copilot.cmd',
      windows({ fileExists: () => false, readFile: () => NPM_BIN_CMD_SHIM }),
    )).toBeNull();
  });

  it('fails closed when the launcher cannot be read', () => {
    expect(resolveCopilotCliEntry(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd',
      windows({ readFile: () => null }),
    )).toBeNull();
  });

  it('fails closed when the launcher names no JavaScript entry', () => {
    expect(resolveCopilotCliEntry(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd',
      windows({ readFile: () => '@ECHO off\r\n"%dp0%\\copilot.exe" %*' }),
    )).toBeNull();
  });

  it('leaves a Windows launcher alone on a platform that can run it', () => {
    expect(resolveCopilotCliEntry('/opt/bin/copilot.cmd', {
      fileExists: () => true,
      platform: 'linux',
      readFile: () => null,
    })).toBe('/opt/bin/copilot.cmd');
  });

  it('treats an absent or blank path as unresolved', () => {
    expect(resolveCopilotCliEntry(null, windows())).toBeNull();
    expect(resolveCopilotCliEntry('   ', windows())).toBeNull();
  });
});

/**
 * The SDK spawns the CLI with the vault as the working directory, so a path that is not
 * absolute names a file beside the user's notes rather than an install. A note, an
 * attachment, or a synced folder called `copilot` would then be the program a signed-in
 * turn runs, and the same path would mean a different program in every vault.
 *
 * There is nothing to fall back to once a path names something ambiguous, so an entry
 * that is not absolute is unresolved and the caller reports the configuration failure it
 * is. A Windows path with no drive is one of those: `\tools\copilot.exe` is resolved
 * against whichever drive the working directory sits on, which is the vault's.
 */
describe('resolveCopilotCliEntry for a path that is not absolute', () => {
  it.each([
    ['a bare name', 'copilot'],
    ['an explicitly current-directory name', './copilot'],
    ['a JavaScript entry beside the notes', 'copilot.js'],
    ['a nested relative entry', 'node_modules/.bin/copilot'],
    ['a parent-relative entry', '../bin/copilot'],
  ])('leaves %s unresolved on POSIX', (_label, cliPath) => {
    expect(resolveCopilotCliEntry(cliPath, {
      fileExists: () => true,
      fileIdentity: () => 'inode:1',
      platform: 'darwin',
      readFile: () => null,
      realPath: filePath => filePath,
    })).toBeNull();
  });

  it.each([
    ['a bare name', 'copilot.exe'],
    ['a relative launcher', 'node_modules\\.bin\\copilot.cmd'],
    ['a drive-relative entry', '\\tools\\copilot.exe'],
    ['a drive-current-directory entry', 'C:copilot.exe'],
  ])('leaves %s unresolved on Windows', (_label, cliPath) => {
    expect(resolveCopilotCliEntry(cliPath, windows({ fileExists: () => true })))
      .toBeNull();
  });

  it('keeps a UNC share resolvable', () => {
    expect(resolveCopilotCliEntry('\\\\build\\tools\\copilot.exe', windows({
      fileExists: () => true,
    }))).toBe('\\\\build\\tools\\copilot.exe');
  });

  /** An absolute path that walks through itself still names one file, so it is canonical. */
  it.each([
    ['/opt/copilot/./bin/../bin/copilot', '/opt/copilot/bin/copilot', 'darwin' as NodeJS.Platform],
    ['C:\\npm\\.\\bin\\..\\copilot.exe', 'C:\\npm\\copilot.exe', 'win32' as NodeJS.Platform],
  ])('canonicalizes %j', (cliPath, expected, platform) => {
    expect(resolveCopilotCliEntry(cliPath, {
      arch: 'x64',
      fileExists: () => true,
      isMuslLinux: () => false,
      platform,
      readFile: () => null,
      realPath: filePath => filePath,
    })).toBe(expected);
  });
});

/**
 * The SDK decides how to spawn the CLI by testing whether the path it was given ends in
 * a lowercase `.js`, and launches anything else directly. A path spelled `.JS` is
 * therefore handed to the process launcher as if it were an executable, which no platform
 * can start, while Claudian has already told Electron to behave as Node for it.
 *
 * Rewriting the suffix only preserves which file is launched where the filesystem calls
 * both spellings the same file, and existence alone does not say that: on a case-
 * sensitive filesystem `copilot.JS` and `copilot.js` can both exist and be different
 * programs. The two names are compared by what the filesystem identifies them as, and
 * anything else leaves the path unresolved for the caller to report as the configuration
 * failure it is.
 */
describe('resolveCopilotCliEntry with a JavaScript entry spelled in another case', () => {
  const MIXED_CASE_ENTRY = 'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.JS';

  /** macOS and Windows: every spelling of a name leads to one file. */
  function caseInsensitiveFilesystem() {
    return {
      fileExists: () => true,
      fileIdentity: (filePath: string) => filePath.toLowerCase(),
    };
  }

  /** Linux: a name is a name, so two spellings are two files unless one is absent. */
  function caseSensitiveFilesystem(...present: readonly string[]) {
    const files = new Set(present);
    return {
      fileExists: (filePath: string) => files.has(filePath),
      fileIdentity: (filePath: string) => (files.has(filePath) ? filePath : null),
    };
  }

  it('spells the entry the way the SDK recognises it', () => {
    expect(resolveCopilotCliEntry(MIXED_CASE_ENTRY, {
      ...caseInsensitiveFilesystem(),
      platform: 'win32',
      readFile: () => null,
    })).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.js');
  });

  it('rewrites only the suffix, leaving a mixed-case directory alone', () => {
    expect(resolveCopilotCliEntry('/opt/Copilot/NPM-Loader.Js', {
      ...caseInsensitiveFilesystem(),
      platform: 'darwin',
      readFile: () => null,
    })).toBe('/opt/Copilot/NPM-Loader.js');
  });

  it('leaves the entry unresolved when only the spelling given exists', () => {
    expect(resolveCopilotCliEntry('/opt/copilot/npm-loader.JS', {
      ...caseSensitiveFilesystem('/opt/copilot/npm-loader.JS'),
      platform: 'linux',
      readFile: () => null,
    })).toBeNull();
  });

  /**
   * Both names exist and neither is the other: rewriting the suffix here would hand the
   * SDK a different program than the one the settings named.
   */
  it('leaves the entry unresolved when both spellings are different files', () => {
    expect(resolveCopilotCliEntry('/opt/copilot/npm-loader.JS', {
      ...caseSensitiveFilesystem(
        '/opt/copilot/npm-loader.JS',
        '/opt/copilot/npm-loader.js',
      ),
      platform: 'linux',
      readFile: () => null,
    })).toBeNull();
  });

  it('rewrites the suffix when both spellings lead to one file', () => {
    const linkedIdentity = 'inode:7';
    expect(resolveCopilotCliEntry('/opt/copilot/npm-loader.JS', {
      fileExists: () => true,
      fileIdentity: () => linkedIdentity,
      platform: 'linux',
      readFile: () => null,
    })).toBe('/opt/copilot/npm-loader.js');
  });

  it('leaves the entry unresolved when the filesystem cannot identify it', () => {
    expect(resolveCopilotCliEntry('/opt/copilot/npm-loader.JS', {
      fileExists: () => true,
      fileIdentity: () => null,
      platform: 'linux',
      readFile: () => null,
    })).toBeNull();
  });

  it('resolves a launcher that names its entry in another case', () => {
    expect(resolveCopilotCliEntry('C:\\npm\\copilot.cmd', {
      ...caseInsensitiveFilesystem(),
      platform: 'win32',
      readFile: () => '@ECHO off\r\n"%_prog%"  "%dp0%\\npm-loader.JS" %*',
    })).toBe('C:\\npm\\npm-loader.js');
  });

  it('leaves an already lowercase entry untouched', () => {
    expect(resolveCopilotCliEntry('/opt/copilot/npm-loader.js', {
      fileExists: () => false,
      fileIdentity: () => null,
      platform: 'linux',
      readFile: () => null,
    })).toBe('/opt/copilot/npm-loader.js');
  });
});

/**
 * Every supported npm install of `@github/copilot` resolves to `npm-loader.js`, whose only
 * job is to `spawnSync` the native binary for the host platform. Handing that loader to
 * the SDK puts a Node process between the SDK and the CLI: the SDK owns and force-stops
 * the loader, while the native child it spawned keeps running. The entry the SDK is given
 * therefore has to be the platform package's own executable, wherever npm placed it, and a
 * Copilot install whose platform package is missing fails closed rather than resolving to
 * a loader whose child nothing can stop.
 */
describe('resolveCopilotCliEntry for an npm package install', () => {
  it('resolves the macOS binary behind the symlink a global install puts on PATH', () => {
    const install = npmInstall(
      'darwin',
      '/Users/me/.nvm/versions/node/v24.0.0/lib/node_modules',
      '/Users/me/.nvm/versions/node/v24.0.0/bin/copilot',
      { arch: 'arm64' },
    );

    const entry = resolveCopilotCliEntry(install.discovered, install.environment);

    expect(entry).toBe(
      '/Users/me/.nvm/versions/node/v24.0.0/lib/node_modules/@github/'
      + 'copilot-darwin-arm64/copilot',
    );
    expect(entry).toBe(install.nativeBinary);
  });

  it('resolves the Linux binary behind a local node_modules launcher', () => {
    const install = npmInstall(
      'linux',
      '/project/node_modules',
      '/project/node_modules/.bin/copilot',
    );

    expect(resolveCopilotCliEntry(install.discovered, install.environment))
      .toBe('/project/node_modules/@github/copilot-linux-x64/copilot');
  });

  it('resolves the musl binary on a Linux host with no glibc runtime', () => {
    const install = npmInstall(
      'linux',
      '/usr/lib/node_modules',
      '/usr/bin/copilot',
      { muslLinux: true, platformTag: 'linuxmusl' },
    );

    expect(resolveCopilotCliEntry(install.discovered, install.environment))
      .toBe('/usr/lib/node_modules/@github/copilot-linuxmusl-x64/copilot');
  });

  it('resolves the Windows binary a cmd launcher leads to', () => {
    const install = npmInstall(
      'win32',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd',
    );
    const cmdShim = '@ECHO off\r\n"%_prog%"  '
      + '"%dp0%\\node_modules\\@github\\copilot\\npm-loader.js" %*';

    expect(resolveCopilotCliEntry(install.discovered, {
      ...install.environment,
      readFile: filePath => (
        filePath.endsWith('copilot.cmd')
          ? cmdShim
          : install.environment.readFile(filePath)
      ),
    })).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@github\\'
      + 'copilot-win32-x64\\copilot.exe',
    );
  });

  it('resolves a platform package npm nested inside the loader package', () => {
    const install = npmInstall(
      'darwin',
      '/opt/homebrew/lib/node_modules',
      '/opt/homebrew/bin/copilot',
      { arch: 'arm64', platformPackageRoot: 'nested' },
    );

    expect(resolveCopilotCliEntry(install.discovered, install.environment)).toBe(
      '/opt/homebrew/lib/node_modules/@github/copilot/node_modules/@github/'
      + 'copilot-darwin-arm64/copilot',
    );
  });

  it('resolves a loader the user configured directly', () => {
    const install = npmInstall(
      'darwin',
      '/opt/copilot/node_modules',
      '/opt/copilot/node_modules/@github/copilot/npm-loader.js',
      { arch: 'arm64' },
    );

    expect(resolveCopilotCliEntry(install.discovered, install.environment))
      .toBe('/opt/copilot/node_modules/@github/copilot-darwin-arm64/copilot');
  });

  it.each([
    ['darwin' as NodeJS.Platform, '/Users/me/.npm-global/lib/node_modules', '/Users/me/.npm-global/bin/copilot', 'arm64'],
    ['linux' as NodeJS.Platform, '/project/node_modules', '/project/node_modules/.bin/copilot', 'x64'],
    ['win32' as NodeJS.Platform, 'C:\\npm\\node_modules', 'C:\\npm\\node_modules\\@github\\copilot\\npm-loader.js', 'x64'],
  ])('never hands the SDK the %s loader for a supported npm install', (platform, nodeModules, discovered, arch) => {
    const install = npmInstall(platform, nodeModules, discovered, { arch });

    const entry = resolveCopilotCliEntry(install.discovered, install.environment);

    expect(entry).not.toBeNull();
    expect(entry?.toLowerCase()).not.toContain('npm-loader.js');
    expect(entry?.toLowerCase().endsWith('.cmd')).toBe(false);
    expect(entry).toBe(install.nativeBinary);
  });

  it('fails closed when the platform package is not installed', () => {
    const install = npmInstall(
      'darwin',
      '/usr/local/lib/node_modules',
      '/usr/local/bin/copilot',
      { arch: 'arm64', platformPackageRoot: 'absent' },
    );

    expect(resolveCopilotCliEntry(install.discovered, install.environment)).toBeNull();
  });

  it('fails closed when the platform package is built for another architecture', () => {
    const install = npmInstall(
      'darwin',
      '/usr/local/lib/node_modules',
      '/usr/local/bin/copilot',
      { arch: 'arm64' },
    );

    expect(resolveCopilotCliEntry(install.discovered, {
      ...install.environment,
      arch: 'x64',
    })).toBeNull();
  });

  /**
   * A `npm-loader.js` that belongs to some other package is not a Copilot install, so it
   * is narrowed exactly as before rather than failing closed on a package this rule says
   * nothing about.
   */
  it('leaves a loader from another package alone', () => {
    expect(resolveCopilotCliEntry('/opt/tools/node_modules/@acme/cli/npm-loader.js', {
      arch: 'arm64',
      fileExists: () => true,
      isMuslLinux: () => false,
      platform: 'darwin',
      readFile: () => JSON.stringify({ name: '@acme/cli' }),
      realPath: filePath => filePath,
    })).toBe('/opt/tools/node_modules/@acme/cli/npm-loader.js');
  });

  it('reads the executable name from the platform package manifest', () => {
    const install = npmInstall(
      'darwin',
      '/usr/local/lib/node_modules',
      '/usr/local/bin/copilot',
      { arch: 'arm64' },
    );
    const packageDirectory = '/usr/local/lib/node_modules/@github/copilot-darwin-arm64';

    expect(resolveCopilotCliEntry(install.discovered, {
      ...install.environment,
      fileExists: filePath => filePath === `${packageDirectory}/bin/copilot-native`,
      readFile: filePath => (
        filePath === `${packageDirectory}/package.json`
          ? JSON.stringify({
            exports: { '.': './bin/copilot-native' },
            name: '@github/copilot-darwin-arm64',
          })
          : install.environment.readFile(filePath)
      ),
    })).toBe(`${packageDirectory}/bin/copilot-native`);
  });

  /**
   * A manifest that names an entry outside its own package cannot be the binary npm
   * installed, so the conventional name is used instead of following it out of the tree.
   */
  it('refuses a manifest entry that escapes the platform package', () => {
    const install = npmInstall(
      'darwin',
      '/usr/local/lib/node_modules',
      '/usr/local/bin/copilot',
      { arch: 'arm64' },
    );
    const packageDirectory = '/usr/local/lib/node_modules/@github/copilot-darwin-arm64';

    expect(resolveCopilotCliEntry(install.discovered, {
      ...install.environment,
      readFile: filePath => (
        filePath === `${packageDirectory}/package.json`
          ? JSON.stringify({ exports: { '.': '../../../../etc/copilot' } })
          : install.environment.readFile(filePath)
      ),
    })).toBe(`${packageDirectory}/copilot`);
  });
});

describe('isWindowsCliShim', () => {
  it.each([
    ['C:\\npm\\copilot.cmd', true],
    ['C:\\npm\\copilot.BAT', true],
    ['C:\\npm\\copilot.ps1', true],
    ['C:\\npm\\copilot.exe', false],
    ['C:\\npm\\node_modules\\@github\\copilot\\npm-loader.js', false],
    ['/usr/local/bin/copilot', false],
  ])('classifies %j as a launcher script: %s', (cliPath, expected) => {
    expect(isWindowsCliShim(cliPath)).toBe(expected);
  });
});
