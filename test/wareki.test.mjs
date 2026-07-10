import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJpYear, excelSerialToYmd, pad2 } from '../src/lib/wareki.mjs';

test('parseJpYear converts era years (平成/令和/昭和) to Gregorian', () => {
  assert.equal(parseJpYear('平成18年'), 2006);
  assert.equal(parseJpYear('平成元年'), 1989);
  assert.equal(parseJpYear('平成31年'), 2019);
  assert.equal(parseJpYear('令和元年'), 2019);
  assert.equal(parseJpYear('令和8年'), 2026);
  assert.equal(parseJpYear('昭和64年'), 1989);
});

test('parseJpYear tolerates furigana suffixes as found in vegetan books', () => {
  assert.equal(parseJpYear('平成18年ヘイセイネン'), 2006);
  assert.equal(parseJpYear('2008年ネン'), 2008);
  assert.equal(parseJpYear('2026年ネン'), 2026);
});

test('parseJpYear handles Western years and rejects non-years', () => {
  assert.equal(parseJpYear('2008年'), 2008);
  assert.equal(parseJpYear('1999'), 1999);
  assert.equal(parseJpYear('平年値ヘイネンチ'), null);
  assert.equal(parseJpYear('年平均値'), null);
  assert.equal(parseJpYear('1月'), null);
  assert.equal(parseJpYear(''), null);
  assert.equal(parseJpYear(null), null);
  assert.equal(parseJpYear(12), null); // the stray "12" cell in the header row
});

test('excelSerialToYmd converts 1900-system serials', () => {
  // 46174 is the anchor cell of the June 2026 daily fixtures.
  assert.deepEqual(excelSerialToYmd(46174), { year: 2026, month: 6, day: 1 });
  assert.deepEqual(excelSerialToYmd(45658), { year: 2025, month: 1, day: 1 });
  assert.equal(excelSerialToYmd('junk'), null);
});

test('pad2 zero-pads', () => {
  assert.equal(pad2(3), '03');
  assert.equal(pad2(12), '12');
});
