import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import copilotSdkBundleEnvelope from './copilotSdkBundleEnvelope.js';
import { bundleCriticalRuntimeDependencies } from './runtimeDependencyParity.mjs';

const {
  bundledCliResolvers,
  createCopilotSdkBundleEnvelopePlugin,
  createCopilotSdkRuntimeAliases,
  inspectCopilotBundleEnvelope,
  resolveVscodeJsonRpcNodeEntry,
  unsupportedSdkModules,
} = copilotSdkBundleEnvelope;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = path.join(root, 'node_modules', '@github', 'copilot-sdk');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

test('the Copilot SDK is pinned to an exact bundle-critical version', () => {
  assert.ok(bundleCriticalRuntimeDependencies.includes('@github/copilot-sdk'));
  assert.equal(readJson('package.json').dependencies['@github/copilot-sdk'], '1.0.11');
});

test('vscode-jsonrpc resolves to the Node implementation, not the browser build', () => {
  const aliases = createCopilotSdkRuntimeAliases();
  const nodeEntry = aliases['vscode-jsonrpc/node.js'];

  assert.equal(nodeEntry, resolveVscodeJsonRpcNodeEntry());
  assert.ok(nodeEntry.endsWith(path.join('lib', 'node', 'main.js')));
  assert.ok(fs.existsSync(nodeEntry));
  assert.match(fs.readFileSync(nodeEntry, 'utf8'), /StreamMessageReader/);
});

test('the Copilot SDK imports the Node vscode-jsonrpc subpath the alias pins', () => {
  for (const entry of ['dist/client.js', 'dist/session.js']) {
    assert.match(
      fs.readFileSync(path.join(sdkRoot, entry), 'utf8'),
      /from "vscode-jsonrpc\/node\.js"/,
    );
  }
});

test('unsupported Copilot SDK transports are replaced with fail-closed stubs', async () => {
  const plugin = createCopilotSdkBundleEnvelopePlugin();
  const loaders = [];
  plugin.setup({
    onLoad(options, callback) {
      loaders.push({ callback, filter: options.filter });
    },
  });

  assert.equal(loaders.length, 2);
  const [{ callback, filter }] = loaders;

  for (const moduleName of Object.keys(unsupportedSdkModules)) {
    const modulePath = path.join(sdkRoot, 'dist', `${moduleName}.js`);
    assert.ok(fs.existsSync(modulePath), `${moduleName} is no longer part of the SDK`);
    assert.match(modulePath, filter);

    const stub = await callback({ path: modulePath });
    assert.equal(stub.loader, 'js');
    const { classExports, functionExports } = unsupportedSdkModules[moduleName];
    for (const exportName of [...classExports, ...functionExports]) {
      assert.ok(
        stub.contents.includes(exportName),
        `${moduleName} stub is missing ${exportName}`,
      );
    }
    assert.ok(stub.contents.includes('throw new Error(reason)'));
  }
});

test('the SDK-bundled CLI resolvers are replaced with a throw', async () => {
  const plugin = createCopilotSdkBundleEnvelopePlugin();
  const loaders = [];
  plugin.setup({
    onLoad(options, callback) {
      loaders.push({ callback, filter: options.filter });
    },
  });
  const clientLoader = loaders[1];
  const clientPath = path.join(sdkRoot, 'dist', 'client.js');

  assert.match(clientPath, clientLoader.filter);
  const patched = await clientLoader.callback({ path: clientPath });

  assert.equal(patched.loader, 'js');
  assert.match(patched.contents, /function getBundledCliPath\(\) \{ throw new Error\(/);
  assert.match(patched.contents, /function getCliPlatformPackageNames\(\) \{ throw/);
  assert.equal(patched.contents.includes('@github/copilot-${variant}-${arch}'), false);
});

test('the FFI transport stub keeps the native koffi addon out of the bundle', () => {
  assert.ok('ffiRuntimeHost' in unsupportedSdkModules);
  const ffiSource = fs.readFileSync(path.join(sdkRoot, 'dist', 'ffiRuntimeHost.js'), 'utf8');
  assert.match(ffiSource, /from "koffi"/);

  const clientSource = fs.readFileSync(path.join(sdkRoot, 'dist', 'client.js'), 'utf8');
  assert.match(clientSource, /await import\("\.\/ffiRuntimeHost\.js"\)/);
  assert.doesNotMatch(clientSource, /from "koffi"/);
});

/**
 * Installing the SDK is not free: `@github/copilot` and `koffi` are ordinary dependencies of
 * `@github/copilot-sdk`, so every install pulls the native FFI addon and one per-platform
 * Copilot CLI (~276-312 MB unpacked) into `node_modules`. Claudian bundles and resolves
 * neither. This test fails when that shape changes, so the disclosure in the envelope and in
 * the build tests stays true rather than quietly describing an older SDK.
 */
test('the SDK install cost the envelope contains is a transitive dependency, not an extra', () => {
  const sdkManifest = readJson('node_modules/@github/copilot-sdk/package.json');
  const cliManifest = readJson('node_modules/@github/copilot/package.json');
  const platformPackages = Object.keys(cliManifest.optionalDependencies ?? {});

  assert.equal(sdkManifest.dependencies.koffi !== undefined, true);
  assert.equal(sdkManifest.dependencies['@github/copilot'] !== undefined, true);
  assert.ok(platformPackages.length > 0);
  assert.ok(platformPackages.every(name => name.startsWith('@github/copilot-')));
  assert.equal(fs.existsSync(path.join(root, 'node_modules', 'koffi')), true);

  assert.ok('ffiRuntimeHost' in unsupportedSdkModules);
  assert.deepEqual(bundledCliResolvers, ['getCliPlatformPackageNames', 'getBundledCliPath']);
  for (const marker of ['koffi', 'getBundledCliPath', '@github/copilot-darwin']) {
    assert.equal(inspectCopilotBundleEnvelope(marker).forbidden.length, 1);
  }
});

/**
 * The forbidden markers alone cannot say the envelope still applies: a bundle that dropped
 * the SDK carries none of them either. The stubs it installs are the other half, so an
 * artifact that links the SDK has to carry all four.
 */
test('the envelope reports a bundle that carries the SDK without its fail-closed stubs', () => {
  const withoutStubs = inspectCopilotBundleEnvelope('nothing here');

  assert.deepEqual(withoutStubs.forbidden, []);
  assert.equal(withoutStubs.missingStubs.length, 4);

  const withStubs = inspectCopilotBundleEnvelope(withoutStubs.missingStubs.join('\n'));

  assert.deepEqual(withStubs, { forbidden: [], missingStubs: [] });
});

test('the production bundle applies the Copilot SDK envelope', () => {
  const config = fs.readFileSync(path.join(root, 'esbuild.config.mjs'), 'utf8');
  assert.match(config, /createCopilotSdkRuntimeAliases\(\)/);
  assert.match(config, /createCopilotSdkBundleEnvelopePlugin\(\)/);
});
