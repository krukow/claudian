const fsPromises = require('node:fs/promises');
const path = require('node:path');

const envelopeRequire = require;

/**
 * The Copilot SDK reaches the Copilot CLI over stdio JSON-RPC. Everything else it can
 * reach for — the in-process FFI runtime, the BYOK request forwarder, and the SQLite
 * session store — is unsupported in Claudian and is replaced with a fail-closed stub so
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
  sessionFsProvider: {
    classExports: ['SessionFsSqliteTransactionFailure'],
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

/**
 * The SDK falls back to the CLI that ships inside its own dependency graph when no path is
 * supplied. Claudian always supplies one, but leaving the fallback in the bundle keeps a
 * path to a runtime the user never installed, and drags the platform package names in with
 * it. Both resolvers are replaced with a throw so the fallback cannot fire and the graph
 * leaves no trace in `main.js`.
 */
const bundledCliResolvers = Object.freeze([
  'getCliPlatformPackageNames',
  'getBundledCliPath',
]);

const bundledCliRejection =
  'The Copilot CLI bundled with the SDK is not used by Claudian. '
  + 'Install the copilot CLI and set its path in Copilot settings.';

function stripBundledCliResolvers(contents, modulePath) {
  let patched = contents;
  for (const name of bundledCliResolvers) {
    const declaration = new RegExp(`function ${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}\\n`);
    if (!declaration.test(patched)) {
      throw new Error(
        `Copilot SDK bundle envelope could not neutralize ${name} in ${modulePath}. `
        + 'The SDK changed shape; revisit the envelope instead of shipping the fallback.',
      );
    }
    patched = patched.replace(
      declaration,
      `function ${name}() { throw new Error(${JSON.stringify(bundledCliRejection)}); }\n`,
    );
  }
  return patched;
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

function createCopilotSdkBundleEnvelopePlugin() {
  const unsupportedFilter = new RegExp(
    `[\\\\/]node_modules[\\\\/]@github[\\\\/]copilot-sdk[\\\\/]dist[\\\\/](?:cjs[\\\\/])?(?:${
      Object.keys(unsupportedSdkModules).join('|')
    })\\.js$`,
  );
  const clientFilter =
    /[\\/]node_modules[\\/]@github[\\/]copilot-sdk[\\/]dist[\\/](?:cjs[\\/])?client\.js$/;

  return {
    name: 'copilot-sdk-bundle-envelope',
    setup(build) {
      build.onLoad({ filter: unsupportedFilter }, (args) => ({
        contents: unsupportedModuleSource(path.basename(args.path, '.js')),
        loader: 'js',
      }));
      build.onLoad({ filter: clientFilter }, async (args) => ({
        contents: stripBundledCliResolvers(
          await fsPromises.readFile(args.path, 'utf8'),
          args.path,
        ),
        loader: 'js',
      }));
    },
  };
}

module.exports = {
  bundledCliRejection,
  bundledCliResolvers,
  createCopilotSdkBundleEnvelopePlugin,
  createCopilotSdkRuntimeAliases,
  resolveVscodeJsonRpcNodeEntry,
  stripBundledCliResolvers,
  unsupportedSdkModules,
};
