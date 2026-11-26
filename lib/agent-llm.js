// ORDER #1015: the agents' text model. Same key lookup as the photo tagger
// (env ANTHROPIC_API_KEY, then Keychain 'anthropic-api-key', then the brain
// config file), so the agents use the API key, never the Box's Claude plan.
'use strict';

const { findApiKey } = require('./photo-tagger');

// ORDER #3249 (#3218 row 3, 11.11.2026): current Sonnet, proven live from the
// Box in #3219 row 12. Was Sonnet 4.6. Override with AGENT_MODEL.
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

// ORDER #3849: on claude-sonnet-5-5 most of a call's max_tokens can be spent
// before the first `text` block this client keeps. Measured 11.23.2026 06:00 CT
// (~/Library/Logs/ihg_marketing_agents.out:679): the seo agent at max_tokens 9000
// stopped at max_tokens with 773 characters of text, so about 9000 - 773/3 =
// 8,743 tokens went before the text (#3847). Rounded up to 9000. A budget sized
// for Sonnet 4.6 gets this added to it; a budget is a ceiling, not a target.
const SONNET_5_5_OVERHEAD_TOKENS = 9000;

// ORDER #3752: the ONE place AGENT_MODEL is read, at call time. createTextClient,
// both agent-sources Claude call sites and the public /health all ask this, so
// /health reports exactly the id the agents send.
function agentModel(env = process.env) {
  return env.AGENT_MODEL || DEFAULT_MODEL;
}

function createTextClient({ apiKey, model = agentModel(), fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) return null;
  return {
    model,
    async complete({ system, user, maxTokens = 8000 }) {
      const r = await fetchImpl(API_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!r.ok) throw new Error(`model answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j = await r.json();
      // #2910: the runner reads this to tell a cut-off answer from a broken one.
      this.lastStop = j.stop_reason || null;
      return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    },
  };
}

function textClientFromEnv() {
  const k = findApiKey();
  return k ? { client: createTextClient({ apiKey: k.key }), source: k.source } : { client: null, source: null };
}

module.exports = { createTextClient, textClientFromEnv, DEFAULT_MODEL, agentModel, SONNET_5_5_OVERHEAD_TOKENS };
