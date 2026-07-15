#!/usr/bin/env node
// Post the day's "買い時 / 値動き" summary to X (Twitter) once per new dataset.
//
// Design goals (mirror scripts/fetch.mjs):
//   * Idempotent: one post per new 集計日 (meta.latestDate). State lives in
//     data/social/x-state.json; a run whose postKey == lastPostKey is a no-op.
//   * Fail-safe: any missing-credential / network / API error exits 0 so the
//     daily workflow never fails — unless --strict is passed.
//   * Secret-safe: credentials come ONLY from env vars (X_API_KEY, X_API_SECRET,
//     X_ACCESS_TOKEN, X_ACCESS_SECRET); their values are never logged, and any
//     error text is scrubbed of known secret values before printing.
//   * Dependency-zero: OAuth 1.0a HMAC-SHA1 is signed in src/lib/social.mjs
//     using node:crypto only.
//
// Usage:
//   node scripts/post-x.mjs [--dry-run] [--force] [--strict]
//     --dry-run  print the composed body and exit; no network, no credentials.
//     --force    ignore the idempotency skip (still needs credentials to post).
//     --strict   exit non-zero on failure (default is fail-safe exit 0).

import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR, DATA_DIR, DATA_ITEMS_DIR, DATA_SOCIAL_DIR } from '../src/lib/paths.mjs';
import { computeItemStats, buildRankings } from '../src/lib/stats.mjs';
import { composeXPost, buildOAuthHeader, randomNonce, xIntentUrl } from '../src/lib/social.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const strict = args.includes('--strict');

const STATE_PATH = path.join(DATA_SOCIAL_DIR, 'x-state.json');
const DRAFT_PATH = path.join(DATA_SOCIAL_DIR, 'x-draft.md');
const HISTORY_PATH = path.join(DATA_SOCIAL_DIR, 'x-drafts.jsonl');
const TWEETS_ENDPOINT = 'https://api.twitter.com/2/tweets';

// 'YYYY-MM-DD' → 'M/D' (best-effort; returns the input unchanged if unparseable).
function mdLabel(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  return m ? `${Number(m[2])}/${Number(m[3])}` : String(date || '');
}

// ---- secret scrubbing -------------------------------------------------------
// Collect the (non-empty) secret values so we can redact them from any string
// that might get logged (error messages, API error bodies).
function collectSecrets(creds) {
  return Object.values(creds || {}).filter((v) => typeof v === 'string' && v.length >= 4);
}
function scrub(text, secrets) {
  let out = String(text == null ? '' : text);
  for (const s of secrets) {
    if (s) out = out.split(s).join('***REDACTED***');
  }
  return out;
}

async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

async function loadVegEntries() {
  let files = [];
  try {
    files = (await fs.readdir(DATA_ITEMS_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const entries = [];
  for (const f of files) {
    const rec = await readJson(path.join(DATA_ITEMS_DIR, f), null);
    if (!rec || !Array.isArray(rec.series) || rec.series.length === 0) continue;
    if (rec.source !== 'vegetan') continue;
    const stats = computeItemStats(rec);
    if (stats) entries.push({ item: rec, stats });
  }
  return entries;
}

async function readState() {
  return (await readJson(STATE_PATH, null)) || {
    lastPostKey: null,
    lastPostedAt: null,
    lastTweetId: null,
  };
}

async function writeState(state) {
  await fs.mkdir(DATA_SOCIAL_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

// Write a human-friendly copy-paste draft (data/social/x-draft.md) plus an
// append-only history line. Used in manual mode (autoPost=false) so the day's
// suggested post is ready to publish by hand at zero API cost.
async function writeDraft({ text, postKey, latestDate, generatedAt }) {
  await fs.mkdir(DATA_SOCIAL_DIR, { recursive: true });
  const md =
    `# X投稿ドラフト（集計日 ${mdLabel(latestDate)}）\n\n` +
    `当面は手動投稿モードです。下の投稿文をコピペするか、ワンタップ投稿リンクを開いて投稿してください（X APIの費用はかかりません）。\n\n` +
    `## 投稿文（コピペ用）\n\n` +
    '```\n' +
    `${text}\n` +
    '```\n\n' +
    `## ワンタップ投稿（スマホ推奨）\n\n` +
    `${xIntentUrl(text)}\n\n` +
    `---\n\n` +
    `- postKey: ${postKey}\n` +
    `- 生成: ${generatedAt}\n` +
    `- 全自動に切り替える: config/site.json の social.x.autoPost を true にし、X APIキー4種を GitHub Secrets に設定\n`;
  await fs.writeFile(DRAFT_PATH, md);
  const rec = JSON.stringify({ postKey, latestDate, text, generatedAt });
  await fs.appendFile(HISTORY_PATH, rec + '\n');
}

// Post the tweet via OAuth 1.0a User Context. `postFn` is injectable for tests;
// the default performs the real fetch. Returns { id } on success.
async function postTweet(text, creds, { postFn } = {}) {
  const nonce = randomNonce();
  const timestamp = Math.floor(Date.now() / 1000);
  const { header } = buildOAuthHeader({
    method: 'POST',
    url: TWEETS_ENDPOINT,
    params: {}, // JSON body ⇒ only oauth_* params are signed
    consumerKey: creds.X_API_KEY,
    consumerSecret: creds.X_API_SECRET,
    token: creds.X_ACCESS_TOKEN,
    tokenSecret: creds.X_ACCESS_SECRET,
    nonce,
    timestamp,
  });

  const doPost =
    postFn ||
    (async ({ url, headers, body }) => {
      const res = await fetch(url, { method: 'POST', headers, body });
      const respText = await res.text();
      return { ok: res.ok, status: res.status, text: respText };
    });

  const res = await doPost({
    url: TWEETS_ENDPOINT,
    headers: { Authorization: header, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const secrets = collectSecrets(creds);
    throw new Error(`X API responded ${res.status}: ${scrub(res.text, secrets)}`);
  }
  let id = null;
  try {
    id = JSON.parse(res.text).data.id;
  } catch {
    /* ignore: success without a parseable id */
  }
  return { id };
}

// Core, testable flow. Options are all optional and exist for tests:
//   postFn  — injected poster (observe/stub the network call)
//   force   — override the module --force flag
//   creds   — override the env-derived credentials
//   state   — override the on-disk x-state.json
//   persist — when false, don't write x-state.json (default true)
export async function run({
  postFn,
  force: forceOpt = force,
  creds: credsOpt,
  state: stateOpt,
  persist = true,
  autoPost: autoPostOpt,
} = {}) {
  const site = await readJson(path.join(CONFIG_DIR, 'site.json'), {});
  const meta = await readJson(path.join(DATA_DIR, 'meta.json'), null);
  const social = (site.social && site.social.x) || {};
  // Two independent switches: `enabled` turns the whole feature on; `autoPost`
  // (the cost switch) decides whether we call the paid API or just prepare a
  // copy-paste draft for manual posting. Tests may override autoPost directly.
  const autoPost = autoPostOpt != null ? autoPostOpt : social.autoPost === true;

  if (!dryRun && social.enabled === false) {
    console.log('[post-x] social.x.enabled=false — nothing to do.');
    return { status: 'disabled' };
  }
  if (!meta || !meta.latestDate) {
    console.log('[post-x] no meta.latestDate — skipping.');
    return { status: 'no-data' };
  }

  const entries = await loadVegEntries();
  const rankings = buildRankings(entries);
  const { text, postKey, subject } = composeXPost({
    meta,
    entries,
    rankings,
    siteUrl: site.baseUrl || '',
  });

  console.log(`[post-x] latestDate=${meta.latestDate} postKey=${postKey} subject=${subject || '(none)'}`);
  console.log(`[post-x] body (${text.length} codepoints):\n${text}`);

  if (dryRun) {
    console.log('[post-x] --dry-run: not posting.');
    return { status: 'dry-run', text, postKey };
  }

  const state = stateOpt || (await readState());
  const now = new Date().toISOString();

  // Always keep a fresh copy-paste draft for the current dataset (cheap, no
  // credentials needed). Rewrite only when the dataset changed to avoid git churn.
  const draftIsCurrent = !forceOpt && state.lastDraftKey === postKey;
  if (!draftIsCurrent) {
    if (persist) await writeDraft({ text, postKey, latestDate: meta.latestDate, generatedAt: now });
    state.lastDraftKey = postKey;
    state.lastDraftAt = now;
    console.log(`[post-x] draft written for ${postKey} (data/social/x-draft.md).`);
  } else {
    console.log(`[post-x] draft already current for ${postKey}.`);
  }

  // Manual mode (default): stop after the draft, no API call, no cost.
  if (!autoPost) {
    if (persist) await writeState(state);
    console.log('[post-x] autoPost=false — manual mode: draft ready, not posting.');
    return { status: 'draft', text, postKey };
  }

  if (!forceOpt && state.lastPostKey === postKey) {
    if (persist) await writeState(state);
    console.log(`[post-x] already posted for ${postKey} — skipping (use --force to override).`);
    return { status: 'skipped', text, postKey };
  }

  const creds = credsOpt || {
    X_API_KEY: process.env.X_API_KEY,
    X_API_SECRET: process.env.X_API_SECRET,
    X_ACCESS_TOKEN: process.env.X_ACCESS_TOKEN,
    X_ACCESS_SECRET: process.env.X_ACCESS_SECRET,
  };
  const missing = Object.entries(creds)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    if (persist) await writeState(state);
    // Do NOT print the missing values (they're empty anyway) — just the names.
    console.log(`[post-x] skipping (no credentials): ${missing.join(', ')} not set.`);
    return { status: 'no-credentials', text, postKey };
  }

  const { id } = await postTweet(text, creds, { postFn });
  state.lastPostKey = postKey;
  state.lastPostedAt = new Date().toISOString();
  state.lastTweetId = id;
  if (persist) await writeState(state);
  console.log(`[post-x] posted tweet${id ? ` id=${id}` : ''}; state ${persist ? 'updated' : 'not persisted'}.`);
  return { status: 'posted', text, postKey, tweetId: id };
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  run().catch((err) => {
    // Scrub any known secret values from the error before printing.
    const secrets = collectSecrets({
      X_API_KEY: process.env.X_API_KEY,
      X_API_SECRET: process.env.X_API_SECRET,
      X_ACCESS_TOKEN: process.env.X_ACCESS_TOKEN,
      X_ACCESS_SECRET: process.env.X_ACCESS_SECRET,
    });
    console.error(`[post-x] ERROR: ${scrub(err && err.message, secrets)}`);
    if (strict) {
      process.exit(1);
    } else {
      console.error('[post-x] fail-safe: exiting 0 (daily workflow unaffected).');
      process.exit(0);
    }
  });
}
