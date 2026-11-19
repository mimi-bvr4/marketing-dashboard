// ORDER #3622: the text of a PDF, with no outside library (the Box has no
// pdftotext, and the dashboard's node_modules has no PDF reader). Enough of the
// PDF format to read what Canva exports: FlateDecode streams, object streams,
// Type0 fonts with a ToUnicode map, simple fonts, Form XObjects.
//
// A page that is a picture of text gives no text here. The caller treats an
// empty result as NOT CHECKED (image-only pages), never as NOT FOUND.
'use strict';

const zlib = require('zlib');

// ------------------------------------------------------------ the lexer

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

class Ref { constructor(num) { this.num = num; } }
class Name { constructor(v) { this.v = v; } }
class Op { constructor(v) { this.v = v; } }

// Reads PDF tokens from a Buffer. Strings come back as Buffers (raw bytes).
function lexer(buf, start = 0) {
  let i = start;
  const skip = () => {
    for (;;) {
      while (i < buf.length && WS.has(buf[i])) i++;
      if (buf[i] === 0x25) { while (i < buf.length && buf[i] !== 0x0a && buf[i] !== 0x0d) i++; continue; }
      return;
    }
  };
  function literal() {
    const out = []; let depth = 1; i++;
    while (i < buf.length) {
      const c = buf[i++];
      if (c === 0x5c) {
        const n = buf[i++];
        const map = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
        if (map[n] !== undefined) out.push(map[n]);
        else if (n >= 0x30 && n <= 0x37) {
          let v = n - 0x30;
          for (let k = 0; k < 2 && buf[i] >= 0x30 && buf[i] <= 0x37; k++) v = v * 8 + (buf[i++] - 0x30);
          out.push(v & 0xff);
        } else if (n === 0x0d) { if (buf[i] === 0x0a) i++; } else if (n !== 0x0a) out.push(n);
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29 && --depth === 0) break;
      out.push(c);
    }
    return Buffer.from(out);
  }
  function hex() {
    i++; let s = '';
    while (i < buf.length && buf[i] !== 0x3e) { const ch = String.fromCharCode(buf[i++]); if (/[0-9a-f]/i.test(ch)) s += ch; }
    i++;
    if (s.length % 2) s += '0';
    return Buffer.from(s, 'hex');
  }
  function next() {
    skip();
    if (i >= buf.length) return null;
    const c = buf[i];
    if (c === 0x28) return literal();
    if (c === 0x3c && buf[i + 1] === 0x3c) { i += 2; return { t: '<<' }; }
    if (c === 0x3e && buf[i + 1] === 0x3e) { i += 2; return { t: '>>' }; }
    if (c === 0x3c) return hex();
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) { i++; return { t: String.fromCharCode(c) }; }
    if (c === 0x2f) {
      i++; const s = i;
      while (i < buf.length && !WS.has(buf[i]) && !DELIM.has(buf[i])) i++;
      return new Name(buf.toString('latin1', s, i).replace(/#([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))));
    }
    const s = i;
    while (i < buf.length && !WS.has(buf[i]) && !DELIM.has(buf[i])) i++;
    if (i === s) { i++; return { t: String.fromCharCode(c) }; }
    const w = buf.toString('latin1', s, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) return Number(w);
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    return new Op(w);
  }
  return { next, get pos() { return i; }, set pos(v) { i = v; } };
}

// One whole value (a dict, an array, a number, `n g R`, ...) from the lexer.
function parseValue(lx, first) {
  const tok = first !== undefined ? first : lx.next();
  if (tok && tok.t === '<<') {
    const d = {};
    for (;;) {
      const k = lx.next();
      if (k === null || (k && k.t === '>>')) return d;
      if (k instanceof Name) d[k.v] = parseValue(lx);
    }
  }
  if (tok && tok.t === '[') {
    const a = [];
    for (;;) {
      const v = lx.next();
      if (v === null || (v && v.t === ']')) return a;
      a.push(parseValue(lx, v));
    }
  }
  if (typeof tok === 'number' && Number.isInteger(tok)) {
    const save = lx.pos;
    const g = lx.next();
    if (typeof g === 'number' && Number.isInteger(g)) {
      const r = lx.next();
      if (r instanceof Op && r.v === 'R') return new Ref(tok);
    }
    lx.pos = save;
  }
  return tok;
}

// ------------------------------------------------------------ the objects

function readObjects(buf) {
  const objs = new Map();
  const s = buf.toString('latin1');
  const head = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = head.exec(s))) {
    const num = Number(m[1]);
    const lx = lexer(buf, head.lastIndex);
    let dict;
    try { dict = parseValue(lx); } catch (e) { continue; }
    const after = lx.next();
    let stream = null;
    if (after instanceof Op && after.v === 'stream') {
      let at = lx.pos;
      if (buf[at] === 0x0d) at++;
      if (buf[at] === 0x0a) at++;
      const len = dict && typeof dict.Length === 'number' ? dict.Length : null;
      let end = len !== null && s.startsWith('endstream', skipWs(s, at + len)) ? at + len : s.indexOf('endstream', at);
      if (end < 0) end = buf.length;
      stream = buf.subarray(at, end);
      head.lastIndex = end;
    }
    objs.set(num, { dict, raw: stream });
  }
  // Object streams (PDF 1.5+): many small objects packed into one stream.
  for (const [, o] of [...objs]) {
    if (!o.raw || !o.dict || !(o.dict.Type instanceof Name) || o.dict.Type.v !== 'ObjStm') continue;
    const data = decodeStream(o);
    if (!data) continue;
    const lx = lexer(data);
    const pairs = [];
    for (let k = 0; k < o.dict.N; k++) pairs.push([lx.next(), lx.next()]);
    for (const [num, off] of pairs) {
      if (objs.has(num)) continue;
      const l2 = lexer(data, o.dict.First + off);
      try { objs.set(num, { dict: parseValue(l2), raw: null }); } catch (e) { /* skip one bad object */ }
    }
  }
  return objs;
}

function skipWs(s, i) { while (i < s.length && /\s/.test(s[i])) i++; return i; }

function decodeStream(o) {
  if (!o || !o.raw) return null;
  if (o.decoded !== undefined) return o.decoded;
  const f = o.dict && o.dict.Filter;
  const filters = Array.isArray(f) ? f : f ? [f] : [];
  let data = o.raw;
  for (const x of filters) {
    if (!(x instanceof Name)) { data = null; break; }
    if (x.v === 'FlateDecode') {
      try { data = zlib.inflateSync(data); } catch (e) { try { data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch (e2) { data = null; } }
    } else data = null; // an image filter, or one this reader does not know
    if (!data) break;
  }
  o.decoded = data;
  return data;
}

// ------------------------------------------------------------ the fonts

function utf16be(b) {
  let out = '';
  for (let k = 0; k + 1 < b.length; k += 2) out += String.fromCharCode((b[k] << 8) | b[k + 1]);
  return out;
}

const toInt = (b) => b.reduce((n, x) => n * 256 + x, 0);

function parseCMap(data) {
  const map = new Map();
  let width = 1;
  const lx = lexer(data);
  const toks = [];
  for (let t = lx.next(); t !== null; t = lx.next()) toks.push(t);
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (!(t instanceof Op)) continue;
    if (t.v === 'begincodespacerange') {
      for (k++; k < toks.length && !(toks[k] instanceof Op); k += 2) if (Buffer.isBuffer(toks[k]) && toks[k].length > width) width = toks[k].length;
    } else if (t.v === 'beginbfchar') {
      for (k++; k + 1 < toks.length && !(toks[k] instanceof Op); k += 2) map.set(toInt(toks[k]), utf16be(toks[k + 1]));
    } else if (t.v === 'beginbfrange') {
      k++;
      while (k + 2 < toks.length && !(toks[k] instanceof Op)) {
        const lo = toInt(toks[k]); const hi = toInt(toks[k + 1]);
        if (toks[k + 2] && toks[k + 2].t === '[') {
          let j = k + 3; let c = lo;
          while (j < toks.length && !(toks[j] && toks[j].t === ']')) { if (Buffer.isBuffer(toks[j])) map.set(c++, utf16be(toks[j])); j++; }
          k = j + 1;
        } else {
          const dst = toks[k + 2];
          if (Buffer.isBuffer(dst) && hi - lo < 65536) {
            for (let c = lo; c <= hi; c++) {
              const d = Buffer.from(dst); d[d.length - 1] += c - lo;
              map.set(c, utf16be(d));
            }
          }
          k += 3;
        }
      }
    }
  }
  return { map, width };
}

function fontDecoder(objs, fontDict) {
  const f = deref(objs, fontDict) || {};
  const tu = f.ToUnicode instanceof Ref ? objs.get(f.ToUnicode.num) : null;
  const data = decodeStream(tu);
  if (data) {
    const { map, width } = parseCMap(data);
    return (b) => {
      let out = '';
      for (let k = 0; k + width <= b.length; k += width) { const v = map.get(toInt(b.subarray(k, k + width))); if (v !== undefined) out += v; }
      return out;
    };
  }
  const sub = f.Subtype instanceof Name ? f.Subtype.v : '';
  if (sub === 'Type0') return () => ''; // two-byte glyph ids with no map: not readable
  return (b) => b.toString('latin1');
}

// ------------------------------------------------------------ the pages

function deref(objs, v, depth = 0) {
  if (v instanceof Ref) { const o = objs.get(v.num); return o && depth < 20 ? deref(objs, o.dict, depth + 1) : null; }
  return v;
}

function pagesInOrder(objs) {
  let root = null;
  for (const [, o] of objs) if (o.dict && o.dict.Type instanceof Name && o.dict.Type.v === 'Catalog') { root = o.dict; break; }
  const out = [];
  const seen = new Set();
  const walk = (node, inherited, depth) => {
    const d = deref(objs, node);
    if (!d || depth > 30 || seen.has(d)) return;
    seen.add(d);
    const res = d.Resources !== undefined ? d.Resources : inherited;
    if (d.Type instanceof Name && d.Type.v === 'Pages') { for (const k of deref(objs, d.Kids) || []) walk(k, res, depth + 1); return; }
    out.push({ page: d, resources: res });
  };
  if (root) walk(root.Pages, undefined, 0);
  if (!out.length) for (const [, o] of objs) if (o.dict && o.dict.Type instanceof Name && o.dict.Type.v === 'Page') out.push({ page: o.dict, resources: o.dict.Resources });
  return out;
}

function contentOf(objs, contents) {
  const list = Array.isArray(deref(objs, contents)) ? deref(objs, contents) : [contents];
  const parts = [];
  for (const c of list) { if (c instanceof Ref) { const d = decodeStream(objs.get(c.num)); if (d) parts.push(d); } }
  return Buffer.concat(parts.flatMap((p) => [p, Buffer.from('\n')]));
}

function runContent(objs, data, resources, out, depth) {
  if (depth > 6 || !data) return;
  const res = deref(objs, resources) || {};
  const fonts = deref(objs, res.Font) || {};
  const xobjs = deref(objs, res.XObject) || {};
  const decoders = {};
  const decoderFor = (name) => (decoders[name] = decoders[name] || fontDecoder(objs, fonts[name]));
  let font = (b) => b.toString('latin1');
  const lx = lexer(data);
  let ops = [];
  const emit = (s) => { if (s) out.push(s); };
  const soft = () => { if (out.length && !/\s$/.test(out[out.length - 1])) out.push(' '); };
  const br = () => { if (out.length && !/\n$/.test(out[out.length - 1])) out.push('\n'); };
  let y = null; // the text line's height on the page, from Tm
  for (let t = lx.next(); t !== null; t = lx.next()) {
    if (!(t instanceof Op)) { ops.push(t && (t.t === '[' || t.t === '<<') ? parseValue(lx, t) : t); continue; }
    switch (t.v) {
      case 'Tf': font = ops[0] instanceof Name ? decoderFor(ops[0].v) : font; break;
      case 'Tj': if (Buffer.isBuffer(ops[0])) emit(font(ops[0])); break;
      case "'": br(); if (Buffer.isBuffer(ops[0])) emit(font(ops[0])); break;
      case '"': br(); if (Buffer.isBuffer(ops[2])) emit(font(ops[2])); break;
      case 'TJ':
        for (const x of (Array.isArray(ops[0]) ? ops[0] : [])) {
          if (Buffer.isBuffer(x)) emit(font(x));
          else if (typeof x === 'number' && x < -250) soft();
        }
        break;
      // A new text line breaks the line; a move along the same line is a space.
      case 'Td': case 'TD': if (ops[1] !== 0) br(); else soft(); break;
      case 'T*': br(); break;
      case 'Tm': { const ny = ops[5]; if (y !== null && typeof ny === 'number' && Math.abs(ny - y) > 0.5) br(); else soft(); y = typeof ny === 'number' ? ny : y; break; }
      case 'BT': y = null; break;
      case 'ET': out.push('\n'); break;
      case 'Do': {
        const x = ops[0] instanceof Name ? xobjs[ops[0].v] : null;
        const o = x instanceof Ref ? objs.get(x.num) : null;
        if (o && o.dict && o.dict.Subtype instanceof Name && o.dict.Subtype.v === 'Form') runContent(objs, decodeStream(o), o.dict.Resources || resources, out, depth + 1);
        break;
      }
      case 'BI': { // inline image: skip its bytes up to EI
        const s = data.indexOf('ID', lx.pos, 'latin1');
        const e = s < 0 ? -1 : data.indexOf('EI', s + 2, 'latin1');
        lx.pos = e < 0 ? data.length : e + 2;
        break;
      }
      default: break;
    }
    ops = [];
  }
}

// The text of a PDF, page after page. '' when nothing readable.
function pdfText(buf) {
  if (!Buffer.isBuffer(buf) || buf.toString('latin1', 0, 5) !== '%PDF-') return '';
  const objs = readObjects(buf);
  const out = [];
  for (const p of pagesInOrder(objs)) {
    runContent(objs, contentOf(objs, p.page.Contents), p.resources, out, 0);
    out.push('\n');
  }
  return joinWrapped(out.join('').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim());
}

// A sentence wrapped onto the next line of its text box is joined back: a line
// that does not end a sentence, followed by one that starts in lower case or
// with a digit, is the same sentence. A heading ("The Estate at Cherokee Dock")
// followed by a capitalised sentence stays its own line.
function joinWrapped(text) {
  return text.replace(/([^.!?:\n])\n(?=[a-z0-9(])/g, '$1 ');
}

module.exports = { pdfText, parseCMap, lexer, parseValue };
