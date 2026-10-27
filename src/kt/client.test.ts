import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GRAM_UNIT, assertCzechDate, baseUnitOf, formatCzechDate, md5Hex, parseCzechNumber } from './client.js';

test('parses Czech decimal commas', () => {
  assert.equal(parseCzechNumber('20,43'), 20.43);
  assert.equal(parseCzechNumber('0,56'), 0.56);
  assert.equal(parseCzechNumber('249'), 249);
});

test('strips the thousands separator, including the non-breaking space the site emits', () => {
  assert.equal(parseCzechNumber('1 043'), 1043);
  assert.equal(parseCzechNumber('1 043'), 1043);
  assert.equal(parseCzechNumber('1 021,35'), 1021.35);
});

test('passes numbers through and rejects non-finite ones', () => {
  assert.equal(parseCzechNumber(17), 17);
  assert.equal(parseCzechNumber(Number.NaN), null);
  assert.equal(parseCzechNumber(Number.POSITIVE_INFINITY), null);
});

test('returns null rather than a misleading zero for absent values', () => {
  assert.equal(parseCzechNumber(null), null);
  assert.equal(parseCzechNumber(undefined), null);
  assert.equal(parseCzechNumber(''), null);
  assert.equal(parseCzechNumber('   '), null);
  assert.equal(parseCzechNumber('n/a'), null);
});

test('formats dates the way the site expects', () => {
  assert.equal(formatCzechDate(new Date(2026, 7, 2)), '02.08.2026');
  assert.equal(formatCzechDate(new Date(2026, 11, 25)), '25.12.2026');
});

test('accepts only dd.MM.yyyy dates, since one ends up in a URL path', () => {
  assert.equal(assertCzechDate('02.08.2026'), '02.08.2026');
  assert.throws(() => assertCzechDate('2026-08-02'));
  assert.throws(() => assertCzechDate('2.8.2026'));
  assert.throws(() => assertCzechDate('../user/settings'));
});

test('picks the unit with multiplier 1 (or the null the site sends for it) as the base unit', () => {
  assert.equal(baseUnitOf([{ id: 'ml', title: 'ml', grams: 1 }, { id: 'cup', title: 'hrnek (250 ml)', grams: 250 }]), 'ml');
  assert.equal(baseUnitOf([{ id: 'g', title: 'g', grams: 0 }, { id: 'ks', title: 'kus (55 g)', grams: 55 }]), 'g');
  assert.equal(baseUnitOf([]), GRAM_UNIT);
});

test('md5Hex matches the site-side hash of the password', async t => {
  // Node's WebCrypto has no MD5; Cloudflare Workers add it as an extension.
  try {
    assert.equal(await md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
    assert.equal(await md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  } catch (error) {
    if (error instanceof Error && /not supported|NotSupportedError|Unrecognized/i.test(`${error.name} ${error.message}`)) {
      t.skip('MD5 digest not available in this runtime');
      return;
    }
    throw error;
  }
});
