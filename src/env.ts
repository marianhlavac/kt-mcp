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

  // --- Bindings from wrangler.jsonc ---
  /** The kaloricketabulky.cz session cookie between invocations. */
  KT_SESSION?: KVNamespace;
  /** OAuth clients, grants and tokens, managed by @cloudflare/workers-oauth-provider. */
  OAUTH_KV?: KVNamespace;
  /** Optional: slows down passphrase guessing on the consent page. */
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
}

export class ConfigError extends Error {}

export const MIN_PASSWORD_LENGTH = 12;
export const MIN_TOKEN_LENGTH = 24;

function text(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function loadConfig(env: Env): Config {
  const ktEmail = text(env.KT_EMAIL);
  const ktPassword = env.KT_PASSWORD ?? '';
  if (!ktEmail) throw new ConfigError('Secret KT_EMAIL is not set');
  if (ktPassword.trim() === '') throw new ConfigError('Secret KT_PASSWORD is not set');

  const authPassword = text(env.MCP_AUTH_PASSWORD);
  const authToken = text(env.MCP_AUTH_TOKEN);
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

  return { ktEmail, ktPassword, authToken, authPassword };
}
