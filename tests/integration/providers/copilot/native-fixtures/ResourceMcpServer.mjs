import { appendFileSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const marker = process.env.CLAUDIAN_SMOKE_MARKER;
if (!marker) {
  throw new Error('The resource fixture requires a startup marker path.');
}
appendFileSync(marker, 'started\n');

const server = new McpServer({ name: 'claudian-resource-fixture', version: '1.0.0' });
server.registerTool('read_note', {
  description: 'Read a synthetic note.',
  annotations: { readOnlyHint: true },
}, async () => ({
  content: [{ type: 'text', text: 'Synthetic note.' }],
}));
server.registerTool('write_note', {
  description: 'Record a synthetic tool invocation.',
  annotations: { readOnlyHint: false },
}, async () => {
  appendFileSync(marker, 'write_note\n');
  return { content: [{ type: 'text', text: 'Synthetic note updated.' }] };
});

await server.connect(new StdioServerTransport());
