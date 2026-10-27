/**
 * Shared-secret checks for the two ways a client may authenticate:
 * a static bearer token on `/mcp`, or the passphrase typed on the OAuth consent page.
 *
 * Both compare by SHA-256 digest. The digests have equal length, so the
 * byte-by-byte comparison runs in constant time whatever the inputs, and a
 * wrong guess costs the same whether it differs in the first or last character.
 */

export async function secretMatches(supplied: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(supplied), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/**
 * The token from an `Authorization: Bearer <token>` header, or null when the
 * header is absent, uses another scheme, or is malformed. Scheme matching is
 * case-insensitive per RFC 9110; the token itself is returned verbatim.
 */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [scheme, token] = parts;
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;
  return token;
}
