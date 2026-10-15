// ORDER #1873: the automated QA a Web Agent draft gets before it reaches
// Katherine's Review tab. The same checks #1809 ran by hand on the TBB drafts:
// one H1, alt text, no em dashes or AI tells, no hard capacity numbers, venue
// facts match Venue_Master, forms still post to HubSpot. Pure: HTML in, rows out.
// A check it cannot make says NOT CHECKED, never GREEN.
'use strict';

const { lint, summary } = require('./ai-tells');

const HUBSPOT_PORTAL = '49701209';

// Venue_Master_CANONICAL.md (05_AI_and_Brain), the four venue sites. Name,
// street address, and the drift names that must never appear on a page.
const VENUE_FACTS = {
  TBB: { name: 'The Bridge Building', address: '2 Victory Ave', drift: ['BBC / Bridge Building'] },
  TBT: { name: 'The Bell Tower', address: '400 4th Ave South', drift: [] },
  ECD: { name: 'Estate at Cherokee Dock', address: '175 Cherokee Dock Rd', drift: ['Eastside Collective', 'Drury'] },
  SWF: { name: 'Saddle Woods Farm', address: '9522 Franklin Rd', drift: ['Saddlewood Farm', 'Saddlewoods Farm'] },
};
const CODES = ['TBB', 'TBT', 'ECD', 'SWF', 'BBC', 'BBD', 'BBO', 'NEB', 'DEC', 'IHG'];

function visibleText(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|h[1-6]|li|div|section|br|tr|figure|blockquote)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'").replace(/&#8212;|&mdash;/g, String.fromCharCode(0x2014))
    .replace(/&#8211;|&ndash;/g, String.fromCharCode(0x2013)).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

const row = (check, verdict, detail) => ({ check, verdict, detail });

function capacityHits(text) {
  const hits = [];
  const re = /\b(\d{1,3}(?:,\d{3})*|\d+)\s*(\+\s*)?(guests?|people|seated|seats?|standing|attendees|sq\.?\s*ft|square feet)\b|\b(holds|seats|accommodates|capacity(?: of)?:?|max(?:imum)?(?: of)?|up to)\s*(\d{2,5}(?:,\d{3})?)\b/gi;
  let m;
  while ((m = re.exec(text))) hits.push(m[0].trim());
  return hits;
}

function checkForms(html) {
  const forms = [...String(html).matchAll(/<form\b[^>]*>/gi)].map((m) => m[0]);
  const embeds = [...String(html).matchAll(/hbspt\.forms\.create\s*\(\s*\{([\s\S]*?)\}\s*\)/g)].map((m) => m[1]);
  const bad = [];
  for (const f of forms) {
    const action = (f.match(/action=["']([^"']*)["']/i) || [])[1] || '';
    if (!/^https:\/\/forms\.hsforms\.com\//i.test(action) && !action.includes(HUBSPOT_PORTAL)) bad.push(`a <form> posts to "${action || 'this page'}", not HubSpot`);
  }
  for (const e of embeds) {
    const portal = (e.match(/portalId\s*:\s*["']?(\d+)/) || [])[1];
    if (portal !== HUBSPOT_PORTAL) bad.push(`a HubSpot embed names portal ${portal || '(none)'}, not ${HUBSPOT_PORTAL}`);
  }
  if (bad.length) return row('Forms post to the existing HubSpot form', 'RED', bad.join('; '));
  if (!forms.length && !embeds.length) return row('Forms post to the existing HubSpot form', 'GREEN', 'no form on the page');
  return row('Forms post to the existing HubSpot form', 'GREEN', `${forms.length + embeds.length} form(s), all HubSpot portal ${HUBSPOT_PORTAL}`);
}

function checkVenue(text, site) {
  const f = VENUE_FACTS[site];
  const out = [];
  const codeHits = CODES.filter((c) => new RegExp(`(^|[^A-Za-z])${c}([^A-Za-z]|$)`).test(text));
  out.push(row('No venue code shown as a name', codeHits.length ? 'RED' : 'GREEN', codeHits.length ? codeHits.join(', ') : 'none'));
  const drift = Object.values(VENUE_FACTS).flatMap((v) => v.drift).filter((d) => text.toLowerCase().includes(d.toLowerCase()));
  if (!f) {
    out.push(row('Venue facts match Venue_Master', drift.length ? 'RED' : 'NOT CHECKED',
      drift.length ? `drift name(s): ${drift.join(', ')}` : `${site} is not a venue site; only drift names were checked (none found)`));
    return out;
  }
  const addresses = [...text.matchAll(/\b\d{1,5}\s+[A-Z0-9][\w.]*(?:\s+[A-Z][\w.]*){0,3}\s+(Ave(?:nue)?|Rd|Road|St(?:reet)?|Blvd|Pike|Dr(?:ive)?|Ln|Lane|Way)\b\.?(\s+(South|North|S|N))?/g)].map((m) => m[0]);
  const wrong = addresses.filter((a) => !a.toLowerCase().startsWith(f.address.toLowerCase().slice(0, 8)) && !Object.values(VENUE_FACTS).some((v) => a.toLowerCase().startsWith(v.address.toLowerCase().slice(0, 8))));
  const otherVenue = addresses.filter((a) => Object.entries(VENUE_FACTS).some(([k, v]) => k !== site && a.toLowerCase().startsWith(v.address.toLowerCase().slice(0, 8))));
  const problems = [...drift.map((d) => `drift name "${d}"`), ...wrong.map((a) => `address "${a}" is not ${f.name}'s (${f.address})`), ...otherVenue.map((a) => `"${a}" is a sister venue's address`)];
  out.push(row('Venue facts match Venue_Master', problems.length ? 'RED' : 'GREEN',
    problems.length ? problems.join('; ') : (addresses.length ? `address matches: ${f.address}` : 'no address or drift name on the page')));
  return out;
}

// html: the content as WordPress stored it (read back). site: the site code.
// extra: { held, external, notes } from the converter.
function runQa(html, { site, held = [], external = [], notes = [] } = {}) {
  const text = visibleText(html);
  const rows = [];
  const h1 = (String(html).match(/<h1\b/gi) || []).length;
  rows.push(row('Exactly one H1', h1 === 1 ? 'GREEN' : 'RED', `${h1} H1 in the content${h1 === 1 ? '; if the theme also prints the page title as an H1, hide the title in the page settings' : ''}`));
  const imgs = [...String(html).matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const noAlt = imgs.filter((t) => !/\salt=["'][^"']+["']/i.test(t));
  rows.push(row('Every image has alt text', noAlt.length ? 'RED' : 'GREEN', `${imgs.length} image(s), ${noAlt.length} without alt`));
  const l = lint(text);
  rows.push(row('No em dashes or AI tells', l.fails.length ? 'RED' : (l.flags.length ? 'AMBER' : 'GREEN'),
    l.clean ? summary(l) : `${summary(l)}: ${[...l.fails.map((x) => `${x.rule} line ${x.line}`), ...l.flags.map((x) => `${x.rule} "${x.phrase || ''}"`)].slice(0, 8).join('; ')}`));
  const caps = capacityHits(text);
  rows.push(row('No hard capacity numbers', caps.length ? 'RED' : 'GREEN', caps.length ? caps.slice(0, 6).join('; ') : 'none'));
  rows.push(...checkVenue(text, site));
  rows.push(checkForms(html));
  const photo = [...held.map((h) => `${h.name} (${h.why})`), ...external.map((u) => `${u} (from another site; upload it instead)`)];
  rows.push(row('Photos cleared and in this site\'s Media Library', photo.length ? 'AMBER' : 'GREEN', photo.length ? photo.join('; ') : `${imgs.length} image(s), all uploaded`));
  if (notes.length) rows.push(row('Converter notes', 'AMBER', notes.join('; ')));
  const red = rows.filter((r) => r.verdict === 'RED').length;
  return { rows, red, amber: rows.filter((r) => r.verdict === 'AMBER').length, text, lint: l };
}

// What changed versus the live page, by visible line.
function diffText(before, after, max = 8) {
  const a = new Set(String(before || '').split('\n')); const b = new Set(String(after || '').split('\n'));
  const added = [...b].filter((x) => x && !a.has(x)); const removed = [...a].filter((x) => x && !b.has(x));
  return { added: added.length, removed: removed.length, kept: [...b].filter((x) => a.has(x)).length, sample_added: added.slice(0, max), sample_removed: removed.slice(0, max) };
}

module.exports = { runQa, visibleText, diffText, capacityHits, checkForms, checkVenue, VENUE_FACTS, HUBSPOT_PORTAL };
