// ORDER #3250: the /api/ai/narrative model call, lifted out of server.js
// unchanged except for the model id, so a test can hand it a stub fetch.
// The route in server.js keeps its own 501 (no key) and 500 (thrown) answers.
'use strict';

const { fastModel } = require('./fast-model');

const API_URL = 'https://api.anthropic.com/v1/messages';

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
      max_tokens: 500,
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

module.exports = { requestNarrative };
