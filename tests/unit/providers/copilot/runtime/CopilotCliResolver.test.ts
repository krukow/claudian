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
