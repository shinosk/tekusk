// Social-post composition + OAuth 1.0a signing. Pure, dependency-zero
// (node:crypto only), unit-testable.
//
// Two concerns live here, both side-effect-free so they can be tested without
// network or credentials:
//   1. composeXPost() — turns the day's computed stats into a tweet body +
//      an idempotency key. No hallucinated numbers: every figure comes from
//      the stats the build already computes.
//   2. OAuth 1.0a (RFC 5849) HMAC-SHA1 signing helpers — deterministic given a
//      fixed nonce/timestamp, so the signature base string and Authorization
//      header are verifiable against the published Twitter example vector.
//
// The actual HTTP POST and all credential handling live in scripts/post-x.mjs;
// nothing in this file reads process.env or performs I/O.

import crypto from 'node:crypto';

// ---- X (Twitter) length model ---------------------------------------------
// X caps a tweet at 280 "weighted" characters and rewrites every URL to a
// fixed-width t.co link. Per the task spec we count each non-URL codepoint as 1
// (Array.from folds surrogate pairs / most emoji into a single element) and
// every URL as URL_WEIGHT, mirroring t.co's 23-char substitution.
export const TWEET_MAX = 280;
export const URL_WEIGHT = 23;
const URL_RE = /https?:\/\/\S+/g;

// Weighted length: codepoints of the non-URL text + 23 per URL.
export function xWeightedLength(text) {
  const urls = text.match(URL_RE) || [];
  const stripped = text.replace(URL_RE, '');
  return Array.from(stripped).length + urls.length * URL_WEIGHT;
}

// Truncate `body` (by codepoints, appending an ellipsis) so that the whole
// `body + suffix` string fits within TWEET_MAX weighted chars. `suffix` is
// treated as fixed (it holds the URL + hashtags we must never drop). Returns
// the possibly-shortened body.
export function truncateForTweet(body, suffix, max = TWEET_MAX) {
  const suffixWeight = xWeightedLength(suffix);
  const budget = max - suffixWeight;
  if (budget <= 0) return ''; // pathological: suffix alone fills the tweet
  if (xWeightedLength(body) <= budget) return body;
  const ellipsis = '…';
  const chars = Array.from(body);
  // Reserve room for the ellipsis (weight 1). Shrink until it fits.
  let n = chars.length;
  while (n > 0) {
    const candidate = chars.slice(0, n).join('').replace(/\s+$/, '') + ellipsis;
    if (xWeightedLength(candidate) <= budget) return candidate;
    n -= 1;
  }
  return ellipsis;
}

// ---- Tweet composition ------------------------------------------------------

// "YYYY-MM-DD" -> "M/D" (honest "as-of" stamp; never claims real-time).
function mdOf(date) {
  const [, m, d] = String(date).split('-');
  return `${Number(m)}/${Number(d)}`;
}

// Round a percentage to a whole number, keeping the sign the source gives us
// (buy 平年比 and 前週比 fallers are already negative).
function pctInt(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n);
}

function itemUrl(siteUrl, slug) {
  return `${String(siteUrl).replace(/\/$/, '')}/items/${slug}/`;
}

// Deterministic 0..n-1 selector so wording varies by day without being random
// (a given 集計日 always yields the same tweet — important for idempotency).
function variant(seed, n) {
  const [y, m, d] = String(seed).split('-').map(Number);
  return (((y || 0) + (m || 0) + (d || 0)) % n + n) % n;
}

// Compose the day's X post. Returns { text, postKey, subject } where postKey is
// the idempotency key (the latest 集計日: one post per new dataset date).
//
//   { meta, entries, rankings, siteUrl }
//     meta      — data/meta.json (uses meta.latestDate)
//     entries   — [{ item, stats }] for the vegetable/daily items
//     rankings  — buildRankings() output ({ buys, risers, fallers })
//     siteUrl   — site base URL (config/site.json baseUrl)
export function composeXPost({ meta, entries = [], rankings = {}, siteUrl = '' }) {
  const latestDate = (meta && meta.latestDate) || '';
  const asOf = latestDate ? `（${mdOf(latestDate)}時点）` : '';
  const postKey = latestDate || 'unknown';
  const base = String(siteUrl).replace(/\/$/, '');

  const buys = rankings.buys || [];
  const fallers = rankings.fallers || [];

  let headline = '';
  let hashtags = '';
  let url = base + '/';
  let subject = null;

  const topBuy = buys[0];
  const topFaller = fallers.find((e) => e && e.stats && e.stats.rankPct != null && e.stats.rankPct < -1);

  if (topBuy && topBuy.stats && topBuy.stats.vsNormalPct != null) {
    // Lead with the strongest "buy now" (割安) item.
    const name = topBuy.item.name;
    const emoji = topBuy.item.emoji || '';
    const p = pctInt(topBuy.stats.vsNormalPct);
    subject = topBuy.item.slug;
    url = itemUrl(base, topBuy.item.slug);
    const v = variant(latestDate, 3);
    headline =
      v === 0
        ? `【今日の買い時】${emoji}${name}が平年比${p}%。いま平年より割安です${asOf}。`
        : v === 1
          ? `${emoji}${name}が買い時。平年比${p}%で、平年よりお得に買えます${asOf}。`
          : `【買い時】${emoji}${name}は平年比${p}%。旬の相場がお値打ちです${asOf}。`;
    hashtags = '#野菜 #節約 #買い時';
  } else if (topFaller) {
    // No buy today — highlight the biggest weekly drop instead.
    const name = topFaller.item.name;
    const emoji = topFaller.item.emoji || '';
    const p = pctInt(topFaller.stats.rankPct);
    subject = topFaller.item.slug;
    url = itemUrl(base, topFaller.item.slug);
    const v = variant(latestDate, 3);
    headline =
      v === 0
        ? `【値下がり】${emoji}${name}が前週比${p}%。価格が下がっています${asOf}。`
        : v === 1
          ? `${emoji}${name}が前週比${p}%と値下がり。チェックしてみては${asOf}。`
          : `【値動き】${emoji}${name}は前週比${p}%で下落しました${asOf}。`;
    hashtags = '#野菜 #値下がり #節約';
  } else {
    // Neither a buy nor a clear faller: link to the top page, no fabricated
    // numbers.
    headline = `野菜の卸売価格を更新しました。今日の買い時・値動きをチェック${asOf}。`;
    hashtags = '#野菜 #価格 #節約';
    url = base + '/';
  }

  const suffix = `\n${url}\n${hashtags}`;
  const trimmedHeadline = truncateForTweet(headline, suffix);
  const text = `${trimmedHeadline}${suffix}`;

  return { text, postKey, subject };
}

// Build an X "Web Intent" URL that opens the composer prefilled with `text`,
// for manual one-tap posting with no API cost. Our composed text already
// contains the link and hashtags, so everything goes in the single text param.
export function xIntentUrl(text) {
  return 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text);
}

// ---- OAuth 1.0a (RFC 5849) HMAC-SHA1 signing ------------------------------

// RFC 3986 percent-encoding. encodeURIComponent leaves A-Za-z0-9-_.~ and also
// !*'() unescaped; RFC 3986 requires the latter to be escaped too, so we do it
// explicitly. Result: only the unreserved set A-Za-z0-9-_.~ survives.
export function rfc3986(str) {
  return encodeURIComponent(String(str)).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// RFC 5849 §3.4.1.1 signature base string:
//   METHOD & rfc3986(url) & rfc3986(sorted, encoded, &-joined params)
// Params are sorted by encoded key, then by encoded value.
export function signatureBaseString(method, url, params) {
  const encoded = Object.keys(params)
    .map((k) => [rfc3986(k), rfc3986(params[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${String(method).toUpperCase()}&${rfc3986(url)}&${rfc3986(encoded)}`;
}

// Build the OAuth Authorization header for a request. Deterministic given a
// fixed nonce + timestamp. `params` are any request query/body params that must
// participate in the signature (empty for a JSON-body POST /2/tweets, where the
// body is NOT form-encoded and only the oauth_* params are signed).
//
// Returns { header, baseString, signature } — the extra fields exist so tests
// can assert the intermediate signature base string, not just the final header.
export function buildOAuthHeader({
  method,
  url,
  params = {},
  consumerKey,
  consumerSecret,
  token,
  tokenSecret,
  nonce,
  timestamp,
}) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp),
    oauth_token: token,
    oauth_version: '1.0',
  };
  const baseString = signatureBaseString(method, url, { ...params, ...oauthParams });
  const signingKey = `${rfc3986(consumerSecret)}&${rfc3986(tokenSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  const headerParams = { ...oauthParams, oauth_signature: signature };
  const header =
    'OAuth ' +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${rfc3986(k)}="${rfc3986(headerParams[k])}"`)
      .join(', ');

  return { header, baseString, signature };
}

// Generate a random nonce (32 hex chars). Not used by the pure signing path
// (which takes an explicit nonce for determinism); the runner calls this.
export function randomNonce() {
  return crypto.randomBytes(16).toString('hex');
}
