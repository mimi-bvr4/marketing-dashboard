// ORDER #1015: the agents' text model. Same key lookup as the photo tagger
// (env ANTHROPIC_API_KEY, then Keychain 'anthropic-api-key', then the brain
// config file), so the agents use the API key, never the Box's Claude plan.
'use strict';

const { findApiKey } = require('./photo-tagger');

// Model string as the Sales Brain runs it today (sales-brain config.py, 10.11.2026).
// Override with AGENT_MODEL.
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

function createTextClient({ apiKey, model = process.env.AGENT_MODEL || DEFAULT_MODEL, fetchImpl = globalThis.fetch } = {}) {
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
      return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    },
  };
}

function textClientFromEnv() {
  const k = findApiKey();
  return k ? { client: createTextClient({ apiKey: k.key }), source: k.source } : { client: null, source: null };
}

module.exports = { createTextClient, textClientFromEnv, DEFAULT_MODEL };
