import { OAuthProvider, type AuthRequest, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { VividClient, DEFAULT_API_URL } from './client.js';
import { registerTools } from './tools.js';
import { VERSION, INSTRUCTIONS } from './meta.js';

/**
 * vivid-mcp as a remote MCP server (Cloudflare Worker, Streamable HTTP).
 *
 *   POST https://mcp.vividai.tv/mcp
 *
 * Two ways in:
 *
 *   1. `Authorization: Bearer vk_…` (or `X-API-Key: vk_…`) — the user's VIVID
 *      API key on every request. Claude Code, Cursor, curl, agents.
 *
 *   2. OAuth 2.1 — what ChatGPT and Claude.ai "connectors" require. This
 *      Worker is the authorization server (metadata, dynamic client
 *      registration, PKCE, /token, refresh) via @cloudflare/workers-oauth-provider
 *      with OAUTH_KV as its store. The consent screen is NOT here: /authorize
 *      parks the request under a txn id and sends the browser to
 *      vividai.tv/oauth/consent, where the user is already logged in. The app
 *      calls the VIVID API (POST /api/oauth/grant), which mints a dedicated
 *      connection token (`vc_…`, revocable from Settings) and a one-time code;
 *      /authorize/callback swaps the code for the token (POST /api/oauth/exchange),
 *      stores it in the grant props and redirects back to the client. Every
 *      later /mcp call then acts with that `vc_` token as X-API-Key.
 *
 * Stateless MCP by design: every request builds a fresh McpServer bound to the
 * caller's credential, so nothing is shared between users and there is no
 * session to lose when the Worker is evicted.
 *
 * What is NOT here, on purpose: vivid_download_asset, vivid_record_ui, local
 * file paths, outputDir/outputPath (all need the user's machine — they live
 * in the stdio server, see tools-local.ts). Assets are returned as URLs.
 */

interface Env {
  VIVID_API_URL?: string;
  CONSENT_URL?: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /**
   * Static files to serve under /.well-known/, as JSON: {"<path>": "<body>"}.
   * Used for domain verification (OpenAI's directory submission hands out a
   * path and a token to publish on the MCP hostname). Kept as a var so adding
   * one is a config change, not a code change. The OAuth documents are served
   * by the provider and always win.
   */
  WELL_KNOWN_JSON?: string;
}

/** What the OAuth grant carries to /mcp (encrypted at rest by the provider). */
interface Props {
  apiKey: string;   // `vk_…` (direct) or `vc_…` (OAuth connection token)
  email?: string;
}

const TXN_TTL_SECONDS = 600;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-API-Key, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });

// Only printable ASCII can travel in a header; a pasted masked key ("vk_••••") must be refused clearly.
const isPrintableKey = (key: string) => /^[\x21-\x7e]+$/.test(key);
const isVividKey = (key: string) => /^v[kc]_[0-9a-f]{16,}$/i.test(key);

function randomId(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** One MCP round-trip with the given credential. */
async function handleMcp(request: Request, env: Env, apiKey: string): Promise<Response> {
  // Stateless: there is no server-initiated stream to subscribe to. Answer
  // 405 instead of holding an SSE connection open that will never emit.
  if (request.method === 'GET') return jsonResponse(405, { error: 'method not allowed', hint: 'POST JSON-RPC to /mcp' }, { Allow: 'POST, OPTIONS' });
  const client = new VividClient({ apiKey, apiUrl: env.VIVID_API_URL ?? DEFAULT_API_URL });
  const server = new McpServer({ name: 'vivid-mcp', version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, client); // no LocalIo: remote mode

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const res = await transport.handleRequest(request);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * OIDC userinfo. Enterprise workspaces restrict a connector by email domain,
 * which needs an OIDC identity next to the OAuth grant: this returns the
 * VIVID account behind the token, with `email_verified` straight from the
 * account's verification stamp. Same credential as /mcp — the props the
 * provider hands over — so no extra secret is involved.
 */
const userinfoHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const apiKey = (ctx.props as Props | undefined)?.apiKey;
    if (!apiKey) return jsonResponse(401, { error: 'invalid_token' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
    const res = await fetch(`${env.VIVID_API_URL ?? DEFAULT_API_URL}/api/me`, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' } });
    const body = await res.json().catch(() => null) as { success?: boolean; data?: { id: string; email: string; name?: string; email_verified_at?: string | null } } | null;
    if (!res.ok || !body?.success || !body.data) {
      return jsonResponse(401, { error: 'invalid_token' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
    }
    const u = body.data;
    return jsonResponse(200, {
      sub: u.id,
      email: u.email,
      email_verified: Boolean(u.email_verified_at),
      name: u.name || undefined,
    });
  },
};

// ── /mcp behind the provider: ctx.props holds the credential ────────────────
const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const apiKey = (ctx.props as Props | undefined)?.apiKey;
    if (!apiKey) return jsonResponse(401, { error: 'grant has no credential — reconnect the app' });
    return handleMcp(request, env, apiKey);
  },
};

// ── Everything else: landing, /authorize, /authorize/callback ────────────────
const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResponse(200, {
        name: 'vivid-mcp', version: VERSION, transport: 'streamable-http', endpoint: `${url.origin}/mcp`,
        auth: [
          'OAuth 2.1 (ChatGPT / Claude.ai connectors): discovery at /.well-known/oauth-protected-resource',
          'Authorization: Bearer <VIVID API key> (vividai.tv → Settings → API key)',
        ],
        docs: 'https://vividai.tv/mcp', source: 'https://github.com/loopotv/vivid-mcp',
      });
    }

    if (url.pathname === '/.well-known/openid-configuration') return jsonResponse(200, openidConfiguration(url.origin));
    if (url.pathname === '/.well-known/jwks.json') return jsonResponse(200, { keys: [] });

    if (url.pathname.startsWith('/.well-known/')) {
      const files = JSON.parse(env.WELL_KNOWN_JSON ?? '{}') as Record<string, string>;
      const body = files[url.pathname];
      if (body !== undefined) {
        return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS } });
      }
    }

    if (url.pathname === '/authorize') return startAuthorize(request, env);
    if (url.pathname === '/authorize/callback') return finishAuthorize(request, env);

    return jsonResponse(404, { error: 'not found', hint: 'the MCP endpoint is /mcp' });
  },
};

/** Park the OAuth request and send the user to the consent page on vividai.tv. */
async function startAuthorize(request: Request, env: Env): Promise<Response> {
  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    return jsonResponse(400, { error: 'invalid_request', description: err instanceof Error ? err.message : String(err) });
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) return jsonResponse(400, { error: 'invalid_client', description: 'unknown client_id — register first (POST /register)' });

  const txn = randomId();
  await env.OAUTH_KV.put(`txn:${txn}`, JSON.stringify(authRequest), { expirationTtl: TXN_TTL_SECONDS });

  const consent = new URL(env.CONSENT_URL ?? 'https://vividai.tv/oauth/consent');
  consent.searchParams.set('txn', txn);
  consent.searchParams.set('client', client.clientName ?? 'MCP client');
  consent.searchParams.set('client_id', client.clientId);
  consent.searchParams.set('callback', `${new URL(request.url).origin}/authorize/callback`);
  return Response.redirect(consent.toString(), 302);
}

/** Back from vividai.tv with a one-time code: exchange it, complete the grant, return to the client. */
async function finishAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const txn = url.searchParams.get('txn') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const denied = url.searchParams.get('error');

  const key = `txn:${txn}`;
  const raw = txn ? await env.OAUTH_KV.get(key) : null;
  if (!raw) return jsonResponse(400, { error: 'invalid_request', description: 'authorization transaction expired — start again from the client' });
  await env.OAUTH_KV.delete(key);
  const authRequest = JSON.parse(raw) as AuthRequest;

  const backToClient = (params: Record<string, string>) => {
    const to = new URL(authRequest.redirectUri);
    for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
    if (authRequest.state) to.searchParams.set('state', authRequest.state);
    return Response.redirect(to.toString(), 302);
  };

  if (denied) return backToClient({ error: 'access_denied', error_description: 'the user declined' });
  if (!code) return backToClient({ error: 'invalid_request', error_description: 'missing code' });

  const apiUrl = env.VIVID_API_URL ?? DEFAULT_API_URL;
  const res = await fetch(`${apiUrl}/api/oauth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, txn }),
  });
  const body = await res.json().catch(() => null) as { success?: boolean; data?: { token: string; user: { id: string; email: string } }; error?: string } | null;
  if (!res.ok || !body?.success || !body.data) {
    return backToClient({ error: 'access_denied', error_description: body?.error ?? `exchange failed (${res.status})` });
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: body.data.user.id,
    metadata: { email: body.data.user.email, issuedAt: new Date().toISOString() },
    scope: authRequest.scope,
    props: { apiKey: body.data.token, email: body.data.user.email } satisfies Props,
  });
  return Response.redirect(redirectTo, 302);
}

const provider = new OAuthProvider<Env>({
  apiHandlers: { '/mcp': apiHandler, '/userinfo': userinfoHandler },
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  // `openid` and `email` next to our own scope: an Enterprise workspace can
  // then restrict the connector to its email domain (see /userinfo).
  scopesSupported: ['openid', 'email', 'profile', 'vivid'],
  accessTokenTTL: 3600,
  refreshTokenTTL: 60 * 60 * 24 * 90,
  // A bearer that is not one of our OAuth tokens but looks like a VIVID key
  // is accepted as-is: the API is the one that validates it. This keeps the
  // header-based clients working through the same /mcp route.
  resolveExternalToken: async ({ token }) => {
    if (!isPrintableKey(token) || !isVividKey(token)) return null;
    return { props: { apiKey: token } satisfies Props };
  },
});

/**
 * ChatGPT probes discovery under the MCP path too (`/mcp/.well-known/…`, and
 * OpenID's `openid-configuration`) before the RFC 9728 form. Fold those onto
 * the documents the provider serves so the probe succeeds on the first try.
 */
function normalizeDiscovery(request: Request): Request {
  const url = new URL(request.url);
  const m = /^\/mcp\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)$/.exec(url.pathname)
    ?? /^\/\.well-known\/(openid-configuration)\/mcp$/.exec(url.pathname);
  if (!m) return request;
  const doc = m[1] === 'oauth-protected-resource' ? '/.well-known/oauth-protected-resource/mcp'
    : m[1] === 'openid-configuration' ? '/.well-known/openid-configuration'
    : '/.well-known/oauth-authorization-server';
  url.pathname = doc;
  return new Request(url.toString(), request);
}

/** OIDC discovery: the OAuth endpoints plus the identity bits (userinfo, claims). */
function openidConfiguration(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    userinfo_endpoint: `${origin}/userinfo`,
    registration_endpoint: `${origin}/register`,
    jwks_uri: `${origin}/.well-known/jwks.json`,
    scopes_supported: ['openid', 'email', 'profile', 'vivid'],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    // No ID tokens: identity is read from /userinfo with the access token.
    id_token_signing_alg_values_supported: [],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256'],
    claims_supported: ['sub', 'email', 'email_verified', 'name'],
  };
}

export default {
  async fetch(rawRequest: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const request = normalizeDiscovery(rawRequest);
    const url = new URL(request.url);
    // `X-API-Key` (no Authorization header) bypasses the provider: it is the
    // documented header-based path and needs no OAuth machinery.
    if (url.pathname === '/mcp' && !request.headers.get('authorization')) {
      const key = request.headers.get('x-api-key')?.trim();
      if (key && isPrintableKey(key)) return handleMcp(request, env, key);
    }
    return provider.fetch(request, env, ctx);
  },
};
