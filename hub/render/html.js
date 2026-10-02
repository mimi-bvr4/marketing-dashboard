'use strict';

const { published, isHeld } = require('../data/claims');
const { VENUES, HUB } = require('../data/venues');
const { CSS } = require('./css');

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Photos: only a photo cleared for client use renders as an <img>. Anything
// else ("internal only", "Inspiration, not ours", unknown) falls back to the
// empty named slot. #1008 owns the clearance value.
// ORDER #1202: inside the dashboard a photo must also live under the hub's own
// /hub-assets/ prefix. Any other path (the dashboard's /photos, say) is an
// internal route that 404s on a public host, so it is never rendered.
const CLEARED = 'cleared_client_use';
const ASSET_PREFIX = '/hub-assets/';

function image(photo, slotText, cls = '', base = '') {
  if (photo && photo.clearance === CLEARED && typeof photo.src === 'string' && photo.src.startsWith(ASSET_PREFIX)) {
    return `<img class="${esc(cls)}" src="${esc(base + photo.src)}" alt="${esc(photo.alt || slotText)}" loading="lazy">`;
  }
  return `<div class="slot ${esc(cls)}" data-slot="${esc(slotText)}"><span class="slot-icon" aria-hidden="true"></span><span>${esc(slotText)}</span></div>`;
}

function held(ctx, claim) {
  if (!ctx.preview || !isHeld(claim)) return '';
  return `<p class="held" data-held="1">Held for fact check: ${esc(claim.check)}</p>`;
}

function tagLine(tags) {
  return tags.map(published).filter(Boolean).map(esc).join('<span class="dot"> · </span>');
}

function header(ctx) {
  return `<header class="top"><a class="wordmark" href="${esc((ctx.base || '') + '/')}">${esc(HUB.wordmark)}</a><a class="btn-ghost" href="#inquire">Inquire</a></header>`;
}

function footer(ctx) {
  const downtown = VENUES.filter((v) => v.area === 'downtown');
  const beyond = VENUES.filter((v) => v.area === 'beyond');
  const list = (vs) => vs.map((v) => `<li><a href="${esc(v.url.href)}" rel="noopener">${esc(v.name)}</a></li>`).join('');
  const phone = published(HUB.phone);
  const email = published(HUB.email);
  const contact = [
    phone ? `<li>${esc(phone)}</li>` : '',
    email ? `<li><a href="mailto:${esc(email)}">${esc(email)}</a></li>` : '',
  ].join('');
  return `<footer class="foot"><div class="foot-brand"><div class="wordmark">${esc(HUB.wordmark)}</div><p>${esc(HUB.footerLine)}</p></div>
<div><h4>Downtown</h4><ul>${list(downtown)}</ul></div>
<div><h4>Beyond Downtown</h4><ul>${list(beyond)}</ul></div>
<div><h4>Contact</h4><ul>${contact}</ul>${held(ctx, HUB.phone)}${held(ctx, HUB.email)}</div></footer>`;
}

const GUEST_COUNTS = ['Under 75', '75–100', '100–150', '150–200', '200+', 'Not sure'];
const EVENT_TYPES = ['Wedding', 'Corporate', 'Social', 'Non-Profit'];

// The one lead form. Hidden fields carry the page's own theme/style/path
// (server-set) and the ad's tracking params (cleaned, never shown).
function form(ctx) {
  const eventType = ctx.eventType || 'Wedding';
  const wedding = eventType === 'Wedding';
  const venueCodes = ctx.formVenues || VENUES.map((v) => v.code);
  const venues = venueCodes.map((code) => VENUES.find((v) => v.code === code)).filter(Boolean);
  const hidden = {
    theme: ctx.themeSlug || '',
    style: ctx.styleName || '',
    landing_page: ctx.path,
    ...ctx.tracking,
  };
  const hiddenInputs = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  return `<section class="inquire" id="inquire"><div class="inquire-copy">
<h2 class="display">Your ${wedding ? 'wedding' : 'event'} starts <em>here.</em></h2><hr>
<p>With seven distinctive venues and key ${wedding ? 'wedding' : 'event'} essentials already included, getting started is easier than you think.</p>
<p>Tell us a little about your ${wedding ? 'wedding' : 'event'}, and we'll help you find the right fit.</p></div>
<form method="post" action="${esc((ctx.base || '') + '/inquire')}" class="lead">${hiddenInputs}
<label>First name<input name="firstname" autocomplete="given-name" required></label>
<label>Last name<input name="lastname" autocomplete="family-name" required></label>
<label>Email<input name="email" type="email" autocomplete="email" required></label>
<label>Phone<input name="phone" type="tel" autocomplete="tel"></label>
<label>Event type<select name="event_type">${EVENT_TYPES.map((t) => `<option${t === eventType ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
<label>${wedding ? 'Wedding date' : 'Event date'}<input name="event_date" placeholder="A date range is fine"></label>
<label>Estimated guest count<select name="guest_count"><option value="">Select a range</option>${GUEST_COUNTS.map((g) => `<option>${esc(g)}</option>`).join('')}</select></label>
<fieldset class="wide"><legend>Venue(s) of interest</legend>${venues.map((v) => `<label class="chip"><input type="checkbox" name="venues" value="${esc(v.code)}"><span>${esc(v.name)}</span></label>`).join('')}
<label class="check"><input type="checkbox" name="venue_unsure" value="1"> I'm not sure. Help me choose.</label></fieldset>
<label class="wide">Optional message<textarea name="message" rows="3" placeholder="Anything you'd like us to know"></textarea></label>
<button class="btn-dark wide" type="submit">${esc(ctx.cta || 'Request venue information')}</button></form></section>`;
}

function trackingScript(ctx) {
  if (!ctx.hubspotTracking || !ctx.hubspotPortal) return '';
  return `<script id="hs-script-loader" async defer src="https://js.hs-scripts.com/${esc(ctx.hubspotPortal)}.js"></script>`;
}

function page(ctx, { title, body, description }) {
  const robots = ctx.noindex ? '<meta name="robots" content="noindex, nofollow">' : '';
  const banner = ctx.preview ? '<div class="preview-bar">Private preview. Not public. Fact-check items are held.</div>' : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${description ? `<meta name="description" content="${esc(description)}">` : ''}
${robots}<style>${CSS}</style>${trackingScript(ctx)}</head><body>${banner}${header(ctx)}<main>${body}</main>${footer(ctx)}</body></html>`;
}

module.exports = { esc, image, held, tagLine, form, page, CLEARED, ASSET_PREFIX, GUEST_COUNTS, EVENT_TYPES };
