/**
 * Bindings and secrets, validated per request.
 *
 * A Worker has no boot step where a missing secret can fail the process, so
 * every request validates the environment and answers a clear 500 instead of
 * a TypeError deep inside a tool call.
 */

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  // --- Secrets: `wrangler secret put NAME`, or .dev.vars locally ---
  /** kaloricketabulky.cz login. */
  KT_EMAIL?: string;
  KT_PASSWORD?: string;
  /** Passphrase for the OAuth consent page. Setting it enables OAuth mode. */
  MCP_AUTH_PASSWORD?: string;
  /** Fixed bearer token for clients that send an Authorization header. Setting it enables token mode. */
  MCP_AUTH_TOKEN?: string;

  // --- Plain vars from wrangler.jsonc ---
  /**
   * "true" lets OAuth mode run without the Rate Limiting binding, leaving the
   * consent page open to unlimited passphrase guesses. Not recommended.
   */
  ALLOW_UNLIMITED_CONSENT_ATTEMPTS?: string;

  // --- Bindings from wrangler.jsonc ---
  /** The kaloricketabulky.cz session cookie between invocations. */
  KT_SESSION?: KVNamespace;
  /** OAuth clients, grants and tokens, managed by @cloudflare/workers-oauth-provider. */
  OAUTH_KV?: KVNamespace;
  /** Slows down passphrase guessing and registration spam on the OAuth endpoints. */
  AUTH_RATE_LIMITER?: RateLimit;

  // --- Injected by OAuthProvider for the default handler ---
  OAUTH_PROVIDER: OAuthHelpers;
}

export interface Config {
  ktEmail: string;
  ktPassword: string;
  /** Static bearer token, or null when token mode is off. */
  authToken: string | null;
  /** Consent-page passphrase, or null when OAuth mode is off. */
  authPassword: string | null;
  /** Limiter for the OAuth endpoints, or null when explicitly running without one. */
  rateLimiter: RateLimit | null;
}

export class ConfigError extends Error {}

export const MIN_PASSWORD_LENGTH = 12;
export const MIN_TOKEN_LENGTH = 24;

/** A secret as set, or null when unset or blank. Never trimmed: it is compared verbatim. */
function secret(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value;
}

export function loadConfig(env: Env): Config {
  const ktEmail = env.KT_EMAIL?.trim() ?? '';
  const ktPassword = secret(env.KT_PASSWORD);
  if (ktEmail === '') throw new ConfigError('Secret KT_EMAIL is not set');
  if (ktPassword === null) throw new ConfigError('Secret KT_PASSWORD is not set');

  const authPassword = secret(env.MCP_AUTH_PASSWORD);
  const authToken = secret(env.MCP_AUTH_TOKEN);
  if (!authPassword && !authToken) {
    throw new ConfigError('Set MCP_AUTH_PASSWORD (OAuth consent passphrase) and/or MCP_AUTH_TOKEN (static bearer token)');
  }
  if (authPassword && authPassword.length < MIN_PASSWORD_LENGTH) {
    throw new ConfigError(`MCP_AUTH_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters — it guards a public endpoint`);
  }
  if (authToken && authToken.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(`MCP_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters — generate it with: openssl rand -base64 32`);
  }

  if (!env.KT_SESSION) throw new ConfigError('KV binding KT_SESSION is missing from wrangler.jsonc');
  if (authPassword && !env.OAUTH_KV) throw new ConfigError('KV binding OAUTH_KV is required when MCP_AUTH_PASSWORD is set');

  const rateLimiter = env.AUTH_RATE_LIMITER ?? null;
  if (authPassword && !rateLimiter && env.ALLOW_UNLIMITED_CONSENT_ATTEMPTS !== 'true') {
    throw new ConfigError(
      'Rate Limiting binding AUTH_RATE_LIMITER is missing. OAuth mode needs it to slow down passphrase guessing: ' +
        'keep the ratelimits block in wrangler.jsonc, or set ALLOW_UNLIMITED_CONSENT_ATTEMPTS to "true" in vars to run without it',
    );
  }

  return { ktEmail, ktPassword, authToken, authPassword, rateLimiter };
}
