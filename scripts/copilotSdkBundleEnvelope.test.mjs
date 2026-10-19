import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import copilotSdkBundleEnvelope from './copilotSdkBundleEnvelope.js';
import { bundleCriticalRuntimeDependencies } from './runtimeDependencyParity.mjs';

const {
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
  assert.equal(readJson('package.json').dependencies['@github/copilot-sdk'], '1.0.19');
});

test('SDK lockfile URLs remain portable across contributor registry configurations', () => {
  const lock = readJson('package-lock.json');
  const sdk = readJson('node_modules/@github/copilot-sdk/package.json');
  for (const name of [sdk.name, ...Object.keys(sdk.optionalDependencies)]) {
    const entry = lock.packages[`node_modules/${name}`];
    const unscopedName = name.split('/')[1];
    assert.equal(entry.resolved, `https://registry.npmjs.org/${name}/-/${unscopedName}-${entry.version}.tgz`);
  }
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

  assert.equal(loaders.length, 1);
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

test('SDK-bundled runtime initialization fails before resolving or materializing native assets', async () => {
  const plugin = createCopilotSdkBundleEnvelopePlugin();
  const loaders = [];
  plugin.setup({
    onLoad(options, callback) {
      loaders.push({ callback, filter: options.filter });
    },
  });
  const runtimePath = path.join(sdkRoot, 'dist', 'runtimeArtifacts.js');
  const loader = loaders.find(({ filter }) => filter.test(runtimePath));
  assert.ok(loader, 'The runtime materializer must be inside the fail-closed envelope.');
  const stub = await loader.callback({ path: runtimePath });
  const ensureRuntimeBundle = new Function(
    `${stub.contents.replaceAll('export ', '')}\nreturn ensureRuntimeBundle;`,
  )();
  assert.throws(
    () => ensureRuntimeBundle('1.0.95'),
    /The Copilot CLI bundled with the SDK is not used by Claudian/,
  );
});

test('the FFI transport stub keeps the native koffi addon out of the bundle', () => {
  assert.ok('ffiRuntimeHost' in unsupportedSdkModules);
  const ffiSource = fs.readFileSync(path.join(sdkRoot, 'dist', 'ffiRuntimeHost.js'), 'utf8');
  assert.match(ffiSource, /from "koffi"/);

  const clientSource = fs.readFileSync(path.join(sdkRoot, 'dist', 'client.js'), 'utf8');
  assert.match(clientSource, /await import\("\.\/ffiRuntimeHost\.js"\)/);
  assert.doesNotMatch(clientSource, /from "koffi"/);
});

test('the SDK declares optional platform runtimes and an ordinary FFI dependency', () => {
  const sdkManifest = readJson('node_modules/@github/copilot-sdk/package.json');
  const platformPackages = Object.entries(sdkManifest.optionalDependencies ?? {});

  assert.equal(sdkManifest.dependencies.koffi !== undefined, true);
  assert.equal(sdkManifest.dependencies['@github/copilot'], undefined);
  assert.ok(platformPackages.length > 0);
  assert.ok(platformPackages.every(([name, version]) => (
    name.startsWith('@github/copilot-sdk-') && version === sdkManifest.version
  )));
  assert.equal(fs.existsSync(path.join(root, 'node_modules', 'koffi')), true);

  assert.ok('ffiRuntimeHost' in unsupportedSdkModules);
  for (const marker of ['koffi', 'getBundledCliPath', '@github/copilot-sdk-darwin']) {
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
