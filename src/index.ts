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

/** The MCP endpoint as the OAuth provider calls it once a token has been validated. */
async function oauthProtectedMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
        console.error('[config]', error.message);
        return json(500, { error: 'server_misconfigured', message: error.message });
      }
      throw error;
    }

    if (url.pathname === '/healthz') {
      if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
      return json(200, { status: 'ok', endpoint: `${url.origin}/mcp` });
    }

    if (url.pathname === '/mcp') {
      // The MCP spec requires Origin validation against DNS rebinding. Browsers
      // set Origin; Claude's server-side fetches do not, so only reject an
      // Origin that is present and foreign.
      const origin = request.headers.get('origin');
      if (origin !== null && origin !== url.origin) {
        return jsonRpcError(403, -32600, 'Forbidden origin');
      }

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

    // OAuth mode: discovery, registration, token endpoints, the consent page,
    // and /mcp with an OAuth bearer token.
    return providerFor(url.origin, oauthProtectedMcp).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
