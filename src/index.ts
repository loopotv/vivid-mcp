#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VividClient, DEFAULT_API_URL } from './client.js';
import { registerTools } from './tools.js';
import { nodeIo, readLocalFile, registerLocalTools } from './tools-local.js';
import { VERSION, INSTRUCTIONS, LOCAL_INSTRUCTIONS } from './meta.js';

const apiKey = process.env.VIVID_API_KEY;
if (!apiKey) {
  console.error('vivid-mcp: VIVID_API_KEY is not set. Create an API key on https://vividai.tv/settings and export it, e.g.\n' +
    '  "env": { "VIVID_API_KEY": "vk_…" }\nin your MCP client configuration.');
  process.exit(1);
}

// A key copied by hand from the masked box on vividai.tv/settings arrives as
// "vk_••••…": non-ASCII, so fetch() would die with an opaque ByteString error.
if (!/^[\x21-\x7e]+$/.test(apiKey)) {
  console.error('vivid-mcp: VIVID_API_KEY contains characters that cannot go in an HTTP header' +
    (apiKey.includes('•') ? ' — it looks like the masked key ("vk_••••"). Reveal the key (eye icon) or use the Copy button on https://vividai.tv/settings and paste the full key.' : '.'));
  process.exit(1);
}

const client = new VividClient({ apiKey, apiUrl: process.env.VIVID_API_URL ?? DEFAULT_API_URL, readLocal: readLocalFile });

const server = new McpServer({ name: 'vivid-mcp', version: VERSION }, { instructions: INSTRUCTIONS + LOCAL_INSTRUCTIONS });

registerTools(server, client, nodeIo);
registerLocalTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
