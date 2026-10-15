// ORDER #1873: Katherine's HTML in, WordPress block content out. Pure: text in,
// text out, nothing sent anywhere.
//
// What survives the site's theme:
//   * a plain heading or paragraph at the top level becomes a core block;
//   * anything with its own classes, styles or layout stays exactly as she wrote
//     it, in a Custom HTML block;
//   * her CSS is scoped to this one page: every selector is prefixed with the
//     page's own class, `html`/`body`/`:root` become that class, and @import is
//     dropped. Nothing can reach the theme, the menus or another page;
//   * a <script> is removed unless it is a HubSpot form embed;
//   * an <img> whose file she marked cleared points at the uploaded copy; one she
//     did not mark cleared is replaced by a visible "PHOTO HELD" box, never uploaded.
'use strict';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const INLINE = new Set(['a', 'strong', 'em', 'b', 'i', 'u', 'br', 'span', 'small', 'sup', 'sub', 'code', 'mark', 's']);

function scopeName(id) { return 'ihg-web-' + String(id).replace(/[^a-z0-9-]/gi, ''); }

function basename(src) {
  return decodeURIComponent(String(src || '').split(/[?#]/)[0].split('/').pop() || '').toLowerCase();
}

// ---- CSS scoping -------------------------------------------------------------

function splitSelectors(prelude) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of prelude) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function scopeSelector(sel, scope) {
  const m = sel.match(/^(html|body|:root)\b(.*)$/i);
  if (m) {
    const rest = m[2].replace(/^\s*(body)\b/i, '').trim();
    return rest ? `.${scope} ${rest}` : `.${scope}`;
  }
  return `.${scope} ${sel}`;
}

// Returns { css, dropped: [what was removed and why] }.
function scopeCss(input, scope) {
  const src = String(input || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const dropped = [];
  function walk(text) {
    let out = ''; let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      const semi = text.indexOf(';', i);
      if (semi >= 0 && (open < 0 || semi < open)) {
        const stmt = text.slice(i, semi).trim();
        if (/^@import/i.test(stmt)) dropped.push(`CSS ${stmt.slice(0, 80)} (an outside stylesheet is not carried; paste its rules in)`);
        else if (stmt && !/^@charset/i.test(stmt)) dropped.push(`CSS "${stmt.slice(0, 60)}" (not inside a rule)`);
        i = semi + 1; continue;
      }
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1; let j = open + 1;
      while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      const inner = text.slice(open + 1, j - 1);
      if (/^@(media|supports|container|layer)\b/i.test(prelude)) out += `${prelude}{${walk(inner)}}`;
      else if (/^@(keyframes|-webkit-keyframes|font-face|page|property)\b/i.test(prelude)) out += `${prelude}{${inner}}`;
      else if (/^@/.test(prelude)) dropped.push(`CSS ${prelude.slice(0, 60)} block (not supported on a page)`);
      else if (prelude) out += `${splitSelectors(prelude).map((s) => scopeSelector(s, scope)).join(',')}{${inner.trim()}}`;
      i = j;
    }
    return out;
  }
  return { css: walk(src), dropped };
}

// ---- top-level split ---------------------------------------------------------

// Top-level nodes of an HTML fragment: { kind: 'el', tag, attrs, html, inner } or
// { kind: 'text', html }. A light tokenizer, no parser dependency: tags are
// matched by name and depth, comments skipped, void elements closed at once.
function topLevel(html) {
  const out = []; const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g;
  let depth = 0; let start = -1; let tag = null; let attrs = ''; let last = 0; let innerFrom = 0; let m;
  const stack = [];
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    const name = m[1].toLowerCase(); const closing = m[0][1] === '/'; const selfClose = m[2] === '/' || VOID.has(name);
    if (!closing) {
      if (depth === 0) {
        const text = html.slice(last, m.index);
        if (text.trim()) out.push({ kind: 'text', html: text.trim() });
        start = m.index; tag = name; attrs = m[0].replace(/^<[\w-]+\s*|\/?>$/g, '').trim(); innerFrom = m.index + m[0].length;
      }
      if (selfClose) {
        if (depth === 0) { out.push({ kind: 'el', tag, attrs, html: m[0], inner: '' }); last = re.lastIndex; }
        continue;
      }
      stack.push(name); depth++;
      // raw text elements: skip to their close tag
      if (name === 'script' || name === 'style') {
        const close = html.toLowerCase().indexOf(`</${name}`, re.lastIndex);
        re.lastIndex = close < 0 ? html.length : close;
      }
    } else {
      const at = stack.lastIndexOf(name);
      if (at < 0) continue;
      stack.length = at; depth = stack.length;
      if (depth === 0) {
        out.push({ kind: 'el', tag, attrs, html: html.slice(start, re.lastIndex), inner: html.slice(innerFrom, m.index) });
        last = re.lastIndex;
      }
    }
  }
  if (depth > 0 && start >= 0) out.push({ kind: 'el', tag, attrs, html: html.slice(start), inner: html.slice(innerFrom) });
  else { const text = html.slice(last); if (text.trim()) out.push({ kind: 'text', html: text.trim() }); }
  return out;
}

function onlyInline(inner) {
  const tags = [...String(inner).matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((x) => x[1].toLowerCase());
  return tags.every((t) => INLINE.has(t));
}

const block = (name, inner, attrs) => `<!-- wp:${name}${attrs ? ' ' + JSON.stringify(attrs) : ''} -->\n${inner}\n<!-- /wp:${name} -->`;

function toBlock(node) {
  if (node.kind === 'text') return { html: block('paragraph', `<p>${node.html}</p>`), core: true };
  const { tag, attrs, inner } = node;
  const plain = !attrs || /^id="[^"]*"$/.test(attrs);
  const h = tag.match(/^h([1-6])$/);
  if (h && plain && onlyInline(inner)) {
    const level = Number(h[1]);
    return { html: block('heading', `<h${level} class="wp-block-heading">${inner.trim()}</h${level}>`, level === 2 ? null : { level }), core: true };
  }
  if (tag === 'p' && plain && onlyInline(inner)) return { html: block('paragraph', `<p>${inner.trim()}</p>`), core: true };
  return { html: block('html', node.html.trim()), core: false };
}

// ---- the document ------------------------------------------------------------

function isHubSpotScript(tagHtml) {
  return /src=["']https:\/\/js(-[a-z0-9]+)?\.hsforms\.net\//i.test(tagHtml) || /hbspt\.forms\.create\s*\(/.test(tagHtml);
}

// assets: [{ name, cleared, url, id }] where url/id are set once the Box has
// uploaded a cleared file. Returns the content to send plus what it did.
function convert(html, { scope, assets = [] } = {}) {
  const notes = []; const held = []; const external = [];
  let doc = String(html || '');
  const titleM = doc.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? titleM[1].replace(/\s+/g, ' ').trim() : '';

  const styles = [];
  doc = doc.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => { styles.push(css); return ''; });
  let scripts = 0;
  doc = doc.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => (isHubSpotScript(m) ? m : (scripts++, '')));
  if (scripts) notes.push(`${scripts} script(s) removed (only a HubSpot form embed may run on a page)`);
  doc = doc.replace(/<link\b[^>]*>/gi, (m) => { if (/stylesheet/i.test(m)) notes.push(`outside stylesheet not carried: ${(m.match(/href=["']([^"']+)/i) || [])[1] || m}`); return ''; });
  const bodyM = doc.match(/<body\b[^>]*>([\s\S]*?)(<\/body>|$)/i);
  let body = bodyM ? bodyM[1] : doc.replace(/<!doctype[^>]*>|<\/?html\b[^>]*>|<head\b[^>]*>[\s\S]*?<\/head>/gi, '');
  body = body.replace(/<meta\b[^>]*>|<title[^>]*>[\s\S]*?<\/title>/gi, '');

  const byName = new Map(assets.map((a) => [String(a.name || '').toLowerCase(), a]));
  body = body.replace(/<img\b[^>]*>/gi, (tagHtml) => {
    const src = (tagHtml.match(/\ssrc=["']([^"']*)["']/i) || [])[1] || '';
    const alt = (tagHtml.match(/\salt=["']([^"']*)["']/i) || [])[1];
    if (/^data:/i.test(src)) { held.push({ name: '(embedded image)', why: 'embedded in the HTML; upload it as a file instead' }); return holdBox('embedded image'); }
    const a = byName.get(basename(src));
    if (a && a.cleared && a.url) {
      return tagHtml.replace(/\ssrc=["'][^"']*["']/i, ` src="${a.url}"`).replace(/\ssrcset=["'][^"']*["']/i, '')
        .replace(/<img\b/i, a.id ? `<img data-wp-media="${a.id}"` : '<img');
    }
    if (a) { held.push({ name: a.name, why: a.cleared ? 'cleared but not uploaded' : 'not marked cleared' }); return holdBox(a.name); }
    if (/^https?:\/\//i.test(src)) { external.push(src); return tagHtml; }
    held.push({ name: basename(src) || src, why: 'the file was not uploaded with the HTML' });
    return holdBox(basename(src) || src);
  });

  const blocks = topLevel(body.trim()).map(toBlock);
  const scoped = scopeCss(styles.join('\n'), scope);
  notes.push(...scoped.dropped);
  const parts = [];
  if (scoped.css) parts.push(block('html', `<style>${scoped.css}</style>`));
  parts.push(block('group', `<div class="wp-block-group ${scope}">\n${blocks.map((b) => b.html).join('\n\n')}\n</div>`, { className: scope }));
  return {
    content: parts.join('\n\n'), title, scope,
    tally: { core: blocks.filter((b) => b.core).length, custom_html: blocks.filter((b) => !b.core).length, css_bytes: scoped.css.length },
    held, external, notes,
  };
}

function holdBox(name) {
  const safe = String(name).replace(/[<>"&]/g, '');
  // a span, so a held photo inside a <p> stays valid HTML
  return `<span class="ihg-photo-held" style="display:block;border:2px dashed #b00;padding:1.5rem;text-align:center;color:#b00">PHOTO HELD, not cleared for the web: ${safe}</span>`;
}

module.exports = { convert, scopeCss, scopeName, topLevel, toBlock, basename, holdBox, isHubSpotScript };
