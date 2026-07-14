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
import { composeXPost, buildOAuthHeader, randomNonce } from '../src/lib/social.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const strict = args.includes('--strict');

const STATE_PATH = path.join(DATA_SOCIAL_DIR, 'x-state.json');
const TWEETS_ENDPOINT = 'https://api.twitter.com/2/tweets';

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
export async function run({ postFn, force: forceOpt = force, creds: credsOpt, state: stateOpt, persist = true } = {}) {
  const site = await readJson(path.join(CONFIG_DIR, 'site.json'), {});
  const meta = await readJson(path.join(DATA_DIR, 'meta.json'), null);
  const social = (site.social && site.social.x) || {};

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
  if (!forceOpt && state.lastPostKey === postKey) {
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
    // Do NOT print the missing values (they're empty anyway) — just the names.
    console.log(`[post-x] skipping (no credentials): ${missing.join(', ')} not set.`);
    return { status: 'no-credentials', text, postKey };
  }

  const { id } = await postTweet(text, creds, { postFn });
  const newState = {
    lastPostKey: postKey,
    lastPostedAt: new Date().toISOString(),
    lastTweetId: id,
  };
  if (persist) await writeState(newState);
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
