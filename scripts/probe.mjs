#!/usr/bin/env node
// Probe candidate PRODUCTION data-source endpoints and save raw samples into
// data/raw-samples/, so a future development iteration can inspect real
// responses (HTML layout, CSV/XLSX column structure, etc.) and write a
// correct parser instead of guessing.
//
// Why this exists: the Japanese government sources this project actually
// wants (Tokyo wholesale market, ALIC "Vegetan", MAFF, e-Stat) return a
// policy-level 403 from this development sandbox's egress allow-list, but
// are expected to be reachable from a production GitHub Actions runner (see
// docs/data-sources.md). This script is meant to be run from that runner
// (see .github/workflows/probe.yml) so its output can be committed back to
// the repo and inspected here.
//
// Design goals (mirrors scripts/fetch.mjs):
//   * Fail-safe: a failure on any single URL (network error, non-2xx, 403,
//     timeout, ...) does not stop the probe — it is simply recorded as a
//     failed result in the index and probing continues. The script always
//     exits 0; nothing here should ever break the daily workflow.
//   * Non-accumulating: re-running overwrites data/raw-samples/ in place
//     (one index.json + one files/ dir) rather than growing a new
//     timestamped directory on every run.
//   * Dependency-free: only Node built-ins (global fetch, fs, path, URL).
//
// Usage:
//   node scripts/probe.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { RAW_SAMPLES_DIR, RAW_SAMPLES_FILES_DIR } from '../src/lib/paths.mjs';

// Same UA as src/lib/sources.mjs, so probing and real fetches present
// identically to upstream servers.
const UA = 'tekusk-price-bot/1.0 (+https://github.com/; static-site data updater)';

const TIMEOUT_MS = 30000;
const RETRIES = 2; // total attempts = RETRIES + 1
const MAX_TEXT_BYTES = 200 * 1024; // 200KB cap for text-like bodies
const MAX_BINARY_BYTES = 1024 * 1024; // 1MB cap for binary bodies (xlsx/zip/...)
const MAX_FOLLOWED_LINKS_PER_PAGE = 20;

// href must look like a document link (csv/xlsx/xls/zip) or mention one of
// these Japanese keywords for daily/ten-day/monthly reports, statistics, or
// price data — the kinds of pages likely to hold the actual price tables.
const LINK_EXT_RE = /\.(csv|xlsx?|zip)(?:[?#]|$)/i;
const LINK_KEYWORD_RE = /(日報|旬報|月報|統計|価格)/;

// Candidate production sources. See docs/data-sources.md for the rationale
// and licensing notes for each.
const SEED_URLS = [
  // Round 2: ベジ探のデータ一覧・価格系ページ(第1回プローブで全ホスト到達可を
  // 確認済み。ここから .xls/.csv 直リンクを収集して本番アダプタの対象を決める)
  'https://vegetan.alic.go.jp/other/list-data.html',
  'https://vegetan.alic.go.jp/price-trends/changes-arrivals-prices.html',
  'https://vegetan.alic.go.jp/retail-price-trends/vegetable-retail-price.html',
  'https://vegetan.alic.go.jp/retail-price-trends/price-trend-survey.html',
];

function sanitizeName(url) {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 120);
}

function extFor(contentType, url) {
  try {
    const byUrl = path.extname(new URL(url).pathname);
    if (byUrl && byUrl.length <= 6) return byUrl;
  } catch {
    /* ignore malformed URL, fall through to content-type sniffing */
  }
  if (/html/i.test(contentType)) return '.html';
  if (/json/i.test(contentType)) return '.json';
  if (/csv/i.test(contentType)) return '.csv';
  if (/zip/i.test(contentType)) return '.zip';
  if (/spreadsheetml|ms-excel|excel/i.test(contentType)) return '.xlsx';
  if (/pdf/i.test(contentType)) return '.pdf';
  if (/^text\//i.test(contentType)) return '.txt';
  return '.bin';
}

// Text-like content types are capped and saved as text; everything else
// (xlsx/zip/pdf/images/...) is capped and saved as raw binary, per spec.
function isTextLike(contentType) {
  if (!contentType) return true; // unknown: best-effort, still capped small
  return /^text\/|[/+]json|[/+]xml|html/i.test(contentType);
}

async function fetchOnce(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, contentType: res.headers.get('content-type') || '', buf };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await fetchOnce(url);
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 5000)));
      }
    }
  }
  throw lastErr;
}

// Extract same-host href targets from an HTML document.
function extractSameHostLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const links = new Set();
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    let abs;
    try {
      abs = new URL(m[1], baseUrl);
    } catch {
      continue; // malformed href, skip
    }
    if (abs.hostname !== base.hostname) continue; // same host only
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    abs.hash = '';
    links.add(abs.toString());
  }
  return [...links];
}

function pickLinksToFollow(links) {
  const fileLinks = links.filter((u) => LINK_EXT_RE.test(u));
  const keywordLinks = links.filter((u) => {
    try {
      return LINK_KEYWORD_RE.test(decodeURIComponent(u));
    } catch {
      return LINK_KEYWORD_RE.test(u);
    }
  });
  return [...new Set([...fileLinks, ...keywordLinks])].slice(0, MAX_FOLLOWED_LINKS_PER_PAGE);
}

// Probe a single URL. Never throws — failures are captured in the returned
// record so the caller can keep going. `seq` drives the saved filename.
async function probeUrl(url, seq, seen) {
  const record = { url, fetchedAt: new Date().toISOString(), ok: false };
  if (seen.has(url)) {
    record.skipped = 'duplicate';
    return record;
  }
  seen.add(url);

  try {
    const { status, contentType, buf } = await fetchWithRetry(url);
    record.status = status;
    record.contentType = contentType;
    record.byteLength = buf.length;
    record.ok = status >= 200 && status < 300;

    const cap = isTextLike(contentType) ? MAX_TEXT_BYTES : MAX_BINARY_BYTES;
    const saved = buf.subarray(0, cap);
    record.savedBytes = saved.length;
    record.truncated = saved.length < buf.length;

    const fname = `${String(seq).padStart(3, '0')}-${sanitizeName(url)}${extFor(contentType, url)}`;
    await fs.writeFile(path.join(RAW_SAMPLES_FILES_DIR, fname), saved);
    record.file = `files/${fname}`;

    if (record.ok && /html/i.test(contentType)) {
      // Scan the full body for links (not just the possibly-truncated saved
      // copy) — this is in-memory parsing only, unrelated to the on-disk cap.
      const fullText = buf.toString('utf8');
      const links = extractSameHostLinks(fullText, url);
      record.linksFound = links.length;
      record.linksToFollow = pickLinksToFollow(links);
    }
  } catch (err) {
    record.ok = false;
    record.error = String(err && err.message ? err.message : err);
  }
  return record;
}

async function main() {
  await fs.rm(RAW_SAMPLES_DIR, { recursive: true, force: true });
  await fs.mkdir(RAW_SAMPLES_FILES_DIR, { recursive: true });

  const results = [];
  const seen = new Set();
  let seq = 0;

  for (const url of SEED_URLS) {
    seq += 1;
    const record = await probeUrl(url, seq, seen);
    results.push(record);
    console.log(
      `[probe] ${record.ok ? 'OK ' : 'FAIL'} ${url} ` +
        (record.status ? `(${record.status}, ${record.byteLength ?? 0}B)` : `(${record.error || 'no response'})`)
    );

    for (const link of record.linksToFollow || []) {
      seq += 1;
      const linkRecord = await probeUrl(link, seq, seen);
      linkRecord.followedFrom = url;
      results.push(linkRecord);
      console.log(
        `[probe]   -> ${linkRecord.ok ? 'OK ' : 'FAIL'} ${link} ` +
          (linkRecord.status ? `(${linkRecord.status}, ${linkRecord.byteLength ?? 0}B)` : `(${linkRecord.error || 'no response'})`)
      );
    }
  }

  const index = {
    generatedAt: new Date().toISOString(),
    note:
      'Raw samples from candidate production data sources (see docs/data-sources.md). ' +
      'Re-running scripts/probe.mjs overwrites this file and files/ in place — it does not accumulate.',
    seedUrls: SEED_URLS,
    results,
  };
  await fs.mkdir(RAW_SAMPLES_DIR, { recursive: true });
  await fs.writeFile(path.join(RAW_SAMPLES_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n');

  const okCount = results.filter((r) => r.ok).length;
  console.log(`[probe] ${okCount}/${results.length} requests succeeded. Wrote data/raw-samples/index.json`);
  console.log('[probe] done.');
}

main()
  .catch((err) => {
    // Should not normally happen (per-URL errors are already caught), but
    // guarantee fail-safe behavior even for unexpected errors (e.g. disk
    // full): never fail the workflow because of the probe step.
    console.error(`[probe] unexpected error, continuing fail-safe: ${err.stack || err.message}`);
  })
  .finally(() => {
    process.exit(0);
  });
