const { createRequire } = require('node:module');

const sdkRequire = createRequire(require.resolve('@microsoft/copilot-sdk'));
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } =
  sdkRequire('vscode-jsonrpc/node');

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
let connected = false;
connection.onRequest('connect', () => {
  connected = true;
  return { protocolVersion: 4 };
});
connection.onRequest('auth.getStatus', () => ({ isAuthenticated: connected }));
connection.onRequest('session.create', ({ sessionId }) => ({ sessionId }));
connection.onRequest('session.delete', () => ({ success: true }));
connection.listen();
