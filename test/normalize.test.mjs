import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseNumber } from '../src/lib/csv.mjs';
import { normalizeDate, buildSeriesByColumn, normalizeItems, mergeSeries } from '../src/lib/normalize.mjs';

test('parseCsv handles quotes, escaped quotes and CRLF', () => {
  const { header, rows } = parseCsv('a,b,c\r\n1,"x,y","he said ""hi"""\r\n2,z,w\n');
  assert.deepEqual(header, ['a', 'b', 'c']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ['1', 'x,y', 'he said "hi"']);
  assert.deepEqual(rows[1], ['2', 'z', 'w']);
});

test('parseNumber treats nan/blank as null', () => {
  assert.equal(parseNumber('nan'), null);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('  '), null);
  assert.equal(parseNumber('NA'), null);
  assert.equal(parseNumber('12.5'), 12.5);
  assert.equal(parseNumber('0'), 0);
});

test('normalizeDate pads day and rejects junk', () => {
  assert.equal(normalizeDate('1980-02-01'), '1980-02-01');
  assert.equal(normalizeDate('2016-06'), '2016-06-01');
  assert.equal(normalizeDate('garbage'), null);
});

test('buildSeriesByColumn skips nan and sorts ascending', () => {
  const header = ['Date', 'Bananas', 'Rice'];
  const rows = [
    ['1980-03-01', 'nan', '400'],
    ['1980-01-01', '350', 'nan'],
    ['1980-02-01', '360', '410'],
  ];
  const m = buildSeriesByColumn(header, rows, ['Bananas', 'Rice']);
  assert.deepEqual(m.get('Bananas'), [
    { date: '1980-01-01', price: 350 },
    { date: '1980-02-01', price: 360 },
  ]);
  assert.deepEqual(m.get('Rice'), [
    { date: '1980-02-01', price: 410 },
    { date: '1980-03-01', price: 400 },
  ]);
});

test('buildSeriesByColumn throws without a Date column', () => {
  assert.throws(() => buildSeriesByColumn(['X', 'Y'], [], ['Y']), /Date/);
});

test('normalizeItems maps catalog and reports missing columns', () => {
  const csv = 'Date,Bananas,Rice\n2016-01-01,100,200\n2016-02-01,110,nan\n';
  const catalog = [
    { slug: 'banana', column: 'Bananas', name: 'バナナ', emoji: '🍌', category: '果物', unit: 'USD/トン', origin: '中米', season: '通年', buyKeyword: 'バナナ' },
    { slug: 'ghost', column: 'DoesNotExist', name: '幻', emoji: '❓', category: 'x', unit: 'x', origin: 'x', season: 'x', buyKeyword: 'x' },
  ];
  const { items, missing } = normalizeItems(csv, catalog);
  assert.equal(items.length, 1);
  assert.equal(items[0].slug, 'banana');
  assert.equal(items[0].series.length, 2);
  assert.deepEqual(missing, ['ghost']);
});

test('mergeSeries dedupes by date with incoming winning, stays sorted', () => {
  const existing = [
    { date: '2016-01-01', price: 100 },
    { date: '2016-02-01', price: 200 },
  ];
  const incoming = [
    { date: '2016-02-01', price: 250 }, // overrides
    { date: '2016-03-01', price: 300 }, // appends
  ];
  const merged = mergeSeries(existing, incoming);
  assert.deepEqual(merged, [
    { date: '2016-01-01', price: 100 },
    { date: '2016-02-01', price: 250 },
    { date: '2016-03-01', price: 300 },
  ]);
});
