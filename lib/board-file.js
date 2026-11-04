// ORDER #2920: the Producer's board lines, written into the project tree once a
// day by the 06:00 run, so the Box can read why an agent is stuck without
// signing in to /agents (the page needs a signed-in person) and without
// widening the box_ro grant (agent_runs and agent_cards stay FENCED by ruling).
//
// What the file holds: one line per team member, exactly the line the board
// shows (state and line), which P.board has already passed through safeReason.
// It never holds a card's title or body, a source's raw error, or an ask.
// The file is overwritten each run; it is a photograph of this morning's board.
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./producer');
const { safeReason } = require('./safe-reason');

const REL = path.join('05_AI_and_Brain', 'box_driver_state', 'marketing_board_lines.txt');

// The same rows GET /api/producer builds its board from, read the same way.
async function boardRows({ ymd, store, defs }) {
  const cal = P.calendar(store.calendarRows ? await store.calendarRows() : []);
  const settings = new Map(((store.allCurrentSettings ? await store.allCurrentSettings() : []) || []).map((s) => [s.agent, s]));
  const history = new Map();
  for (const h of (store.runHistory ? await store.runHistory(20) : [])) { const a = history.get(h.agent) || []; a.push(h); history.set(h.agent, a); }
  const today = store.producerDay ? await store.producerDay(ymd) : [];
  return P.board({ ymd, defs, settings, history, today, cal });
}

// One plain line per member. The board line is passed through safeReason once
// more (a no-op on an already-clean line) so nothing secret-shaped can reach the
// synced tree even if a future board line forgets to.
function render(rows, stamp) {
  const head = `MARKETING PRODUCER BOARD, written by the 06:00 run at ${stamp} (ORDER #2920). One line per team member: slug | name | state | the board's line.`;
  const body = rows.map((r) => [r.slug, r.name, r.state, safeReason(r.line, 400)].map((x) => String(x == null ? '' : x).replace(/[|\n]/g, ' ')).join(' | '));
  return [head, ...body, ''].join('\n');
}

async function writeBoardFile({ ymd, store, defs, root, stamp, log = () => {} }) {
  if (!root) { log('board file: not written (no project tree on this machine)'); return { written: false, why: 'no tree' }; }
  const rows = await boardRows({ ymd, store, defs });
  const file = path.join(root, REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, render(rows, stamp));
  fs.renameSync(tmp, file);
  log(`board file: ${rows.length} line(s) written to ${REL}`);
  return { written: true, file, rows: rows.length };
}

function chicagoStamp(now = new Date()) {
  const d = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric' }).replace(/\//g, '.');
  const t = now.toLocaleTimeString('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit' });
  return `${d} ${t} CT`;
}

module.exports = { REL, boardRows, render, writeBoardFile, chicagoStamp };
