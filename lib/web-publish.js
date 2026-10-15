// ORDER #1873 step 6: Approve to publish. BUILT, AND SWITCHED OFF.
//
// Mimi gave no go-live preference on 10.15.2026, so the order took the safe
// default: until she rules it on, Katherine publishes from WordPress herself.
// The switch is the Box environment variable WEB_AGENT_PUBLISH, and only the
// exact value "on" opens it. Anything else (unset, "true", "ON ") is OFF.
// Every attempt, refused or not, is written to web_log.
//
// When ON (not yet): a new-page draft is published as itself; a draft that
// replaces a live page first saves a backup of the live page's title and
// content in web_log, then copies the draft's content onto the live page, and
// rollback() puts the backup back with one call.
'use strict';

const SWITCH = 'WEB_AGENT_PUBLISH';

function publishOn(env = process.env) { return env[SWITCH] === 'on'; }

function refusal() {
  return { ok: false, refused: true, why: `Publish is OFF (${SWITCH} is not "on"; Mimi has not ruled it on). Publish this draft from WordPress yourself.` };
}

async function publish({ c, request, env = process.env, log }) {
  if (!publishOn(env)) { log({ action: 'publish refused', post_id: request.result && request.result.draft_id, detail: 'switch OFF' }); return refusal(); }
  const r = request.result || {};
  if (!r.draft_id) return { ok: false, why: 'no draft to publish' };
  const json = { headers: { 'Content-Type': 'application/json' } };
  if (!r.replaces) {
    const p = await c.post(`/pages/${r.draft_id}`, JSON.stringify({ status: 'publish' }), json);
    if (p.status !== 200) return { ok: false, why: `WordPress refused: HTTP ${p.status}` };
    log({ action: 'draft published', post_id: r.draft_id, detail: 'new page' });
    return { ok: true, published: r.draft_id };
  }
  const live = await c.get(`/pages/${r.replaces}?context=edit`);
  const draft = await c.get(`/pages/${r.draft_id}?context=edit`);
  if (live.status !== 200 || draft.status !== 200) return { ok: false, why: 'could not read the live page or the draft; nothing changed' };
  const backup = { id: r.replaces, title: live.data.title.raw, content: live.data.content.raw, modified_gmt: live.data.modified_gmt };
  await log({ action: 'live page backed up', post_id: r.replaces, detail: JSON.stringify(backup) });
  const p = await c.post(`/pages/${r.replaces}`, JSON.stringify({ content: draft.data.content.raw }), json);
  if (p.status !== 200) return { ok: false, why: `WordPress refused: HTTP ${p.status}; the live page is unchanged`, backup };
  log({ action: 'live page replaced from draft', post_id: r.replaces, detail: `from draft ${r.draft_id}` });
  return { ok: true, published: r.replaces, backup };
}

async function rollback({ c, backup, env = process.env, log }) {
  if (!publishOn(env)) { log({ action: 'rollback refused', post_id: backup && backup.id, detail: 'switch OFF' }); return refusal(); }
  const p = await c.post(`/pages/${backup.id}`, JSON.stringify({ title: backup.title, content: backup.content }), { headers: { 'Content-Type': 'application/json' } });
  if (p.status !== 200) return { ok: false, why: `WordPress refused: HTTP ${p.status}` };
  log({ action: 'live page rolled back', post_id: backup.id, detail: `to the copy of ${backup.modified_gmt}` });
  return { ok: true };
}

module.exports = { publish, rollback, publishOn, refusal, SWITCH };
