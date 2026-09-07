import { createServer } from 'node:http';

export interface LocalModelServer {
  readonly baseUrl: string;
  readonly completionRequests: readonly string[];
  close(): Promise<void>;
}

export async function startLocalModelServer(toolCallName?: string): Promise<LocalModelServer> {
  const completionRequests: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        completionRequests.push(body);
        response.setHeader('content-type', 'text/event-stream');
        const chunk = {
          created: 0,
          id: 'chatcmpl-claudian-native-fixture',
          model: 'gpt-4o',
          object: 'chat.completion.chunk',
        };
        const invokeTool = toolCallName !== undefined && completionRequests.length === 1;
        response.write(`data: ${JSON.stringify({
          ...chunk,
          choices: [{
            delta: invokeTool
              ? {
                role: 'assistant',
                tool_calls: [{
                  function: { arguments: '{}', name: toolCallName },
                  id: 'fixture-tool-call',
                  index: 0,
                  type: 'function',
                }],
              }
              : { content: 'Synthetic local completion.', role: 'assistant' },
            finish_reason: null,
            index: 0,
          }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          ...chunk,
          choices: [{
            delta: {}, finish_reason: invokeTool ? 'tool_calls' : 'stop', index: 0,
          }],
          usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
        })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else if (request.method === 'GET' && request.url === '/v1/models') {
        response.end(JSON.stringify({
          data: [{ id: 'gpt-4o', object: 'model' }],
          object: 'list',
        }));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: { message: 'Unknown fixture endpoint.' } }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('The local model fixture did not acquire a TCP port.');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    completionRequests,
    close() {
      const closing = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      return closing;
    },
  };
}
