// ORDER #1710: Pinterest Paul. Pins an APPROVED card to one of our Pinterest
// boards (Mimi 10.13.2026, popup: "Post live on approve"). RUNS ON THE BOX.
//
// 🔴 THE FENCES (code, not prompt):
//   1. Only a card Katherine (or an exec) marked ready is ever pinned, once.
//   2. The pin's link must be a page on one of our own sites, and both the link
//      and the image must be in the card's MEASURED evidence (the blog post the
//      Box read this run). A model cannot invent a photo or a destination.
//   3. The only write is POST /v5/pins. No edit, no delete, no board changes,
//      no ads, no follows. Title <= 100, description <= 500, alt text <= 500.
//
// Credentials: Box Keychain items pinterest-app-id, pinterest-app-secret and
// pinterest-refresh-token (Katherine connects the business account once).
// Read in this process, never printed, never stored.
'use strict';

const { execFileSync } = require('child_process');

const API = 'https://api.pinterest.com/v5';
const OUR_SITES = ['infinityhospitalitygroup.com', 'dreameventsandcatering.com', 'dailydishcatering.com',
  'thebridgebuilding.com', 'thebelltower.com', 'cherokeedock.com', 'saddlewoodsfarm.com', 'nashvilleeventbartending.com',
  'thecordelle.com', 'thesaintelle.com', 'estellenashville.com', 'nashvilleweddingvenue.com'];
const LIMITS = { title: 100, description: 500, alt_text: 500 };

const host = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return null; } };

function keychain(name, run = execFileSync) {
  try { return String(run('security', ['find-generic-password', '-s', name, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null; }
  catch (e) { return null; }
}

// Every rule a pin must pass before anything is sent. Returns a reason, or null.
function checkPin(pin, evidence) {
  if (!pin || typeof pin !== 'object') return 'the card carries no pin';
  for (const k of ['board', 'title', 'description', 'link', 'image_url']) if (!pin[k] || !String(pin[k]).trim()) return `the pin has no ${k}`;
  for (const [k, n] of Object.entries(LIMITS)) if (pin[k] && String(pin[k]).length > n) return `the pin ${k} is over ${n} characters`;
  if (!/^https:\/\//.test(pin.link) || !OUR_SITES.includes(host(pin.link))) return `the link ${pin.link} is not a page on one of our sites`;
  if (!/^https:\/\//.test(pin.image_url)) return 'the image is not an https link';
  const ev = String(evidence || '');
  if (!ev.includes(pin.link)) return 'the link is not in the post the Box read this run';
  if (!ev.includes(pin.image_url)) return 'the photo is not one of the photos the Box found in that post';
  if (/[—]|\s–\s/.test(pin.title + pin.description)) return 'the pin has an em dash';
  return null;
}

async function accessToken({ fetchImpl = globalThis.fetch, secrets = keychain }) {
  const id = secrets('pinterest-app-id'); const secret = secrets('pinterest-app-secret'); const refresh = secrets('pinterest-refresh-token');
  if (!id || !secret || !refresh) return { ok: false, retry: true, why: 'Pinterest is not connected on the Box yet (Keychain items pinterest-app-id, pinterest-app-secret, pinterest-refresh-token)' };
  const r = await fetchImpl(`${API}/oauth/token`, { method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}` });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) return { ok: false, retry: true, why: `Pinterest refused the login: ${j.message || r.status}` };
  return { ok: true, token: j.access_token };
}

async function boards({ token, fetchImpl = globalThis.fetch }) {
  const out = []; let bookmark = null;
  for (let i = 0; i < 10; i++) {
    const r = await fetchImpl(`${API}/boards?page_size=100${bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ''}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Pinterest boards answered ${r.status}${j.message ? `: ${j.message}` : ''}`);
    out.push(...(j.items || []).map((b) => ({ id: b.id, name: b.name })));
    bookmark = j.bookmark; if (!bookmark) break;
  }
  return out;
}

// Pin one approved card. Returns { ok, id, url } | { skip, why } | { retry, why }.
async function createPin({ pin, evidence, fetchImpl = globalThis.fetch, secrets = keychain }) {
  const bad = checkPin(pin, evidence);
  if (bad) return { skip: true, why: bad };
  const t = await accessToken({ fetchImpl, secrets });
  if (!t.ok) return t;
  let list;
  try { list = await boards({ token: t.token, fetchImpl }); } catch (e) { return { retry: true, why: e.message }; }
  const want = String(pin.board).trim().toLowerCase();
  const board = list.find((b) => b.name.trim().toLowerCase() === want);
  if (!board) return { skip: true, why: `no board named "${pin.board}" on our Pinterest (boards: ${list.map((b) => b.name).join(', ') || 'none'})` };
  const body = { board_id: board.id, title: String(pin.title), description: String(pin.description), link: pin.link,
    alt_text: pin.alt_text ? String(pin.alt_text) : undefined, media_source: { source_type: 'image_url', url: pin.image_url } };
  const r = await fetchImpl(`${API}/pins`, { method: 'POST', headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) return r.status >= 500 ? { retry: true, why: `Pinterest answered ${r.status}` } : { skip: true, why: `Pinterest refused the pin: ${j.message || r.status}` };
  return { ok: true, id: j.id, url: `https://www.pinterest.com/pin/${j.id}/`, board: board.name };
}

module.exports = { createPin, checkPin, accessToken, boards, OUR_SITES, LIMITS, API };
