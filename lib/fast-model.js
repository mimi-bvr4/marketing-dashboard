// ORDER #3250 (#3218 rows 4 and 6, 11.11.2026): the ONE fast-model id, shared
// by the photo tagger's tag call (lib/photo-tagger.js) and the dashboard's AI
// narrative (lib/ai-narrative.js). Was the dated Haiku 4.5 id, inline in both.
// Override with the FAST_MODEL env variable, read at call time, the same way
// lib/agent-llm.js pairs DEFAULT_MODEL with AGENT_MODEL.
// The Opus "pick" pin (photo-tagger PICK_MODEL, #3218 row 5) is NOT this.
'use strict';

const FAST_MODEL = 'claude-haiku-5-5';

// ORDER #3852: like Sonnet 5.5 (#3849), Haiku 5.5 spends part of max_tokens in a
// thinking block before the first `text` block. Measured 11.26.2026 ~05:20 CT,
// one fixture narrative call shaped as lib/ai-narrative.js builds it: at
// max_tokens 500 it stopped at max_tokens with no text at all (thinking 500);
// at 10000 it ended with 1344 thinking tokens, then 363 tokens (919 characters)
// of answer. 3000 gives that one measurement about 2x room, since thinking
// length varies call to call. A budget sized for Haiku 4.5 gets this added to
// it; a budget is a ceiling, not a target.
const HAIKU_5_5_OVERHEAD_TOKENS = 3000;

function fastModel(env = process.env) {
  return env.FAST_MODEL || FAST_MODEL;
}

module.exports = { FAST_MODEL, fastModel, HAIKU_5_5_OVERHEAD_TOKENS };
