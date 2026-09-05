import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { toAbsoluteCopilotPath } from '@/providers/copilot/runtime/CopilotAbsolutePath';
import {
  canonicalizeCopilotHostPath,
  type CopilotPathCanonicalizer,
  isCopilotPathWithinRootThroughLinks,
} from '@/providers/copilot/runtime/CopilotCanonicalPath';

/**
 * A platform this test host is not, so the canonicalizer is asked about paths whose
 * spelling names nothing here.
 */
const foreignPlatform: NodeJS.Platform = process.platform === 'win32' ? 'linux' : 'win32';

/**
 * Symlink creation needs a privilege Windows does not grant by default, so the tests that
 * build one run where every host can.
 */
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

/** A host that reads `/var` as the link to `/private/var` that macOS makes it. */
const withPrivateVarAlias: CopilotPathCanonicalizer = (value, platform) => {
  const absolute = toAbsoluteCopilotPath(value, platform);
  if (!absolute) {
    return null;
  }
  return absolute === '/var' || absolute.startsWith('/var/')
    ? `/private${absolute}`
    : absolute;
};

/** A host whose filesystem cannot be read at all. */
const withoutFilesystem: CopilotPathCanonicalizer = () => null;

describe('canonicalizeCopilotHostPath', () => {
  it('says nothing about a path spelled for another platform', () => {
    expect(canonicalizeCopilotHostPath('C:\\Users\\person\\AppData\\Local', foreignPlatform))
      .toBeNull();
    expect(canonicalizeCopilotHostPath('/home/person/.local/state', foreignPlatform)).toBeNull();
  });

  it('says nothing about a path that is not absolute', () => {
    expect(canonicalizeCopilotHostPath('state/copilot', process.platform)).toBeNull();
    expect(canonicalizeCopilotHostPath('   ', process.platform)).toBeNull();
  });
});

describeOnPosix('canonicalizeCopilotHostPath on this host', () => {
  let temporaryRoot: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-copilot-canonical-'));
  });

  afterEach(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('resolves the nearest existing ancestor and keeps the suffix that does not exist yet', () => {
    const canonicalRoot = fs.realpathSync(temporaryRoot);

    expect(canonicalizeCopilotHostPath(
      path.join(temporaryRoot, 'Claudian', 'copilot', 'store'),
      process.platform,
    )).toBe(path.join(canonicalRoot, 'Claudian', 'copilot', 'store'));
  });

  it('reads a linked ancestor as the place it points at', () => {
    const target = path.join(temporaryRoot, 'state');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(temporaryRoot, 'link'));

    expect(canonicalizeCopilotHostPath(
      path.join(temporaryRoot, 'link', 'Claudian'),
      process.platform,
    )).toBe(path.join(fs.realpathSync(target), 'Claudian'));
  });
});

describe('isCopilotPathWithinRootThroughLinks', () => {
  it('refuses a place the vault will hold once it exists', () => {
    expect(isCopilotPathWithinRootThroughLinks(
      '/vaults/work/.state',
      '/vaults/work',
      'linux',
      withoutFilesystem,
    )).toBe(true);
  });

  it('refuses a place the vault holds under another name for it', () => {
    expect(isCopilotPathWithinRootThroughLinks(
      '/private/var/notes/state',
      '/var/notes',
      'darwin',
      withPrivateVarAlias,
    )).toBe(true);
    expect(isCopilotPathWithinRootThroughLinks(
      '/var/notes/state',
      '/private/var/notes',
      'darwin',
      withPrivateVarAlias,
    )).toBe(true);
  });

  it('keeps the lexical answer where the host cannot say', () => {
    expect(isCopilotPathWithinRootThroughLinks(
      '/private/var/notes/state',
      '/var/notes',
      'darwin',
      withoutFilesystem,
    )).toBe(false);
    expect(isCopilotPathWithinRootThroughLinks(
      '/var/notes/state',
      '/var/notes',
      'darwin',
      withoutFilesystem,
    )).toBe(true);
  });

  it('accepts a place the vault holds under no name for it', () => {
    expect(isCopilotPathWithinRootThroughLinks(
      '/private/var/tmp/state',
      '/var/notes',
      'darwin',
      withPrivateVarAlias,
    )).toBe(false);
  });
});

describeOnPosix('isCopilotPathWithinRootThroughLinks on this host', () => {
  let temporaryRoot: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-copilot-containment-'));
  });

  afterEach(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('refuses a place physically inside a vault reached through a link', () => {
    const vault = path.join(temporaryRoot, 'vault');
    fs.mkdirSync(vault);
    const linkedVault = path.join(temporaryRoot, 'notes');
    fs.symlinkSync(vault, linkedVault);

    expect(isCopilotPathWithinRootThroughLinks(
      path.join(vault, 'state'),
      linkedVault,
      process.platform,
    )).toBe(true);
    expect(isCopilotPathWithinRootThroughLinks(
      path.join(temporaryRoot, 'outside', 'state'),
      linkedVault,
      process.platform,
    )).toBe(false);
  });

  it('refuses a linked place that lands inside the vault', () => {
    const vault = path.join(temporaryRoot, 'vault');
    fs.mkdirSync(path.join(vault, 'state'), { recursive: true });
    const linkedState = path.join(temporaryRoot, 'state-link');
    fs.symlinkSync(path.join(vault, 'state'), linkedState);

    expect(isCopilotPathWithinRootThroughLinks(
      path.join(linkedState, 'Claudian'),
      vault,
      process.platform,
    )).toBe(true);
  });
});
