import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { KvSessionStore, SESSION_KEY, resetSessionMemory, type KvLike } from './session.js';

class FakeKv implements KvLike {
  data = new Map<string, string>();
  gets = 0;
  puts: Array<{ key: string; value: string; ttl?: number }> = [];
  failPut = false;
  failGet = false;
  async get(key: string) {
    this.gets++;
    if (this.failGet) throw new Error('kv down');
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }) {
    if (this.failPut) throw new Error('kv down');
    this.puts.push({ key, value, ttl: options?.expirationTtl });
    this.data.set(key, value);
  }
}

beforeEach(() => resetSessionMemory());

test('reads KV once per isolate, then serves from memory', async () => {
  const kv = new FakeKv();
  kv.data.set(SESSION_KEY, 'JSESSIONID=abc');
  const store = new KvSessionStore(kv);
  assert.equal(await store.load(), 'JSESSIONID=abc');
  assert.equal(await store.load(), 'JSESSIONID=abc');
  assert.equal(kv.gets, 1);
});

test('remembers a KV miss too, so an empty namespace is not re-read on every call', async () => {
  const kv = new FakeKv();
  const store = new KvSessionStore(kv);
  assert.equal(await store.load(), null);
  assert.equal(await store.load(), null);
  assert.equal(kv.gets, 1);
});

test('writes only when the cookie changes, with the configured TTL', async () => {
  const kv = new FakeKv();
  const store = new KvSessionStore(kv, 1234);
  await store.save('JSESSIONID=one');
  await store.save('JSESSIONID=one');
  await store.save('JSESSIONID=two');
  assert.deepEqual(kv.puts, [
    { key: SESSION_KEY, value: 'JSESSIONID=one', ttl: 1234 },
    { key: SESSION_KEY, value: 'JSESSIONID=two', ttl: 1234 },
  ]);
  assert.equal(await store.load(), 'JSESSIONID=two');
});

test('a failed KV write keeps the cookie in memory instead of throwing', async () => {
  const kv = new FakeKv();
  kv.failPut = true;
  const store = new KvSessionStore(kv);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await store.save('JSESSIONID=mem');
  } finally {
    console.warn = warn;
  }
  assert.equal(await store.load(), 'JSESSIONID=mem');
  assert.equal(kv.data.size, 0);
});

test('a failed KV read is treated as "no cookie" so the client logs in', async () => {
  const kv = new FakeKv();
  kv.failGet = true;
  const store = new KvSessionStore(kv);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await store.load(), null);
  } finally {
    console.warn = warn;
  }
});
