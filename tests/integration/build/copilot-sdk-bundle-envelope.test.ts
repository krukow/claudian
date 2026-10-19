import { existsSync, readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';

import { build, stop } from 'esbuild';

import * as copilotSdkBundleEnvelopeHelpers from '../../../scripts/copilotSdkBundleEnvelope.js';
import * as desktopRuntimeAliasHelpers from '../../../scripts/desktopRuntimeAliases.js';
import * as terserProductionBundleHelpers from '../../../scripts/terserProductionBundle.js';

const {
  createCopilotSdkBundleEnvelopePlugin,
  createCopilotSdkRuntimeAliases,
  inspectCopilotBundleEnvelope,
} = copilotSdkBundleEnvelopeHelpers;
const { createDesktopRuntimeAliases } = desktopRuntimeAliasHelpers;
const { minifyProductionBundle } = terserProductionBundleHelpers;

const root = path.resolve(__dirname, '../../..');
const performanceScript = readFileSync(
  path.join(root, 'scripts/check-startup-performance.mjs'),
  'utf8',
);

function budgetPolicyBytes(constantName: string): number {
  const declaration = new RegExp(`export const ${constantName} = ([\\d_]+);`)
    .exec(performanceScript);
  if (!declaration) {
    throw new Error(`check-startup-performance.mjs no longer exports ${constantName}`);
  }
  return Number(declaration[1].replaceAll('_', ''));
}

const forkBudgetBytes = budgetPolicyBytes('mainBudgetBytes');
const upstreamCeilingBytes = budgetPolicyBytes('upstreamMainBudgetBytes');
const preCopilotBaselineBytes = budgetPolicyBytes('preCopilotSdkBaselineMainBytes');

/**
 * Ordinary SDK growth is not a regression, while the
 * graph this envelope excludes — the native FFI addon and the platform CLI resolver — is
 * measured in megabytes and cannot hide under it. The floor is the other half of the same
 * guarantee: a broken alias, a tree-shaken client, or a stubbed-out transport would collapse
 * the contribution and make every exclusion assertion below pass vacuously.
 */
const retainedSdkUpperBoundBytes = 200_000;
const retainedSdkLowerBoundBytes = 50_000;
const requiredProjectedHeadroomBytes = 100_000;

/**
 * Native FFI is an ordinary SDK dependency; platform runtimes are optional dependencies.
 * Any installed native payload stays on contributor/CI disk, never in the plugin bundle
 * or on a runtime resolution path the bundle can take.
 */
const nativeFfiPackage = 'koffi';
const platformCliPackagePattern = /^@github\/copilot-sdk-(?:darwin|linux|linuxmusl|win32)-(?:arm64|x64)$/;

async function bundleFixture(contents: string): Promise<{
  bytes: number;
  inputs: string[];
  source: string;
}> {
  const result = await build({
    absWorkingDir: root,
    alias: {
      ...createDesktopRuntimeAliases(),
      ...createCopilotSdkRuntimeAliases(),
    },
    bundle: true,
    external: [
      ...builtinModules,
      ...builtinModules.map(moduleName => `node:${moduleName}`),
    ],
    format: 'cjs',
    loader: { '.wasm': 'binary' },
    logLevel: 'silent',
    metafile: true,
    minify: true,
    platform: 'browser',
    plugins: [createCopilotSdkBundleEnvelopePlugin()],
    stdin: {
      contents,
      loader: 'js',
      resolveDir: root,
      sourcefile: 'copilot-sdk-envelope-fixture.js',
    },
    target: 'es2022',
    treeShaking: true,
    write: false,
  });
  const source = await minifyProductionBundle(result.outputFiles[0].text);

  return {
    bytes: Buffer.byteLength(source, 'utf8'),
    inputs: Object.keys(result.metafile.inputs).map(input => input.replaceAll('\\', '/')),
    source,
  };
}

describe('Copilot SDK bundle envelope', () => {
  let bundleBytes = 0;
  let bundleInputs: string[] = [];
  let bundleSource = '';
  let retainedSdkBytes = 0;
  let fixture: {
    probeCopilotClient(): string[];
    probeFailClosedStubs(): [string, string | null][];
  };

  beforeAll(async () => {
    const [withSdk, withoutSdk] = await Promise.all([
      bundleFixture(`
        import {
          CopilotClient,
          CopilotRequestHandler,
          CopilotWebSocketForwarder,
          CopilotWebSocketHandler,
          SessionFsSqliteTransactionFailure,
          SessionFsWriteFailure,
          createSessionFsAdapter,
        } from '@github/copilot-sdk';

        export function probeCopilotClient() {
          return [typeof CopilotClient, typeof CopilotClient.prototype.start];
        }

        export function probeFailClosedStubs() {
          const stubs = [
            ['CopilotRequestHandler', () => new CopilotRequestHandler()],
            ['CopilotWebSocketForwarder', () => new CopilotWebSocketForwarder()],
            ['CopilotWebSocketHandler', () => new CopilotWebSocketHandler()],
            ['SessionFsSqliteTransactionFailure', () => new SessionFsSqliteTransactionFailure()],
            ['SessionFsWriteFailure', () => new SessionFsWriteFailure()],
            ['createSessionFsAdapter', () => createSessionFsAdapter()],
          ];
          return stubs.map(([name, invoke]) => {
            try {
              invoke();
              return [name, null];
            } catch (error) {
              return [name, error.message];
            }
          });
        }
      `),
      bundleFixture('export function probeNothing() { return 1; }'),
    ]);

    bundleBytes = withSdk.bytes;
    bundleInputs = withSdk.inputs;
    bundleSource = withSdk.source;
    retainedSdkBytes = withSdk.bytes - withoutSdk.bytes;

    const fixtureModule = { exports: {} };
    new Function('module', 'exports', 'require', '__filename', '__dirname', bundleSource)(
      fixtureModule,
      fixtureModule.exports,
      createRequire(path.join(root, 'index.js')),
      path.join(root, 'copilot-sdk-envelope-fixture.cjs'),
      root,
    );
    fixture = fixtureModule.exports as typeof fixture;
  }, 120_000);

  afterAll(() => {
    stop();
  });

  it('retains a working CopilotClient through the production bundle path', () => {
    expect(fixture.probeCopilotClient()).toEqual(['function', 'function']);
    expect(retainedSdkBytes).toBeGreaterThan(retainedSdkLowerBoundBytes);
  });

  it('excludes the native FFI addon and the SDK-bundled CLI', () => {
    expect(inspectCopilotBundleEnvelope(bundleSource))
      .toEqual({ forbidden: [], missingStubs: [] });
    expect(bundleInputs.filter(input => (
      input.includes(`/${nativeFfiPackage}/`)
      || input.includes('/@github/copilot/')
      || /\/@github\/copilot-(?:darwin|linux|linuxmusl|win32)-/.test(input)
      || /\/@github\/copilot-sdk-(?:darwin|linux|linuxmusl|win32)-/.test(input)
      || input.includes('/detect-libc/')
    ))).toEqual([]);
  });

  it('replaces every unsupported SDK transport with a fail-closed stub', () => {
    expect(fixture.probeFailClosedStubs()).toEqual([
      ['CopilotRequestHandler', 'Copilot BYOK request forwarding is disabled in Claudian.'],
      ['CopilotWebSocketForwarder', 'Copilot BYOK request forwarding is disabled in Claudian.'],
      ['CopilotWebSocketHandler', 'Copilot BYOK request forwarding is disabled in Claudian.'],
      [
        'SessionFsSqliteTransactionFailure',
        'Copilot SQLite session storage is disabled in Claudian.',
      ],
      ['SessionFsWriteFailure', 'Copilot SQLite session storage is disabled in Claudian.'],
      ['createSessionFsAdapter', 'Copilot SQLite session storage is disabled in Claudian.'],
    ]);
    // The FFI host is internal to the SDK, so its stub is proven by the rejection it carries
    // into the artifact rather than by construction.
    expect(bundleSource).toContain('Copilot in-process FFI transport is disabled in Claudian.');
    expect(bundleSource).toContain(
      'The Copilot CLI bundled with the SDK is not used by Claudian.',
    );
  });

  it('keeps the Node vscode-jsonrpc transport the CLI stdio connection needs', () => {
    expect(bundleInputs.filter(input => input.includes('/vscode-jsonrpc/lib/node/')))
      .toEqual(expect.arrayContaining([
        expect.stringContaining('/vscode-jsonrpc/lib/node/main.js'),
        expect.stringContaining('/vscode-jsonrpc/lib/node/ril.js'),
      ]));
    expect(bundleInputs.filter(input => input.includes('/vscode-jsonrpc/lib/browser/')))
      .toEqual([]);
    expect(bundleSource).toContain('Content-Length');
  });

  it('fits the fork bundle budget with headroom for the first SDK consumer', () => {
    const projectedMainBytes = preCopilotBaselineBytes + retainedSdkBytes;

    expect(retainedSdkBytes).toBeLessThanOrEqual(retainedSdkUpperBoundBytes);
    expect(preCopilotBaselineBytes + retainedSdkUpperBoundBytes)
      .toBeLessThanOrEqual(forkBudgetBytes);
    expect(projectedMainBytes).toBeLessThanOrEqual(forkBudgetBytes);
    expect(forkBudgetBytes - projectedMainBytes)
      .toBeGreaterThanOrEqual(requiredProjectedHeadroomBytes);
    expect(forkBudgetBytes - upstreamCeilingBytes).toBe(250_000);
    expect(bundleBytes).toBeGreaterThan(retainedSdkBytes);
  });

  it('declares optional platform runtimes and installs the native FFI dependency it refuses to bundle', () => {
    const sdkManifest = JSON.parse(readFileSync(
      path.join(root, 'node_modules', '@github', 'copilot-sdk', 'package.json'), 'utf8',
    )) as { optionalDependencies: Record<string, string> };
    expect(Object.keys(sdkManifest.optionalDependencies).filter(name => platformCliPackagePattern.test(name)).length)
      .toBeGreaterThan(0);
    expect(existsSync(path.join(root, 'node_modules', nativeFfiPackage))).toBe(true);
  });
});
