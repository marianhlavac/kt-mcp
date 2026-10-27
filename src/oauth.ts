/**
 * OAuth 2.1 for clients that cannot send a fixed header: claude.ai's connector
 * flow, for one. The authorization server, PKCE, dynamic client registration,
 * Client ID Metadata Documents, token issuance and refresh rotation all come
 * from @cloudflare/workers-oauth-provider, stored hashed in the OAUTH_KV
 * namespace. This file supplies the one thing the library cannot: the
 * consent page, which for a single-user server means "prove you know
 * MCP_AUTH_PASSWORD, once, in a browser".
 */

import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  insufficientScope,
  type ConsentDescription,
  type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider';
import { secretMatches } from './auth.js';
import type { Env } from './env.js';

/** The one scope this server knows. Granted in full on every consent. */
export const SCOPE = 'kt:diary';

/**
 * Claude refreshes tokens on its own, so the access token can be short-ish
 * without anyone noticing; the grant slides while the connector is in use and
 * expires after ninety idle days.
 */
const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

export type McpHandler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

/**
 * The provider's issuer and resource identifier are the deployment's own
 * origin, which is only known from the request. Instances are cached per
 * origin; a Worker sees one or two (workers.dev and a custom domain). The
 * passphrase is captured alongside: changing a secret deploys a new version
 * and retires this isolate, but the cache checks it anyway.
 */
const providers = new Map<string, { passphrase: string; provider: OAuthProvider<Env> }>();

export function providerFor(origin: string, passphrase: string, handleMcp: McpHandler): OAuthProvider<Env> {
  const existing = providers.get(origin);
  if (existing && existing.passphrase === passphrase) return existing.provider;
  if (providers.size >= 8) providers.clear();

  const provider = new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: {
      fetch: async (request, env, ctx) => {
        const { auth } = ctx as OAuthResourceContext<unknown>;
        if (!auth.scope.includes(SCOPE)) return insufficientScope(auth, [SCOPE]);
        return handleMcp(request, env, ctx);
      },
    },
    defaultHandler: { fetch: (request, env) => handleAuthorization(request, env, passphrase) },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    },
    // "Use Claude's published identity": the client ID is a URL to a metadata
    // document Anthropic hosts. Needs the global_fetch_strictly_public flag.
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    refreshTokenIdleTTL: REFRESH_TOKEN_TTL_SECONDS,
  });
  providers.set(origin, { passphrase, provider });
  return provider;
}

/**
 * Everything the provider does not own itself: only `/authorize`. Discovery
 * documents, `/token`, `/register` and `/mcp` never reach this handler. The
 * entrypoint has already validated the configuration and rate-limited the
 * request by client IP.
 */
async function handleAuthorization(request: Request, env: Env, passphrase: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/authorize') {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      consent.headers.set('Cache-Control', 'no-store');
      return new Response(consentPage(details, consent.handle, null), { headers: consent.headers });
    }

    if (request.method === 'POST') {
      // Rate limiting happened in the entrypoint, before the provider.
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return new Response('Expected a form submission.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      const handle = String(form.get('handle') ?? '');
      const decision = form.get('decision');
      const password = form.get('password');

      if (decision === 'deny') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }

      // The passphrase is checked before the handle on purpose: approveConsent
      // consumes the handle, so checking it first would make every typo restart
      // the flow from Claude. The cost is that a wrong guess is distinguishable
      // from a missing handle without opening a consent transaction, which is
      // why the entrypoint rate-limits this endpoint by client IP.
      if (typeof password !== 'string' || !(await secretMatches(password, passphrase))) {
        // The handle has not been consumed, so the same form can be retried.
        return new Response(consentPage(null, handle, 'Incorrect password.'), {
          status: 401,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Frame-Options': 'DENY',
            'Content-Security-Policy': "frame-ancestors 'none'",
          },
        });
      }

      // Single user: whatever the client asked for, grant exactly our one scope.
      const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: 'owner',
        metadata: {},
        scope: [SCOPE],
        props: { userId: 'owner' },
      });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }

    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  } catch (error) {
    // A redirect back to the client is only safe once the library has validated
    // the client and its redirect URI; it says so by attaching redirectTo.
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
      return new Response(errorPage(message), {
        status: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    throw error;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 26rem; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; margin-bottom: .25rem; }
  p { color: #666; margin-top: 0; }
  label { display: block; font-weight: 600; margin: 1.5rem 0 .35rem; }
  input[type=password] { width: 100%; padding: .6rem .7rem; font-size: 1rem; border: 1px solid #999; border-radius: .4rem; box-sizing: border-box; }
  button { margin-top: 1rem; width: 100%; padding: .65rem; font-size: 1rem; font-weight: 600; border: 0; border-radius: .4rem; cursor: pointer; }
  button.allow { background: #b5540b; color: #fff; }
  button.deny { background: transparent; color: #888; margin-top: .5rem; }
  .error { background: #fdecea; color: #8a1c12; padding: .6rem .75rem; border-radius: .4rem; margin-top: 1rem; }
  .warn { background: #fff4e5; color: #7a4a00; padding: .6rem .75rem; border-radius: .4rem; margin-top: 1rem; }
  .client { font-size: .85rem; color: #777; margin-top: 1.5rem; border-top: 1px solid #ddd; padding-top: .75rem; }
`;

/**
 * The consent form. `details` is null when re-rendering after a wrong
 * password: the client description lives with the pending request, which the
 * form must not be allowed to re-supply, so the retry shows only the field.
 */
function consentPage(details: ConsentDescription | null, handle: string, error: string | null): string {
  const client = details
    ? `<div class="client">Requested by <strong>${escapeHtml(details.clientName)}</strong>` +
      (details.clientDomain ? `, published by <strong>${escapeHtml(details.clientDomain)}</strong>` : ' (self-registered; name not verified)') +
      `.<br>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</div>`
    : '';
  const loopback = details?.redirectIsLoopback
    ? '<div class="warn">This sends access to an app on this computer. Continue only if you just started connecting from it.</div>'
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to your food diary</title>
<style>${STYLE}</style></head><body>
<h1>Connect to your food diary</h1>
<p>This grants access to log food into your kaloricketabulky.cz account.</p>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
${loopback}
<form method="POST">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <label for="password">Access password</label>
  <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
  <button class="allow" type="submit" name="decision" value="approve">Authorize</button>
  <button class="deny" type="submit" name="decision" value="deny" formnovalidate>Deny</button>
</form>
${client}
</body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cannot continue</title>
<style>${STYLE}</style></head><body>
<h1>Cannot continue</h1>
<div class="error">${escapeHtml(message)}</div>
<p>Go back to your agent and start connecting again. If this keeps happening, the page may have expired or been opened in another browser.</p>
</body></html>`;
}
