/**
 * The SDK declares optional platform runtimes and the native `koffi` addon. Claudian
 * always uses the user-installed CLI; neither bundled runtime resolution nor native FFI
 * may reach the Obsidian bundle.
 *
 * What this envelope guarantees is narrower and enforceable: none of it reaches `main.js`,
 * and nothing in the bundle can resolve it at runtime.
 * `tests/integration/build/copilot-sdk-bundle-envelope.test.ts` builds the SDK through the
 * envelope and measures both halves — the graph that must be absent, and the stdio JSON-RPC
 * client that must survive.
 */
const path = require('node:path');

const envelopeRequire = require;
const bundledCliRejection =
  'The Copilot CLI bundled with the SDK is not used by Claudian. '
  + 'Install the copilot CLI and set its path in Copilot settings.';

/**
 * The Copilot SDK reaches the Copilot CLI over stdio JSON-RPC. Everything else it can
 * reach for — the in-process FFI runtime, the BYOK request forwarder, the SQLite
 * session store, and SDK-managed runtime assets — is unsupported in Claudian and is replaced with a fail-closed stub so
 * the native `koffi` addon and its transitive graph never enter the Obsidian bundle.
 */
const unsupportedSdkModules = Object.freeze({
  copilotRequestHandler: {
    classExports: [
      'CopilotRequestHandler',
      'CopilotWebSocketCloseStatus',
      'CopilotWebSocketForwarder',
      'CopilotWebSocketHandler',
    ],
    functionExports: ['createCopilotRequestAdapter'],
    reason: 'Copilot BYOK request forwarding is disabled in Claudian.',
  },
  ffiRuntimeHost: {
    classExports: ['FfiRuntimeHost'],
    functionExports: [],
    reason: 'Copilot in-process FFI transport is disabled in Claudian.',
  },
  runtimeArtifacts: {
    classExports: [],
    functionExports: ['ensureRuntimeBundle'],
    reason: bundledCliRejection,
  },
  sessionFsProvider: {
    classExports: ['SessionFsSqliteTransactionFailure', 'SessionFsWriteFailure'],
    functionExports: ['createSessionFsAdapter'],
    reason: 'Copilot SQLite session storage is disabled in Claudian.',
  },
});

function unsupportedModuleSource(moduleName) {
  const { classExports, functionExports, reason } = unsupportedSdkModules[moduleName];
  return [
    `const reason = ${JSON.stringify(reason)};`,
    ...functionExports.map(exportName => (
      `export function ${exportName}() { throw new Error(reason); }`
    )),
    ...classExports.map(exportName => (
      `export class ${exportName} { constructor() { throw new Error(reason); } }`
    )),
  ].join('\n');
}

function resolveVscodeJsonRpcNodeEntry() {
  return path.join(
    path.dirname(envelopeRequire.resolve('vscode-jsonrpc/node.js')),
    'lib',
    'node',
    'main.js',
  );
}

/**
 * Aliases that must be applied to the browser-targeted Obsidian bundle for the Copilot
 * SDK to keep working. `vscode-jsonrpc` publishes a browser build that cannot read or
 * write the CLI's stdio streams, so the Node implementation is pinned explicitly.
 */
function createCopilotSdkRuntimeAliases() {
  return Object.freeze({
    'vscode-jsonrpc/node.js': resolveVscodeJsonRpcNodeEntry(),
  });
}

/**
 * Markers whose presence in a built artifact would mean the envelope failed: the native FFI
 * addon, the in-process transport that loads it, or a path to the CLI that ships inside the
 * SDK's own dependency graph. The build reads these back out of the bundle, because patching
 * the SDK source is not the guarantee — the artifact is.
 */
const copilotForbiddenBundleMarkers = Object.freeze({
  'koffi': 'the native FFI addon',
  'ffiRuntimeHost': 'the in-process FFI transport module',
  'FfiRuntimeHost.prototype': 'a live in-process FFI transport',
  'getBundledCliPath': 'the SDK-bundled CLI resolver',
  '@github/copilot-linux': 'an SDK-bundled CLI platform package',
  '@github/copilot-darwin': 'an SDK-bundled CLI platform package',
  '@github/copilot-win32': 'an SDK-bundled CLI platform package',
  '@github/copilot-sdk-': 'an SDK-bundled runtime platform package',
  'materializeRuntimeBundle': 'SDK-bundled runtime extraction',
  'Could not resolve a @github/copilot platform package':
    'the SDK-bundled CLI resolution failure path',
});

/**
 * Stubs the envelope installs in place of the transports Claudian does not support. Their
 * absence from an artifact that carries the SDK means the envelope stopped applying, which
 * the forbidden markers alone cannot say: a bundle that dropped the SDK entirely would
 * pass those vacuously.
 */
const copilotRequiredBundleMarkers = Object.freeze([
  'Copilot in-process FFI transport is disabled in Claudian.',
  'Copilot SQLite session storage is disabled in Claudian.',
  'Copilot BYOK request forwarding is disabled in Claudian.',
  'The Copilot CLI bundled with the SDK is not used by Claudian.',
]);

function inspectCopilotBundleEnvelope(bundleContents) {
  return {
    forbidden: Object.entries(copilotForbiddenBundleMarkers)
      .filter(([marker]) => bundleContents.includes(marker))
      .map(([marker, description]) => `${marker} (${description})`),
    missingStubs: copilotRequiredBundleMarkers
      .filter(marker => !bundleContents.includes(marker)),
  };
}

function createCopilotSdkBundleEnvelopePlugin() {
  const unsupportedFilter = new RegExp(
    `[\\\\/]node_modules[\\\\/]@github[\\\\/]copilot-sdk[\\\\/]dist[\\\\/](?:cjs[\\\\/])?(?:${
      Object.keys(unsupportedSdkModules).join('|')
    })\\.js$`,
  );
  return {
    name: 'copilot-sdk-bundle-envelope',
    setup(build) {
      build.onLoad({ filter: unsupportedFilter }, (args) => ({
        contents: unsupportedModuleSource(path.basename(args.path, '.js')),
        loader: 'js',
      }));
    },
  };
}

module.exports = {
  bundledCliRejection,
  createCopilotSdkBundleEnvelopePlugin,
  createCopilotSdkRuntimeAliases,
  inspectCopilotBundleEnvelope,
  resolveVscodeJsonRpcNodeEntry,
  unsupportedSdkModules,
};
