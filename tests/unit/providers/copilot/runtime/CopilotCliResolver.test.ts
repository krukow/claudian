import * as fs from 'fs';
import * as path from 'path';

import { CopilotCliResolver } from '@/providers/copilot/runtime/CopilotCliResolver';
import { parsePathEntries } from '@/utils/path';

jest.mock('fs');
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
}));

const mockedStat = fs.statSync as jest.Mock;

describe('CopilotCliResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  it('prefers the current host path over synced paths and the legacy path', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/current/copilot' || filePath === '/legacy/copilot') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    expect(new CopilotCliResolver().resolve({
      'current-host': '/current/copilot',
      'other-host': '/other/copilot',
    }, '/legacy/copilot', '')).toBe('/current/copilot');
  });

  it('falls back through the legacy path and a binary named copilot on the host PATH', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/legacy/copilot') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    expect(new CopilotCliResolver().resolve({}, '/legacy/copilot', '')).toBe('/legacy/copilot');

    const hostBinary = path.join(parsePathEntries(process.env.PATH ?? '')[0] ?? '', 'copilot');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === hostBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    expect(new CopilotCliResolver().resolve({}, '', '')).toBe(hostBinary);
  });

  /**
   * A PATH typed into the vault would choose which `copilot` a signed-in CLI turn runs,
   * and the directory it resolves from is prepended to the environment that CLI receives.
   * Discovery therefore searches the host's own resolution only; an install that is not on
   * it names the CLI path explicitly instead.
   */
  it('never discovers the CLI through a configured PATH', () => {
    const attackerBinary = path.join('/attacker/bin', 'copilot');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === attackerBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    expect(new CopilotCliResolver().resolve({}, '', 'PATH=/attacker/bin')).toBeNull();
  });

  it('reads the host CLI path from provider settings and caches the result', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/configured/copilot') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    const settings = {
      providerConfigs: {
        copilot: { cliPathsByHost: { 'current-host': '/configured/copilot' } },
      },
    };
    const resolver = new CopilotCliResolver();

    expect(resolver.resolveFromSettings(settings)).toBe('/configured/copilot');
    expect(resolver.resolveFromSettings(settings)).toBe('/configured/copilot');
    expect(mockedStat.mock.calls.filter(([filePath]) => filePath === '/configured/copilot'))
      .toHaveLength(1);

    resolver.reset();
    expect(resolver.resolveFromSettings(settings)).toBe('/configured/copilot');
    expect(mockedStat.mock.calls.filter(([filePath]) => filePath === '/configured/copilot'))
      .toHaveLength(2);
  });

  it('returns null instead of falling back to an SDK-bundled CLI', () => {
    mockedStat.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const resolver = new CopilotCliResolver();

    expect(resolver.resolveFromSettings({ providerConfigs: { copilot: {} } })).toBeNull();
  });

  /**
   * Under Obsidian the plugin's working directory is the vault, so a configured path that
   * stays relative after expansion is resolved against vault content: a note, an
   * attachment, or a synced folder named `copilot` satisfies the existence check and would
   * be handed to the SDK as the CLI a signed-in turn runs.
   */
  it('never resolves a relative configured path to a vault file of the same name', () => {
    const vaultFile = path.join(process.cwd(), 'copilot');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === 'copilot' || filePath === vaultFile) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    expect(new CopilotCliResolver().resolve({ 'current-host': 'copilot' }, '', ''))
      .toBeNull();
  });

  /**
   * An explicitly configured path is the answer the user gave, so a relative one fails
   * closed rather than quietly searching the host for some other `copilot`: the CLI that
   * ran would then not be the one settings named.
   */
  it('fails closed on a relative configured path instead of searching the host', () => {
    const hostBinary = path.join(parsePathEntries(process.env.PATH ?? '')[0] ?? '', 'copilot');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === './copilot' || filePath === hostBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    expect(new CopilotCliResolver().resolve({ 'current-host': './copilot' }, '', ''))
      .toBeNull();
  });

  /**
   * A configured path that names nothing is a setting to fix, not a reason to run
   * whichever `copilot` the host happens to have: an install that was moved, renamed, or
   * removed would otherwise be replaced silently by another one, under a path the user
   * never named and cannot see. Unset is the only state that lets discovery run.
   */
  it.each([
    ['the current host path', { 'current-host': '/missing/copilot' }, ''],
    ['the legacy path', {}, '/missing/copilot'],
    ['the current host path with an empty quoted value', { 'current-host': '""' }, ''],
  ] as ReadonlyArray<[string, Record<string, string>, string]>)(
    'fails closed when %s names nothing',
    (_name, hostnamePaths, legacyPath) => {
      const hostBinary = path.join(parsePathEntries(process.env.PATH ?? '')[0] ?? '', 'copilot');
      mockedStat.mockImplementation((filePath: string) => {
        if (filePath === hostBinary) {
          return { isFile: () => true };
        }
        throw new Error(`ENOENT: ${filePath}`);
      });

      expect(new CopilotCliResolver().resolve(hostnamePaths, legacyPath, '')).toBeNull();
    },
  );

  /**
   * The current host's path is the one this machine was configured with, so a legacy path
   * synced from another machine never stands in for it.
   */
  it('never falls back from a broken host path to the legacy path', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/legacy/copilot') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    expect(new CopilotCliResolver().resolve(
      { 'current-host': '/missing/copilot' },
      '/legacy/copilot',
      '',
    )).toBeNull();
  });

  /**
   * A path that exists but is not something the SDK can be handed is configured just as
   * explicitly, so it fails closed for the same reason: a `.cmd` launcher naming nothing
   * resolvable, or an entry the filesystem does not identify as the lowercase `.js` the
   * SDK starts through Node.
   */
  it('fails closed on a configured path the SDK cannot be handed', () => {
    const shim = 'C:\\npm\\copilot.cmd';
    const hostBinary = path.join(parsePathEntries(process.env.PATH ?? '')[0] ?? '', 'copilot');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === shim || filePath === hostBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    (fs.readFileSync as jest.Mock).mockReturnValue('@ECHO OFF\r\nREM nothing to launch\r\n');
    const original = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });

    try {
      expect(new CopilotCliResolver().resolve({ 'current-host': shim }, '', '')).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: original,
      });
    }
  });

  /**
   * Only an unset path lets discovery run, and a path box holding nothing but whitespace
   * is unset. Anything else in it is an answer that has to resolve, including a quoted
   * empty string: it names no install, and reading it as "unset" would hand a signed-in
   * turn whichever `copilot` the host happens to have.
   */
  it.each(['   ', '\t'])('discovers the host CLI when the path box holds %j', (configured) => {
    const hostBinary = path.join(parsePathEntries(process.env.PATH ?? '')[0] ?? '', 'copilot');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === hostBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    expect(new CopilotCliResolver().resolve({ 'current-host': configured }, '', ''))
      .toBe(hostBinary);
  });

  /**
   * A path configured for another machine says nothing about this one, so the host it was
   * synced to still discovers its own install.
   */
  it('discovers the host CLI when only another host names a path', () => {
    const hostBinary = path.join(parsePathEntries(process.env.PATH ?? '')[0] ?? '', 'copilot');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === hostBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    expect(new CopilotCliResolver().resolve({ 'other-host': '/other/copilot' }, '', ''))
      .toBe(hostBinary);
  });

  /**
   * A relative entry on the host's own PATH resolves against the working directory too,
   * so discovery through it names vault content just as a configured relative path does.
   */
  it('never discovers the CLI through a relative host PATH entry', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === 'copilot') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    const originalPath = process.env.PATH;
    process.env.PATH = '.';

    try {
      expect(new CopilotCliResolver().resolve({}, '', '')).toBeNull();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  /**
   * The resolver hands the SDK what it will spawn, so a Windows npm install has to arrive
   * as the platform package's own executable. The launcher is a Node process whose native
   * child survives the SDK stopping it, and the `.cmd` in front of it cannot be spawned at
   * all.
   */
  it('narrows a discovered path to the native binary the SDK can own', () => {
    const shim = 'C:\\npm\\copilot.cmd';
    const loader = 'C:\\npm\\node_modules\\@github\\copilot\\npm-loader.js';
    const nativeBinary =
      `C:\\npm\\node_modules\\@github\\copilot-win32-${process.arch}\\copilot.exe`;
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === shim || filePath === loader || filePath === nativeBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    (fs.readFileSync as jest.Mock).mockReturnValue(
      '"%_prog%"  "%dp0%\\node_modules\\@github\\copilot\\npm-loader.js" %*',
    );
    const original = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });

    try {
      expect(new CopilotCliResolver().resolve({}, shim, '')).toBe(nativeBinary);
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: original,
      });
    }
  });
});
