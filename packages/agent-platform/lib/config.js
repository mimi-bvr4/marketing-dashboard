// ORDER #2963 build step 2: everything that used to be a department literal in
// the agent code is a field of a department config. A department supplies its
// config, its agent folders and its skill files; the module supplies the rest.
//
// defineDepartment(raw) checks a config and returns a frozen copy with the
// defaults filled in, or throws with every problem listed at once.
'use strict';

const { FENCE_KEYS } = require('./fence');

const DEFAULT_WEEKLY_CAP = 25;   // Producer: scheduled cards per week (#2900)
const DEFAULT_WAITING_HOLD = 15; // Producer: hold when this many drafts wait (#2900)

// Laws every department carries whether its config names them or not
// (START_HERE iron rules 1 and 2). A config may add laws, never drop these.
const BASE_LAWS = Object.freeze(['finance read-only', 'compensation never']);

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PATH_RE = /^\/[A-Za-z0-9/_.-]*$/;
const YMD_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function person(v, field, errs) {
  if (!v || typeof v !== 'object') { errs.push(`${field}: needs { name, emails }`); return null; }
  const name = String(v.name || '').trim();
  const emails = Array.isArray(v.emails) ? v.emails.map((e) => String(e).trim().toLowerCase()) : [];
  if (!name) errs.push(`${field}.name: missing`);
  if (!emails.length) errs.push(`${field}.emails: at least one`);
  emails.filter((e) => !EMAIL_RE.test(e)).forEach((e) => errs.push(`${field}.emails: "${e}" is not an email`));
  return Object.freeze({ name, emails: Object.freeze(emails) });
}

function defineDepartment(raw) {
  const errs = [];
  if (!raw || typeof raw !== 'object') throw new Error('department config: not an object');

  // The fence is not configurable (fence.js). Naming a fence key is refused, whatever its value.
  const fenceHits = Object.keys(raw).filter((k) => FENCE_KEYS.includes(k));
  fenceHits.forEach((k) => errs.push(`${k}: a fence, set in code; no department config may set it`));

  const id = String(raw.id || '').trim();
  if (!ID_RE.test(id)) errs.push(`id: "${id}" must be lowercase letters, digits or dashes, 2 to 32 long`);
  const name = String(raw.name || '').trim();
  if (!name) errs.push('name: missing');

  const head = person(raw.head, 'head', errs);
  const approver = person(raw.instruction_approver, 'instruction_approver', errs);

  for (const k of ['skills_dir', 'agents_dir']) {
    if (!raw[k] || typeof raw[k] !== 'string') errs.push(`${k}: a folder path is required`);
  }

  // Review gate: exec always reviews; the department head reviews unless the config says not.
  const gate = Array.isArray(raw.review_gate) ? raw.review_gate.map(String) : ['exec', 'head'];
  if (!gate.includes('exec')) errs.push('review_gate: must include "exec"');
  gate.filter((g) => !['exec', 'head'].includes(g)).forEach((g) => errs.push(`review_gate: unknown "${g}"`));

  const laws = Array.isArray(raw.laws) ? raw.laws.map((l) => String(l).trim()).filter(Boolean) : [];
  const allLaws = [...BASE_LAWS, ...laws.filter((l) => !BASE_LAWS.includes(l.toLowerCase()))];

  const p = raw.producer || {};
  const weeklyCap = p.weekly_cap == null ? DEFAULT_WEEKLY_CAP : Number(p.weekly_cap);
  const hold = p.waiting_hold == null ? DEFAULT_WAITING_HOLD : Number(p.waiting_hold);
  if (!Number.isInteger(weeklyCap) || weeklyCap < 1) errs.push('producer.weekly_cap: a whole number of 1 or more');
  if (!Number.isInteger(hold) || hold < 1) errs.push('producer.waiting_hold: a whole number of 1 or more');
  // ORDER #3072: an optional dated window in which the hold is a different
  // number. Days are the department's local calendar days, both ends included.
  // Outside the window the base hold applies again with nobody doing anything.
  let holdWindow = null;
  if (p.waiting_hold_window != null) {
    const w = p.waiting_hold_window;
    const v = w && Number(w.value);
    const okDay = (s) => typeof s === 'string' && YMD_RE.test(s);
    if (!w || typeof w !== 'object' || !Number.isInteger(v) || v < 1 || !okDay(w.from) || !okDay(w.to) || w.from > w.to) {
      errs.push('producer.waiting_hold_window: needs { value: a whole number of 1 or more, from: YYYY-MM-DD, to: YYYY-MM-DD } with from on or before to');
    } else {
      holdWindow = Object.freeze({ value: v, from: w.from, to: w.to });
    }
  }
  const rhythm = Array.isArray(p.rhythm) ? p.rhythm : [];

  const pages = { review: '/review', agents: '/agents', producer: '/api/producer', ...(raw.pages || {}) };
  Object.entries(pages).forEach(([k, v]) => { if (!PATH_RE.test(String(v))) errs.push(`pages.${k}: "${v}" is not a path`); });
  const visitPages = Array.isArray(raw.visit_pages) ? raw.visit_pages.map(String)
    : [pages.review, `${pages.review}.html`, pages.agents, `${pages.agents}.html`];

  // The head's Drive build orders (replaces the hard-coded kh_route): the Drive intake
  // files them as BRAIN_INBOX/ORDER_<date>_<n>_<order_tag>_<slug>.md. Optional.
  let buildRoute = null;
  if (raw.build_route != null) {
    const r = raw.build_route;
    if (!r || typeof r !== 'object' || !/^[A-Z]{2,8}$/.test(String(r.order_tag || ''))) {
      errs.push('build_route: needs { order_tag } (2 to 8 capital letters) or null');
    } else {
      buildRoute = Object.freeze({ order_tag: r.order_tag, requester: String(r.requester || (head && head.name) || '') });
    }
  }

  if (errs.length) throw new Error(`department config "${id || '?'}" refused:\n  - ${errs.join('\n  - ')}`);

  return Object.freeze({
    id, name, head, instruction_approver: approver,
    skills_dir: raw.skills_dir, agents_dir: raw.agents_dir,
    review_gate: Object.freeze(gate),
    copy_checks: raw.copy_checks !== false, // the department's own copy rules; the base checks always run
    laws: Object.freeze(allLaws),
    producer: Object.freeze({ rhythm: Object.freeze(rhythm.slice()), weekly_cap: weeklyCap, waiting_hold: hold, waiting_hold_window: holdWindow }),
    voices: raw.voices === true,
    build_route: buildRoute,
    pages: Object.freeze(pages),
    visit_pages: Object.freeze(visitPages),
  });
}

// Is this email the department's head (a reviewer under the gate)?
function isHead(dept, email) {
  return !!email && dept.review_gate.includes('head') && dept.head.emails.includes(String(email).trim().toLowerCase());
}
// May this email approve an instruction (SKILL.md) change for this department?
function isInstructionApprover(dept, email) {
  return !!email && dept.instruction_approver.emails.includes(String(email).trim().toLowerCase());
}

// ORDER #3072: the Producer's waiting hold on one local calendar day (YYYY-MM-DD):
// the window's number inside its dates, the base hold every other day.
function waitingHoldOn(dept, ymd) {
  const p = dept.producer;
  const w = p.waiting_hold_window;
  const day = String(ymd).slice(0, 10);
  return w && day >= w.from && day <= w.to ? w.value : p.waiting_hold;
}

module.exports = { defineDepartment, isHead, isInstructionApprover, waitingHoldOn, BASE_LAWS, DEFAULT_WEEKLY_CAP, DEFAULT_WAITING_HOLD };
