// ORDER #3250 (#3218 rows 4 and 6, 11.11.2026): the ONE fast-model id, shared
// by the photo tagger's tag call (lib/photo-tagger.js) and the dashboard's AI
// narrative (lib/ai-narrative.js). Was the dated Haiku 4.5 id, inline in both.
// Override with the FAST_MODEL env variable, read at call time, the same way
// lib/agent-llm.js pairs DEFAULT_MODEL with AGENT_MODEL.
// The Opus "pick" pin (photo-tagger PICK_MODEL, #3218 row 5) is NOT this.
'use strict';

const FAST_MODEL = 'claude-haiku-5-5';

function fastModel(env = process.env) {
  return env.FAST_MODEL || FAST_MODEL;
}

module.exports = { FAST_MODEL, fastModel };
