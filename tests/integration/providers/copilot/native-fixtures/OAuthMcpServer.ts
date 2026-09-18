import { createServer } from 'node:http';

export interface OAuthMcpFixture {
  readonly url: string;
  readonly tokenExchanges: number;
  approve(authorizationUrl: string): Promise<void>;
  close(): Promise<void>;
}

export async function startOAuthMcpServer(): Promise<OAuthMcpFixture> {
  let origin = '';
  let tokenExchanges = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/.well-known/oauth-protected-resource') {
        response.end(JSON.stringify({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ['mcp'],
        }));
      } else if (request.url === '/.well-known/oauth-authorization-server') {
        response.end(JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: ['mcp'],
        }));
      } else if (request.url === '/register') {
        response.writeHead(201);
        response.end(JSON.stringify({
          client_id: 'synthetic-mcp-client',
          token_endpoint_auth_method: 'none',
        }));
      } else if (request.url === '/token') {
        tokenExchanges += 1;
        response.end(JSON.stringify({
          access_token: 'synthetic-mcp-access-token',
          refresh_token: 'synthetic-mcp-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'mcp',
        }));
      } else if (request.url === '/mcp') {
        if (request.headers.authorization !== 'Bearer synthetic-mcp-access-token') {
          response.setHeader('www-authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
          response.writeHead(401).end('{"error":"unauthorized"}');
          return;
        }
        if (request.method !== 'POST') {
          response.writeHead(405).end();
          return;
        }
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id?: number | string;
          method: string;
        };
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: message.method === 'initialize'
            ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'OAuth fixture', version: '1.0.0' },
            }
            : { tools: [{
              name: 'read_note',
              description: 'Read a synthetic note',
              inputSchema: { type: 'object', properties: {} },
            }] },
        }));
      } else {
        response.writeHead(404).end('{"error":"unknown fixture endpoint"}');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No OAuth fixture port.');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/mcp`,
    get tokenExchanges() { return tokenExchanges; },
    async approve(authorizationUrl) {
      const authorization = new URL(authorizationUrl);
      if (authorization.origin !== origin) throw new Error('Refusing non-fixture authorization.');
      const callback = new URL(authorization.searchParams.get('redirect_uri') ?? '');
      if (callback.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(callback.hostname)) {
        throw new Error('Refusing non-loopback callback.');
      }
      callback.searchParams.set('code', 'synthetic-mcp-code');
      callback.searchParams.set('state', authorization.searchParams.get('state') ?? '');
      await fetch(callback, { redirect: 'manual' });
    },
    close() {
      const closed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      return closed;
    },
  };
}
