// ORDER #2977: the Concierge (gbp) reads real Google reviews and posts.
//
// Mimi enabled mybusiness.googleapis.com on ihg-sales-brain (308053229449) on
// 11.05.2026; the Box's re-probe that morning answered 200 for reviews and
// localPosts on all 11 profiles, as brain@ through the service account's
// domain-wide delegation (the #1965 grant).
//
// 🔴 LAW: READ ONLY. Google offers no read-only Business Profile scope, so the
// token carries business.manage; this client is what keeps it read-only. It has
// one HTTP verb, GET, and no function here can reply to a review, post, edit or
// accept anything. Replies stay drafts on the Review tab; a person posts them.
'use strict';

const SCOPE = 'https://www.googleapis.com/auth/business.manage';
const SUBJECT = 'brain@infinityhospitality.net';
const ACCOUNTS = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
const LOCATIONS = 'https://mybusinessbusinessinformation.googleapis.com/v1/';
const V4 = 'https://mybusiness.googleapis.com/v4/';
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const COMMENT_CHARS = 600;

function createClient({ token, fetchImpl = globalThis.fetch }) {
  const headers = { Authorization: `Bearer ${token}` };
  async function get(url) {
    const r = await fetchImpl(url, { method: 'GET', headers });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(`${r.status} ${(j.error && (j.error.status || j.error.message)) || 'error'}`);
      e.status = r.status;
      throw e;
    }
    return j;
  }
  async function all(url, key, maxPages = 10) {
    const out = [];
    let tok = null;
    for (let i = 0; i < maxPages; i++) {
      const j = await get(tok ? `${url}${url.includes('?') ? '&' : '?'}pageToken=${encodeURIComponent(tok)}` : url);
      out.push(...(j[key] || []));
      tok = j.nextPageToken;
      if (!tok) break;
    }
    return out;
  }
  return {
    accounts: () => all(ACCOUNTS, 'accounts'),
    locations: (account) => all(`${LOCATIONS}${account}/locations?readMask=name,title&pageSize=100`, 'locations'),
    // One page, newest first: enough for what is new; totalReviewCount gives the size.
    reviews: (account, loc) => get(`${V4}${account}/${loc}/reviews?pageSize=50&orderBy=${encodeURIComponent('updateTime desc')}`),
    posts: (account, loc) => all(`${V4}${account}/${loc}/localPosts?pageSize=100`, 'localPosts', 3),
  };
}

const ymd = (t) => (t ? String(t).slice(0, 10) : '');
const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

// A v4 review as the agent sees it. reviewId is the seen-before key.
function reviewRow(r) {
  const text = cell(r.comment || '');
  return {
    review_id: r.reviewId || String(r.name || '').split('/').pop(),
    date: ymd(r.createTime),
    stars: STARS[r.starRating] || null,
    reviewer: cell((r.reviewer && r.reviewer.displayName) || 'A Google user'),
    text: text.length > COMMENT_CHARS ? `${text.slice(0, COMMENT_CHARS)} [cut]` : text,
    replied: !!r.reviewReply,
  };
}

// What one profile looks like this run, from the two GET answers.
function profileSummary(title, reviewsBody, posts, { since, perVenue }) {
  const rows = (reviewsBody.reviews || []).map(reviewRow);
  const unanswered = rows.filter((r) => !r.replied);
  const fresh = unanswered.filter((r) => r.date >= since).slice(0, perVenue);
  const good = rows.filter((r) => (r.stars || 0) >= 4).map((r) => r.date).sort().pop() || '';
  const lastPost = (posts || []).map((p) => ymd(p.createTime || p.updateTime)).sort().pop() || '';
  return { title, total: reviewsBody.totalReviewCount != null ? reviewsBody.totalReviewCount : rows.length,
    read: rows.length, unanswered: unanswered.length, newest: rows.length ? rows.map((r) => r.date).sort().pop() : '',
    lastGood: good, posts: (posts || []).length, lastPost, fresh };
}

module.exports = { createClient, reviewRow, profileSummary, SCOPE, SUBJECT, V4, STARS, COMMENT_CHARS };
