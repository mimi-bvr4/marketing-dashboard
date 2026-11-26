// ORDER #3250: the /api/ai/narrative model call, lifted out of server.js
// unchanged except for the model id, so a test can hand it a stub fetch.
// The route in server.js keeps its own 501 (no key) and 500 (thrown) answers.
'use strict';

const { fastModel, HAIKU_5_5_OVERHEAD_TOKENS } = require('./fast-model');

const API_URL = 'https://api.anthropic.com/v1/messages';
// ORDER #3852: 500 was all thinking on Haiku 5.5 (measured, see lib/fast-model.js),
// so every narrative read "No analysis available." The prompt's 180-word rule
// is unchanged; this is a ceiling.
const NARRATIVE_MAX_TOKENS = 500 + HAIKU_5_5_OVERHEAD_TOKENS;

async function requestNarrative({ apiKey, prompt, data, fetchImpl = globalThis.fetch }) {
  const r = await fetchImpl(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: fastModel(),
      max_tokens: NARRATIVE_MAX_TOKENS,
      messages: [{
        role: 'user',
        content: prompt + '\n\nData: ' + JSON.stringify(data)
      }]
    })
  });
  const result = await r.json();
  // ORDER #3849: every `text` block, joined, the way lib/agent-llm.js reads an
  // answer. It read only content[0].text, so a first block of another type
  // (a 5.5-generation model can open with one) gave "No analysis available."
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  return { text: text || 'No analysis available.' };
}

module.exports = { requestNarrative, NARRATIVE_MAX_TOKENS };
