#!/usr/bin/env node
// ORDER #1688: read Katherine's Collateral Map with every cell's link and
// print what the Cadet can reach. Read-only. `--raw` prints each row's text and
// link as the Sheets API returned it (for checking the layout). `--search
// "<phrase>"` runs one Cadet search from the Box and prints the answer.
'use strict';

const { createDriveClient } = require('../lib/drive-client');
const { readMap, parseMap, summarize, cellLink } = require('../lib/collateral-map');
const { search } = require('../lib/cadet-search');

async function main({ argv = process.argv.slice(2), log = console.log } = {}) {
  const drive = createDriveClient();
  const tabs = await readMap(drive);
  if (argv.includes('--raw')) {
    for (const t of tabs) {
      log(`== ${t.title} (${t.rows.length} rows)`);
      t.rows.forEach((r, n) => {
        const cells = r.map((c) => String((c && c.formattedValue) || '').trim());
        if (!cells.some(Boolean)) return;
        const links = r.map(cellLink).filter(Boolean);
        log(`${n + 1}\t${cells.join(' | ')}${links.length ? `\t-> ${links.join(' ; ')}` : ''}`);
      });
    }
    return 0;
  }
  const { materials } = parseMap(tabs);
  const at = argv.indexOf('--search');
  if (at >= 0) {
    const r = await search({ phrase: argv[at + 1], materials, drive });
    if (r.error) { log(r.error); return 2; }
    log(JSON.stringify(r, null, 1));
    return 0;
  }
  log(JSON.stringify(summarize(materials), null, 1));
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error('cadet_map:', e.message); process.exit(1); });

module.exports = { main };
