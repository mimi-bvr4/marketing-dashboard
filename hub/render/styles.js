'use strict';

// STYLES: layouts. A style knows nothing about any one theme; it renders
// whatever model it is given (#1011 Amendment A: theme x style, kept separate).
// model = { eyebrow, headline, intro, heroSlot, heroPhoto, cta, venues: [ { venue, fit, label, confirm } ], faq }

const { esc, image, held, tagLine, form } = require('./html');
const { published } = require('../data/claims');

function blurb(ctx, v) {
  const text = published(v.venue.blurb);
  return (text ? `<p>${esc(text)}</p>` : '') + held(ctx, v.venue.blurb);
}

function fitNote(ctx, v) {
  return ctx.preview && v.confirm ? `<p class="fitnote">Fit: ${esc(v.confirm)}</p>` : '';
}

function venueName(v) {
  return v.label || v.venue.name;
}

function faq(ctx, model) {
  const items = (model.faq || []).map(published).filter(Boolean);
  const heldItems = (model.faq || []).map((c) => held(ctx, c)).join('');
  if (!items.length && !heldItems) return '';
  const list = items.map((f) => `<dt>${esc(f.q)}</dt><dd>${esc(f.a)}</dd>`).join('');
  return `<section class="band faq"><p class="eyebrow">Questions</p>${list ? `<dl>${list}</dl>` : ''}${heldItems}</section>`;
}

function hero(ctx, model, cls = '') {
  return `<section class="hero ${cls}">${image(model.heroPhoto, model.heroSlot, '', ctx.base)}
<p class="eyebrow">${esc(model.eyebrow)}</p><h1 class="display">${esc(model.headline)}</h1>
${model.intro ? `<p class="lede">${esc(model.intro)}</p>` : ''}<a class="btn-light" href="${model.heroHref || '#inquire'}">${esc(model.heroCta || model.cta)}</a></section>`;
}

// Style #1, "the collection": the skeleton's own look. The hub home uses it,
// and so can any theme (/garden/c).
function collection(ctx, model) {
  const cards = model.venues.map((v) => `<article class="card">${image(v.photo, v.venue.slot, '', ctx.base)}
<h3>${esc(venueName(v))}</h3><p class="tags">${tagLine(v.venue.tags)}</p>
${v.fit ? `<p>${esc(v.fit)}</p>` : blurb(ctx, v)}${fitNote(ctx, v)}
<a class="link-arrow" href="${esc(v.venue.url.href)}" rel="noopener">Explore venue</a></article>`).join('');
  return `${hero(ctx, { ...model, heroHref: '#collection', heroCta: model.heroCta || 'Explore all venues' })}
<section class="band" id="collection"><p class="eyebrow">Explore the collection</p><h2 class="display">${esc(model.collectionTitle || 'Find the setting that feels like you.')}</h2><hr>
<div class="grid">${cards}</div></section>${faq(ctx, model)}${form(ctx)}`;
}

// Style #2, the full-bleed photo hero: one big promise, then the venues as rows.
function heroStyle(ctx, model) {
  const rows = model.venues.map((v) => `<div class="row">${image(v.photo, v.venue.slot, '', ctx.base)}<div>
<h3 class="display" style="font-size:24px">${esc(venueName(v))}</h3><p class="tags">${tagLine(v.venue.tags)}</p>
<p>${esc(v.fit || '')}</p>${fitNote(ctx, v)}<a class="link-arrow" href="${esc(v.venue.url.href)}" rel="noopener">Explore venue</a></div></div>`).join('');
  return `${hero(ctx, model)}<section class="band rows"><p class="eyebrow">Where it happens</p>${rows}</section>${faq(ctx, model)}${form(ctx)}`;
}

// Style #3, the 2-3 venue comparison (the playbook's /garden/b).
function compare(ctx, model) {
  const cols = model.venues.slice(0, 3).map((v) => `<div class="col">${image(v.photo, v.venue.slot, '', ctx.base)}
<h3 class="display" style="font-size:20px;margin-top:18px">${esc(venueName(v))}</h3><p class="tags">${tagLine(v.venue.tags)}</p>
<p>${esc(v.fit || '')}</p>${fitNote(ctx, v)}<a class="link-arrow" href="${esc(v.venue.url.href)}" rel="noopener">Explore venue</a></div>`).join('');
  return `<section class="hero" style="min-height:52vh">${image(model.heroPhoto, model.heroSlot, '', ctx.base)}<p class="eyebrow">${esc(model.eyebrow)}</p>
<h1 class="display">${esc(model.headline)}</h1><a class="btn-light" href="#inquire">${esc(model.cta)}</a></section>
<section class="band"><p class="eyebrow">Compare the settings</p>${model.intro ? `<p style="max-width:640px;margin:12px 0 32px">${esc(model.intro)}</p>` : ''}
<div class="compare">${cols}</div></section>${faq(ctx, model)}${form(ctx)}`;
}

const STYLES = { collection, hero: heroStyle, compare };

module.exports = { STYLES };
