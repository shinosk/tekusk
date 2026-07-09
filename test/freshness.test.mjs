import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysSince, isArchiveMode, freshnessCopy, STALE_THRESHOLD_DAYS } from '../src/lib/freshness.mjs';

test('daysSince computes whole days and fails safe on bad input', () => {
  assert.equal(daysSince('2024-01-01', new Date('2024-01-11T00:00:00Z')), 10);
  assert.equal(daysSince(null), Infinity);
  assert.equal(daysSince('not-a-date'), Infinity);
});

test('isArchiveMode is false at/under the threshold, true beyond it', () => {
  const now = new Date('2024-04-10T00:00:00Z'); // ~100 days after 2024-01-01
  assert.equal(isArchiveMode('2024-04-01', now), false); // 9 days old
  assert.equal(isArchiveMode('2024-01-01', now), true); // 100 days old > 90
  // exact boundary: exactly threshold days old must NOT be archive mode
  const boundaryNow = new Date('2024-01-01T00:00:00Z');
  boundaryNow.setUTCDate(boundaryNow.getUTCDate() + STALE_THRESHOLD_DAYS);
  assert.equal(isArchiveMode('2024-01-01', boundaryNow), false);
  const pastBoundary = new Date(boundaryNow);
  pastBoundary.setUTCDate(pastBoundary.getUTCDate() + 1);
  assert.equal(isArchiveMode('2024-01-01', pastBoundary), true);
});

test('isArchiveMode treats missing/invalid dates as stale (fail-safe)', () => {
  assert.equal(isArchiveMode(null), true);
  assert.equal(isArchiveMode('garbage'), true);
});

test('freshnessCopy returns live-mode copy with no banner when fresh', () => {
  const now = new Date('2024-01-20T00:00:00Z');
  const c = freshnessCopy('2024-01-01', now);
  assert.equal(c.archive, false);
  assert.equal(c.banner, null);
  assert.match(c.tagline, /毎日/);
  assert.doesNotMatch(c.description, /アーカイブ/);
});

test('freshnessCopy switches to honest archive copy when stale', () => {
  const now = new Date('2026-07-09T00:00:00Z');
  const c = freshnessCopy('2017-06-01', now);
  assert.equal(c.archive, true);
  assert.equal(c.banner, '本サイトのデータは2017年6月時点までの月次アーカイブです。');
  assert.doesNotMatch(c.tagline, /毎日自動更新/);
  assert.doesNotMatch(c.description, /毎日自動更新/);
  assert.equal(c.indexTitle, '野菜・食品価格アーカイブ');
  assert.equal(c.priceLabel, '最新月の価格');
});
