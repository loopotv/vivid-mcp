import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { VERSION } from './meta.js';

/**
 * Command-line face of the same server: `vivid-mcp call <tool> '<json>'` goes
 * through an in-memory MCP client, so arguments are validated by the same zod
 * schemas and every tool behaves exactly as it does over stdio. This is what
 * the vivid-studio skill uses when the agent has a shell but no MCP connection.
 */

/** Longest tool wait (vivid_render_project timeoutSec 1800) plus margin. */
const CALL_TIMEOUT_MS = 35 * 60_000;

export const CLI_COMMANDS =new Set(['call', 'tools', 'schema', 'help', '--help', '-h', '--version', '-v']);

const USAGE = `vivid-mcp ${VERSION}

Without arguments: MCP server on stdio (for Claude, Cursor, Codex…).

Command line (same tools, needs VIVID_API_KEY for "call"):
  vivid-mcp tools                      list every tool with its title
  vivid-mcp schema <tool>              description + JSON schema of the arguments
  vivid-mcp call <tool> ['<json>']     run a tool; arguments as JSON
  vivid-mcp call <tool> @args.json     … read from a file
  vivid-mcp call <tool> -              … read from stdin

Output: the tool's text result on stdout (JSON for most tools).
Exit code 1 when the tool reports an error.`;

async function readArgs(raw: string | undefined): Promise<Record<string, unknown>> {
  let text: string;
  if (raw === undefined) {
    if (process.stdin.isTTY) return {};
    text = await readStdin();
  } else if (raw === '-') text = await readStdin();
  else if (raw.startsWith('@')) text = await readFile(raw.slice(1), 'utf8');
  else text = raw;
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool arguments must be a JSON object, e.g. {"prompt":"…"}');
  return parsed as Record<string, unknown>;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'vivid-cli', version: VERSION });
  await client.connect(clientTransport);
  return client;
}

/** Returns the process exit code. */
export async function runCli(argv: string[], makeServer: () => McpServer): Promise<number> {
  const [cmd, name, rawArgs] = argv;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); return 0; }
  if (cmd === '--version' || cmd === '-v') { console.log(VERSION); return 0; }

  const client = await connect(makeServer());
  try {
    if (cmd === 'tools') {
      const { tools } = await client.listTools();
      for (const t of tools) console.log(`${t.name.padEnd(30)} ${t.title ?? t.annotations?.title ?? ''}`);
      return 0;
    }

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === name || t.name === `vivid_${name}`);
    if (!tool) {
      console.error(name ? `Unknown tool "${name}". Run "vivid-mcp tools" for the list.` : USAGE);
      return 1;
    }

    if (cmd === 'schema') {
      console.log(`${tool.name} — ${tool.title ?? ''}\n\n${tool.description ?? ''}\n\n${JSON.stringify(tool.inputSchema, null, 2)}`);
      return 0;
    }

    const args = await readArgs(rawArgs);
    // The SDK's default request timeout is 60 s; tools with wait/timeoutSec
    // (analysis, generations, renders) bound themselves, so the CLI must not.
    const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    for (const c of result.content as Array<{ type: string; text?: string; mimeType?: string }>) {
      if (c.type === 'text') console.log(c.text);
      else console.log(`[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''} content omitted]`);
    }
    return result.isError ? 1 : 0;
  } finally {
    await client.close();
  }
}
