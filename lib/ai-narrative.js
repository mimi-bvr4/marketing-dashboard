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
  return { text: result.content?.[0]?.text || 'No analysis available.' };
}

module.exports = { requestNarrative };
