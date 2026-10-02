'use strict';

// The skeleton's palette and type tokens (Nashville_Wedding_Venue_Hub_SKELETON_09.29.2026.html).
// Inline, one request, no web-font download: "Le Jour Serif" and "Josefin Sans"
// are used when installed and fall back to the skeleton's own stack.

const CSS = `
:root{--ih-white:#FFFFFF;--ih-white-soft:#FDFCFA;--ih-ivory:#FAF6F0;--ih-cream:#F4EEE5;--ih-champagne:#EBE1D2;--ih-taupe:#D2C7B8;--ih-stone:#B3A797;--ih-greige:#8F8677;--ih-charcoal:#3B3733;--ih-ink:#1C1A17;--ih-black:#111010;--ih-blush:#E6D3CD;--ih-sage:#BFC5B4;--ih-gold:#C8B08A;
--font-display:"Le Jour Serif","Didot","Cormorant Garamond",Georgia,serif;--font-sans:"Josefin Sans","Century Gothic",system-ui,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font-sans);color:var(--ih-charcoal);background:var(--ih-white);line-height:1.6;font-size:15px}
a{color:inherit}
.preview-bar{background:var(--ih-gold);color:var(--ih-ink);text-align:center;font-size:12px;letter-spacing:.12em;text-transform:uppercase;padding:6px}
.top{position:absolute;left:0;right:0;display:flex;justify-content:space-between;align-items:center;padding:24px 5vw;z-index:2}
.wordmark{font-family:var(--font-display);letter-spacing:.32em;text-transform:uppercase;font-size:13px;color:var(--ih-ivory);text-decoration:none}
.btn-ghost{border:1px solid var(--ih-taupe);color:var(--ih-ivory);padding:10px 22px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;text-decoration:none}
.btn-light,.btn-dark{display:inline-block;padding:14px 30px;font:inherit;font-size:11px;letter-spacing:.2em;text-transform:uppercase;text-decoration:none;border:0;cursor:pointer}
.btn-light{background:var(--ih-ivory);color:var(--ih-ink)}
.btn-dark{background:var(--ih-ink);color:var(--ih-ivory)}
.display{font-family:var(--font-display);font-weight:400;text-transform:uppercase;letter-spacing:.02em;line-height:1.05;color:var(--ih-ink)}
.eyebrow{font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--ih-stone)}
.hero{position:relative;min-height:78vh;display:flex;flex-direction:column;justify-content:flex-end;padding:120px 5vw 48px;background:linear-gradient(180deg,#77736b 0%,var(--ih-charcoal) 100%);color:var(--ih-ivory);overflow:hidden}
.hero .slot{position:absolute;inset:0;background:transparent;border:0;color:rgba(250,246,240,.45)}
.hero .display{color:var(--ih-ivory);font-size:clamp(34px,5.4vw,64px);margin:12px 0 28px;position:relative}
.hero .eyebrow{color:var(--ih-taupe);position:relative}
.hero p.lede{max-width:560px;margin:-12px 0 28px;position:relative;color:var(--ih-cream)}
.hero .btn-light{position:relative;align-self:flex-start}
.band{padding:72px 5vw}
.band h2.display{font-size:clamp(30px,4.4vw,52px);margin:14px 0 28px}
hr{border:0;border-top:1px solid var(--ih-taupe);margin:0 0 40px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:56px 40px}
.slot{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;background:var(--ih-champagne);border:1px solid var(--ih-taupe);color:var(--ih-greige);font-size:12px;aspect-ratio:3/2;padding:16px}
.slot-icon{width:16px;height:13px;border:1.5px solid currentColor;border-radius:2px}
.card h3{font-family:var(--font-display);font-weight:400;text-transform:uppercase;font-size:22px;color:var(--ih-ink);border-top:1px solid var(--ih-taupe);margin-top:16px;padding-top:18px}
.tags{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--ih-stone);margin:4px 0 12px}
.card p{font-size:13px;max-width:440px}
.link-arrow{display:inline-block;margin-top:14px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;text-decoration:none}
.link-arrow::after{content:" \\2192"}
.held{font-size:11px;color:#8a5a2b;background:#fbf3e6;border-left:2px solid var(--ih-gold);padding:6px 10px;margin:8px 0}
.fitnote{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8a5a2b}
.compare{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:0;border-top:1px solid var(--ih-taupe)}
.compare .col{padding:28px 24px;border-right:1px solid var(--ih-taupe)}
.compare .col:last-child{border-right:0}
.rows .row{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr);gap:32px;align-items:center;padding:32px 0;border-bottom:1px solid var(--ih-taupe)}
.faq dt{font-family:var(--font-display);text-transform:uppercase;color:var(--ih-ink);margin-top:20px}
.inquire{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:56px;background:#F2F2F2;padding:80px 5vw}
.inquire h2{font-size:clamp(30px,4vw,48px);margin-bottom:24px}
.inquire h2 em{font-style:italic}
.inquire p{margin-bottom:12px;max-width:420px}
.lead{display:grid;grid-template-columns:1fr 1fr;gap:26px 32px}
.lead label,.lead legend{display:block;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--ih-greige)}
.lead input:not([type=checkbox]),.lead select,.lead textarea{display:block;width:100%;margin-top:8px;border:0;border-bottom:1px solid var(--ih-stone);background:transparent;font:inherit;font-size:14px;letter-spacing:0;text-transform:none;padding:6px 0;color:var(--ih-ink)}
.lead .wide{grid-column:1/-1}
.lead fieldset{border:0}
.chip{display:inline-block!important;margin:10px 8px 0 0}
.chip input{position:absolute;opacity:0}
.chip span{display:inline-block;border:1px solid var(--ih-stone);padding:7px 12px}
.chip input:checked+span{background:var(--ih-ink);color:var(--ih-ivory)}
.chip input:focus-visible+span{outline:2px solid var(--ih-gold)}
.check{margin-top:16px;text-transform:none!important;letter-spacing:0!important;font-size:12px!important}
.foot{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:40px;background:var(--ih-ink);color:var(--ih-stone);padding:64px 5vw;font-size:12px}
.foot h4{font-weight:400;font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--ih-taupe);margin-bottom:14px}
.foot ul{list-style:none}.foot li{margin-bottom:8px}.foot a{text-decoration:none}
.foot .wordmark{margin-bottom:14px;display:block}
.thanks{min-height:60vh;padding:160px 5vw 80px}
@media (max-width:760px){.inquire,.foot,.rows .row{grid-template-columns:1fr}.lead{grid-template-columns:1fr}.band{padding:56px 6vw}.hero{min-height:70vh}}
`;

module.exports = { CSS };
