import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { VividClient, DEFAULT_API_URL } from './client.js';
import { registerTools } from './tools.js';
import { VERSION, INSTRUCTIONS } from './meta.js';

/**
 * vivid-mcp as a remote MCP server (Cloudflare Worker, Streamable HTTP).
 *
 *   POST https://mcp.vividai.tv/mcp
 *   Authorization: Bearer vk_…        (or X-API-Key: vk_…)
 *
 * Stateless by design: every request builds a fresh McpServer bound to the
 * caller's API key, so nothing is shared between users and there is no
 * session to lose when the Worker is evicted. The client's `initialize` and
 * the tool calls are independent HTTP requests, which the Streamable HTTP
 * spec allows when no session id is issued.
 *
 * What is NOT here, on purpose: vivid_download_asset, vivid_record_ui, local
 * file paths, outputDir/outputPath (all need the user's machine — they live
 * in the stdio server, see tools-local.ts). Assets are returned as URLs.
 *
 * Not yet: OAuth. Claude.ai / Claude Desktop "custom connectors" want an
 * OAuth authorization server; until that exists, this endpoint serves
 * clients that can send a header (Claude Code, Cursor, agents, curl).
 */

interface Env {
  VIVID_API_URL?: string;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-API-Key, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });

function apiKeyFrom(request: Request): string | null {
  const auth = request.headers.get('authorization');
  const bearer = auth && /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  const key = bearer || request.headers.get('x-api-key')?.trim() || null;
  // Only printable ASCII can travel in a header; a pasted masked key ("vk_••••") must be refused clearly.
  return key && /^[\x21-\x7e]+$/.test(key) ? key : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResponse(200, {
        name: 'vivid-mcp', version: VERSION, transport: 'streamable-http', endpoint: `${url.origin}/mcp`,
        auth: 'Authorization: Bearer <VIVID API key> (vividai.tv → Settings → API key)',
        docs: 'https://vividai.tv/mcp', source: 'https://github.com/loopotv/vivid-mcp',
      });
    }

    if (url.pathname !== '/mcp') return jsonResponse(404, { error: 'not found', hint: 'the MCP endpoint is /mcp' });

    const apiKey = apiKeyFrom(request);
    if (!apiKey) {
      return jsonResponse(401, {
        error: 'missing or malformed API key',
        hint: 'send "Authorization: Bearer vk_…" with your VIVID API key (vividai.tv → Settings → API key). If you pasted "vk_••••", reveal the key first.',
      }, { 'WWW-Authenticate': 'Bearer realm="vivid-mcp"' });
    }

    const client = new VividClient({ apiKey, apiUrl: env.VIVID_API_URL ?? DEFAULT_API_URL });
    const server = new McpServer({ name: 'vivid-mcp', version: VERSION }, { instructions: INSTRUCTIONS });
    registerTools(server, client); // no LocalIo: remote mode

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const res = await transport.handleRequest(request);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    } finally {
      // The transport is per request; nothing else to release.
    }
  },
};
