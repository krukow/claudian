const { createRequire } = require('node:module');

const sdkRequire = createRequire(require.resolve('@microsoft/copilot-sdk'));
const { createMessageConnection, ErrorCodes, ResponseError, StreamMessageReader, StreamMessageWriter } =
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
connection.onRequest('mcp.discover', () => ({ servers: [] }));
connection.onRequest('session.create', ({ sessionId }) => ({ sessionId }));
connection.onRequest('session.delete', () => ({ success: true }));
connection.onRequest('session.detach', () => ({ success: true }));
connection.onRequest('session.remote.disable', () => ({}));
connection.onRequest('session.options.update', () => ({ success: true }));
connection.onRequest('session.commands.invoke', () => ({ kind: 'text', text: 'OK' }));

async function finishAfterInput(sessionId) {
  await connection.sendRequest('userInput.request', { sessionId, question: 'Continue the fixture turn?' });
  const event = { id: 'idle', type: 'session.idle', data: {} };
  await connection.sendNotification('session.event', { sessionId, event });
}
connection.onRequest('session.sendAndWait', async ({ sessionId, prompt }) => {
  if (prompt === 'event fallback') throw new ResponseError(ErrorCodes.MethodNotFound, 'unsupported');
  await finishAfterInput(sessionId);
  return { completionEventId: 'idle' };
});
connection.onRequest('session.send', async ({ sessionId }) => {
  const messageId = 'fixture-message';
  await connection.sendNotification('session.event', {
    sessionId, event: { type: 'user.message', id: 'user', data: { messageId, content: 'event fallback' } },
  });
  await finishAfterInput(sessionId);
  return { messageId };
});
connection.listen();
