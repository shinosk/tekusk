import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeXPost,
  xWeightedLength,
  truncateForTweet,
  rfc3986,
  signatureBaseString,
  buildOAuthHeader,
  TWEET_MAX,
  URL_WEIGHT,
} from '../src/lib/social.mjs';
import { run } from '../scripts/post-x.mjs';

const SITE = 'https://kaidoki-navi.net';

// A minimal veg entry factory for composeXPost inputs.
function entry(slug, name, opts = {}) {
  return {
    item: { slug, name, emoji: opts.emoji || '🥬', unit: '円/kg' },
    stats: {
      vsNormalPct: opts.vsNormalPct ?? null,
      rankPct: opts.rankPct ?? null,
      buyScore: opts.buyScore ?? 0,
      isBuy: opts.isBuy ?? false,
      latest: { price: opts.price ?? 100 },
    },
  };
}

// ---- xWeightedLength / truncation ------------------------------------------

test('xWeightedLength counts URLs as 23 and CJK/emoji as 1 codepoint', () => {
  assert.equal(xWeightedLength('あいう'), 3); // 3 Japanese codepoints
  assert.equal(xWeightedLength('🥬🍅'), 2); // emoji fold to one element each
  assert.equal(xWeightedLength('https://example.com/x'), URL_WEIGHT);
  // 'あ'(1) + ' '(1) + [URL=23] + ' '(1) + 'c'(1) = 27
  assert.equal(xWeightedLength('あ https://a.co/b c'), 1 + 1 + URL_WEIGHT + 1 + 1);
});

test('truncateForTweet keeps suffix intact and fits the budget', () => {
  const suffix = `\nhttps://kaidoki-navi.net/items/x/\n#野菜 #節約 #買い時`;
  const longBody = 'あ'.repeat(400);
  const trimmed = truncateForTweet(longBody, suffix);
  assert.ok(xWeightedLength(trimmed + suffix) <= TWEET_MAX, 'total within limit');
  assert.ok(trimmed.endsWith('…'), 'appends ellipsis when cut');
});

// ---- composeXPost: buy path -------------------------------------------------

test('composeXPost leads with the buy item when one exists', () => {
  const meta = { latestDate: '2026-07-14' };
  const buy = entry('tomato', 'トマト', { emoji: '🍅', vsNormalPct: -15.4, isBuy: true, buyScore: 15.4 });
  const { text, postKey, subject } = composeXPost({
    meta,
    entries: [buy],
    rankings: { buys: [buy], risers: [], fallers: [] },
    siteUrl: SITE,
  });
  assert.equal(postKey, '2026-07-14');
  assert.equal(subject, 'tomato');
  assert.ok(text.includes('トマト'), 'names the item');
  assert.ok(text.includes('-15%'), 'shows rounded 平年比');
  assert.ok(text.includes('（7/14時点）'), 'honest as-of stamp');
  assert.ok(text.includes(`${SITE}/items/tomato/`), 'links the item page');
  assert.ok(/#\S+/.test(text), 'has hashtags');
  const tags = text.match(/#\S+/g) || [];
  assert.ok(tags.length >= 2 && tags.length <= 3, '2-3 hashtags');
  assert.ok(xWeightedLength(text) <= TWEET_MAX, 'within 280 weighted chars');
});

// ---- composeXPost: no-buy (faller) path ------------------------------------

test('composeXPost falls back to the biggest weekly drop when no buy', () => {
  const meta = { latestDate: '2026-07-09' };
  const faller = entry('lotus-root', 'れんこん', { emoji: '🪷', rankPct: -18.2 });
  const { text, postKey, subject } = composeXPost({
    meta,
    entries: [faller],
    rankings: { buys: [], risers: [], fallers: [faller] },
    siteUrl: SITE,
  });
  assert.equal(postKey, '2026-07-09');
  assert.equal(subject, 'lotus-root');
  assert.ok(text.includes('れんこん'));
  assert.ok(text.includes('-18%'), 'shows rounded 前週比');
  assert.ok(text.includes('（7/9時点）'));
  assert.ok(text.includes(`${SITE}/items/lotus-root/`));
  assert.ok(xWeightedLength(text) <= TWEET_MAX);
});

test('composeXPost with neither buy nor faller links to the top page', () => {
  const meta = { latestDate: '2026-07-09' };
  const { text, subject, postKey } = composeXPost({
    meta,
    entries: [],
    rankings: { buys: [], risers: [], fallers: [] },
    siteUrl: SITE,
  });
  assert.equal(subject, null);
  assert.equal(postKey, '2026-07-09');
  assert.ok(text.includes(`${SITE}/`));
  assert.ok(!/-\d+%/.test(text), 'invents no numbers');
  assert.ok(xWeightedLength(text) <= TWEET_MAX);
});

// ---- composeXPost: truncation with an extreme item name --------------------

test('composeXPost truncates a pathologically long item name within 280', () => {
  const meta = { latestDate: '2026-07-14' };
  const name = 'とても長い野菜の名前'.repeat(40); // ~400 codepoints
  const buy = entry('long', name, { vsNormalPct: -12, isBuy: true, buyScore: 12 });
  const { text } = composeXPost({
    meta,
    entries: [buy],
    rankings: { buys: [buy], risers: [], fallers: [] },
    siteUrl: SITE,
  });
  assert.ok(xWeightedLength(text) <= TWEET_MAX, 'stays within 280 weighted chars');
  assert.ok(text.includes(`${SITE}/items/long/`), 'URL survives truncation');
  assert.ok(text.includes('#'), 'hashtags survive truncation');
});

// ---- RFC 3986 percent-encoding ---------------------------------------------

test('rfc3986 encodes the reserved extras that encodeURIComponent misses', () => {
  assert.equal(rfc3986(' '), '%20');
  assert.equal(rfc3986('!'), '%21');
  assert.equal(rfc3986('*'), '%2A');
  assert.equal(rfc3986("'"), '%27');
  assert.equal(rfc3986('('), '%28');
  assert.equal(rfc3986(')'), '%29');
  // Unreserved set must pass through untouched.
  assert.equal(rfc3986("aZ09-_.~"), 'aZ09-_.~');
});

// ---- OAuth 1.0a signature determinism --------------------------------------
//
// Fixed vector from X/Twitter's own "Creating a signature" documentation
// (developer.twitter.com/en/docs/authentication/oauth-1-0a/creating-a-signature).
// The published signature base string is reproduced verbatim below. The
// expected HMAC-SHA1 signature was independently re-derived from that base
// string and the documented signing key with:
//   printf '%s' "<base>" | openssl dgst -sha1 -hmac "<key>" -binary | openssl base64
//   => mDK0DkS77qM89m54MYfgpRrYmu0=
const TW = {
  method: 'POST',
  url: 'https://api.twitter.com/1.1/statuses/update.json',
  params: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!', include_entities: 'true' },
  consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
  consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Y7uw',
  token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
  tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
  nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
  timestamp: 1318622958,
};

const EXPECTED_BASE =
  'POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json' +
  '&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog' +
  '%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg' +
  '%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958' +
  '%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb' +
  '%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen' +
  '%252C%2520a%2520signed%2520OAuth%2520request%2521';
const EXPECTED_SIG = 'mDK0DkS77qM89m54MYfgpRrYmu0=';

test('signatureBaseString matches the published Twitter example verbatim', () => {
  const allParams = {
    ...TW.params,
    oauth_consumer_key: TW.consumerKey,
    oauth_nonce: TW.nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(TW.timestamp),
    oauth_token: TW.token,
    oauth_version: '1.0',
  };
  assert.equal(signatureBaseString(TW.method, TW.url, allParams), EXPECTED_BASE);
});

test('buildOAuthHeader is deterministic and matches the fixed vector', () => {
  const r = buildOAuthHeader(TW);
  assert.equal(r.baseString, EXPECTED_BASE);
  assert.equal(r.signature, EXPECTED_SIG);
  // The header carries the (percent-encoded) signature and every oauth_* field.
  assert.ok(r.header.startsWith('OAuth '));
  assert.ok(r.header.includes(`oauth_signature="${rfc3986(EXPECTED_SIG)}"`));
  assert.ok(r.header.includes('oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog"'));
  assert.ok(r.header.includes('oauth_signature_method="HMAC-SHA1"'));
  // Fully deterministic: a second call yields the identical header.
  assert.equal(buildOAuthHeader(TW).header, r.header);
});

// ---- idempotency: same postKey ⇒ the post function is not called -----------

test('run() posts once, then skips the same postKey without calling postFn', async () => {
  const creds = {
    X_API_KEY: 'k',
    X_API_SECRET: 's',
    X_ACCESS_TOKEN: 't',
    X_ACCESS_SECRET: 'ts',
  };
  let calls = 0;
  const postFn = async () => {
    calls += 1;
    return { ok: true, status: 201, text: JSON.stringify({ data: { id: '123' } }) };
  };

  // First run: fresh state ⇒ posts.
  const first = await run({ creds, state: { lastPostKey: null }, persist: false, force: false, postFn });
  assert.equal(first.status, 'posted');
  assert.equal(calls, 1, 'post attempted once');

  // Second run: state already holds this postKey ⇒ skip, postFn untouched.
  const second = await run({
    creds,
    state: { lastPostKey: first.postKey },
    persist: false,
    force: false,
    postFn,
  });
  assert.equal(second.status, 'skipped');
  assert.equal(calls, 1, 'no second post for the same 集計日');

  // --force overrides the skip.
  const forced = await run({
    creds,
    state: { lastPostKey: first.postKey },
    persist: false,
    force: true,
    postFn,
  });
  assert.equal(forced.status, 'posted');
  assert.equal(calls, 2, 'force re-posts');
});
