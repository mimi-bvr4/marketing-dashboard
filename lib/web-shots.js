// ORDER #1873: screenshots for a Web Agent card, 390px (phone) and 1280px
// (desktop). The draft preview needs a WordPress login the Box's browser does
// not have (#1774), so the "after" shot is the draft's own content and scoped
// CSS rendered on a blank page: her design, not the theme's header and footer.
// The "before" shot is the live public page. Uses Playwright only if this
// machine can load it (WEB_AGENT_PLAYWRIGHT names a path); otherwise the card
// says the shots were not taken, never that they passed.
'use strict';

const WIDTHS = { mobile: 390, desktop: 1280 };

function loadPlaywright(env = process.env) {
  for (const p of [env.WEB_AGENT_PLAYWRIGHT, 'playwright'].filter(Boolean)) {
    try { return require(p); } catch (e) { /* try the next */ }
  }
  return null;
}

function previewDoc(content, title) {
  const body = String(content).replace(/<!--\s*\/?wp:[^>]*-->/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${String(title || '').replace(/</g, '')}</title>
<style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body>${body}</body></html>`;
}

function createShooter({ pw = loadPlaywright() } = {}) {
  if (!pw || !pw.chromium) return null;
  return async function shoot({ html, url }) {
    const browser = await pw.chromium.launch();
    const out = {};
    try {
      for (const [k, w] of Object.entries(WIDTHS)) {
        const page = await browser.newPage({ viewport: { width: w, height: 900 } });
        if (url) await page.goto(url, { waitUntil: 'load', timeout: 30000 }); else await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
        out[k] = (await page.screenshot({ fullPage: true, type: 'png' })).toString('base64');
        await page.close();
      }
    } finally { await browser.close(); }
    return out;
  };
}

module.exports = { createShooter, previewDoc, loadPlaywright, WIDTHS };
