#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VividClient, DEFAULT_API_URL } from './client.js';
import { registerTools } from './tools.js';
import { nodeIo, readLocalFile, registerLocalTools } from './tools-local.js';
import { VERSION, INSTRUCTIONS, LOCAL_INSTRUCTIONS } from './meta.js';
import { CLI_COMMANDS, runCli } from './cli.js';

const cliArgs = process.argv.slice(2);
const cli = CLI_COMMANDS.has(cliArgs[0] ?? '');
// Listing tools and reading their schemas works without an account.
const needsKey = !cli || cliArgs[0] === 'call';

const apiKey = process.env.VIVID_API_KEY;
if (needsKey && !apiKey) {
  console.error('vivid-mcp: VIVID_API_KEY is not set. Create an API key on https://vividai.tv/settings and export it, e.g.\n' +
    (cli ? '  export VIVID_API_KEY=vk_…' : '  "env": { "VIVID_API_KEY": "vk_…" }\nin your MCP client configuration.'));
  process.exit(1);
}

// A key copied by hand from the masked box on vividai.tv/settings arrives as
// "vk_••••…": non-ASCII, so fetch() would die with an opaque ByteString error.
if (apiKey && !/^[\x21-\x7e]+$/.test(apiKey)) {
  console.error('vivid-mcp: VIVID_API_KEY contains characters that cannot go in an HTTP header' +
    (apiKey.includes('•') ? ' — it looks like the masked key ("vk_••••"). Reveal the key (eye icon) or use the Copy button on https://vividai.tv/settings and paste the full key.' : '.'));
  process.exit(1);
}

function makeServer(): McpServer {
  const client = new VividClient({ apiKey: apiKey ?? 'vk_unset', apiUrl: process.env.VIVID_API_URL ?? DEFAULT_API_URL, readLocal: readLocalFile });
  const server = new McpServer({ name: 'vivid-mcp', version: VERSION }, { instructions: INSTRUCTIONS + LOCAL_INSTRUCTIONS });
  registerTools(server, client, nodeIo);
  registerLocalTools(server, client);
  return server;
}

if (cli) {
  try {
    process.exitCode = await runCli(cliArgs, makeServer);
  } catch (e) {
    console.error(`vivid-mcp: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
} else {
  await makeServer().connect(new StdioServerTransport());
}
