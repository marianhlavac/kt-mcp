import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { bearerToken, secretMatches } from './auth.js';

test('secretMatches accepts only the exact secret', async () => {
  assert.equal(await secretMatches('correct horse battery staple', 'correct horse battery staple'), true);
  assert.equal(await secretMatches('correct horse battery stapl', 'correct horse battery staple'), false);
  assert.equal(await secretMatches('correct horse battery staplex', 'correct horse battery staple'), false);
  assert.equal(await secretMatches('', 'correct horse battery staple'), false);
  assert.equal(await secretMatches('Correct horse battery staple', 'correct horse battery staple'), false);
});

test('bearerToken parses the Authorization header strictly', () => {
  const req = (value?: string) => new Request('https://x.example/mcp', { headers: value === undefined ? {} : { authorization: value } });
  assert.equal(bearerToken(req('Bearer abc.def')), 'abc.def');
  assert.equal(bearerToken(req('bearer abc.def')), 'abc.def');
  assert.equal(bearerToken(req('  Bearer   abc.def  ')), 'abc.def');
  assert.equal(bearerToken(req()), null);
  assert.equal(bearerToken(req('Basic abc')), null);
  assert.equal(bearerToken(req('Bearer')), null);
  assert.equal(bearerToken(req('Bearer a b')), null);
});
