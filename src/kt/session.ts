/**
 * Where the kaloricketabulky.cz session cookie lives between invocations.
 *
 * A Worker has no process that outlives a request, so the cookie is kept in
 * Workers KV, with this isolate's memory as a cache in front of it. KV is
 * eventually consistent: another location may read a cookie that was just
 * replaced. That is harmless here because the client treats a login redirect
 * as "log in again", so the worst case is one redundant login.
 *
 * Writes happen only when the cookie actually changes (a login, or the site
 * rotating the session), which keeps well inside the free plan's 1,000 KV
 * writes per day.
 */

/** The subset of a KV namespace this store needs; lets tests pass a fake. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SessionStore {
  /** The cached cookie, or null when there is none. */
  load(): Promise<string | null>;
  /** Remember a cookie the site just issued. */
  save(cookie: string): Promise<void>;
  /** Forget the cookie, so the next call logs in. */
  clear(): Promise<void>;
}

export const SESSION_KEY = 'kt-session-cookie';

/**
 * How long KV keeps a cookie. The site's JSESSIONID lifetime is undocumented;
 * an expired cookie simply triggers a re-login, so this only bounds how long a
 * dead cookie lingers in storage.
 */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

/**
 * This isolate's copy of the cookie. `undefined` means KV has not been asked
 * yet. Module-level on purpose: isolates are reused across requests, and a
 * deployment serves exactly one KT account, so there is nothing to key by.
 */
let memory: string | null | undefined;

/** For tests: forget the in-memory copy so the next load hits KV again. */
export function resetSessionMemory(): void {
  memory = undefined;
}

export class KvSessionStore implements SessionStore {
  constructor(
    private readonly kv: KvLike,
    private readonly ttlSeconds: number = SESSION_TTL_SECONDS,
  ) {}

  async load(): Promise<string | null> {
    if (memory !== undefined) return memory;
    memory = await this.kv.get(SESSION_KEY);
    return memory;
  }

  async save(cookie: string): Promise<void> {
    if (cookie === memory) return;
    memory = cookie;
    try {
      await this.kv.put(SESSION_KEY, cookie, { expirationTtl: this.ttlSeconds });
    } catch (error) {
      // KV is a cache, not the source of truth: the client can always log in
      // again. Losing the write must not fail the tool call that caused it.
      console.warn('[session] KV write failed; cookie kept in memory only:', error);
    }
  }

  async clear(): Promise<void> {
    memory = null;
    try {
      await this.kv.delete(SESSION_KEY);
    } catch (error) {
      console.warn('[session] KV delete failed:', error);
    }
  }
}
