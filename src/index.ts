/**
 * Entrypoint: a Cloudflare Worker serving one MCP endpoint behind two
 * interchangeable ways to authenticate.
 *
 *   POST /mcp                                  the MCP endpoint
 *   GET  /healthz                              liveness, unauthenticated
 *
 * Token mode (MCP_AUTH_TOKEN set): a fixed `Authorization: Bearer` header is
 * compared in constant time and the request goes straight to the tools.
 *
 * OAuth mode (MCP_AUTH_PASSWORD set): everything else is routed through
 * @cloudflare/workers-oauth-provider, which adds
 *
 *   /.well-known/oauth-protected-resource/mcp  RFC 9728 discovery
 *   /.well-known/oauth-authorization-server    RFC 8414 discovery
 *   /authorize /token /register                authorization code + PKCE, DCR, CIMD
 *
 * and validates OAuth bearer tokens on /mcp. Both modes may be on at once.
 */

import { bearerToken, secretMatches } from './auth.js';
import { ConfigError, loadConfig, type Config, type Env } from './env.js';
import { KtClient } from './kt/client.js';
import { KvSessionStore } from './kt/session.js';
import { handleMcpRequest, jsonRpcError } from './mcp/handler.js';
import { providerFor } from './oauth.js';

/**
 * Endpoints where an anonymous caller can make the server write to KV
 * (register a client, open a consent transaction) or guess the passphrase.
 * Each is rate-limited per client IP before the provider sees the request.
 */
const RATE_LIMITED_PATHS = new Set(['/authorize', '/register', '/token']);

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function ktClient(env: Env, config: Config): KtClient {
  // loadConfig has already checked that the binding exists.
  return new KtClient({ email: config.ktEmail, password: config.ktPassword }, new KvSessionStore(env.KT_SESSION!));
}

/**
 * The MCP endpoint as the OAuth provider calls it once a token has been
 * validated. The provider routes `/mcp/<anything>` here as well; only the
 * exact path is an endpoint.
 */
async function oauthProtectedMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (new URL(request.url).pathname !== '/mcp') return json(404, { error: 'not_found' });
  const config = loadConfig(env);
  return handleMcpRequest(request, ktClient(env, config), ctx);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    let config: Config;
    try {
      config = loadConfig(env);
    } catch (error) {
      if (error instanceof ConfigError) {
        // The detail names secrets and their constraints; keep it in the logs.
        console.error('[config]', error.message);
        return json(500, { error: 'server_misconfigured', message: 'See the Worker logs (wrangler tail) for the missing setting.' });
      }
      throw error;
    }

    if (url.pathname === '/healthz') {
      if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
      return json(200, { status: 'ok', endpoint: `${url.origin}/mcp` });
    }

    // No Origin check here, unlike upstream. It exists in the MCP spec against
    // DNS rebinding of local servers that rely on ambient credentials; this
    // endpoint is a public HTTPS host that accepts only a bearer token, so a
    // page on another origin gains nothing, and the check would only break
    // browser-based clients that the OAuth provider serves CORS to.
    if (url.pathname === '/mcp') {
      if (config.authToken) {
        const token = bearerToken(request);
        if (token !== null && (await secretMatches(token, config.authToken))) {
          return handleMcpRequest(request, ktClient(env, config), ctx);
        }
      }

      if (!config.authPassword) {
        // Token mode only: no authorization server to point the client at.
        return jsonRpcError(401, -32000, 'Unauthorized', { 'WWW-Authenticate': 'Bearer realm="kt-mcp"' });
      }
    }

    if (!config.authPassword) {
      return json(404, { error: 'not_found' });
    }

    if (config.rateLimiter && RATE_LIMITED_PATHS.has(url.pathname)) {
      // Keyed by the client IP Cloudflare observed; a caller cannot forge it.
      const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
      const { success } = await config.rateLimiter.limit({ key });
      if (!success) {
        return json(429, { error: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' }, { 'Retry-After': '60' });
      }
    }

    // OAuth mode: discovery, registration, token endpoints, the consent page,
    // and /mcp with an OAuth bearer token. The provider memoizes its helpers on
    // the env object it is given (`env.OAUTH_PROVIDER`), and env is shared by
    // every request in the isolate. A Worker reachable on two hostnames has
    // one provider per origin, so hand each request its own shallow copy, or
    // the consent page would use whichever origin's helpers came first and
    // reject the other origin's resource.
    return providerFor(url.origin, config.authPassword, oauthProtectedMcp).fetch(request, { ...env }, ctx);
  },
} satisfies ExportedHandler<Env>;
