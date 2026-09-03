#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VividClient, DEFAULT_API_URL } from './client.js';
import { registerTools } from './tools.js';

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

const client = new VividClient({ apiKey, apiUrl: process.env.VIVID_API_URL ?? DEFAULT_API_URL });

const server = new McpServer(
  { name: 'vivid-mcp', version: '0.1.2' },
  {
    instructions: [
      'VIVID is an AI content studio for e-commerce (vividai.tv). This server drives the account linked to VIVID_API_KEY.',
      'Typical flow: vivid_whoami → vivid_list_models → vivid_generate_image / vivid_generate_video → vivid_job_status → vivid_download_asset or vivid_share_asset.',
      'Local files must be uploaded with vivid_upload_file before being used as references, frames or audio.',
      'Every generation costs credits; the models list shows the price. Check credits with vivid_whoami before large batches.',
    ].join(' '),
  },
);

registerTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
