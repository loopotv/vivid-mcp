/**
 * JSON-RPC methods an anonymous client may call: enough to see what the server
 * does (directories, registries, agents choosing a server), nothing that
 * touches an account. Every other method falls through to the provider, which
 * answers 401 with the WWW-Authenticate header that starts the OAuth flow.
 */
const DISCOVERY_METHODS = new Set([
  'initialize', 'notifications/initialized', 'ping',
  'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list',
]);

/** True when the body is a JSON-RPC message (or batch) made only of discovery methods. */
export function isDiscoveryOnly(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  if (msgs.length === 0) return false;
  return msgs.every((m) => {
    if (!m || typeof m !== 'object') return false;
    const method = (m as { method?: unknown }).method;
    return typeof method === 'string' && DISCOVERY_METHODS.has(method);
  });
}
