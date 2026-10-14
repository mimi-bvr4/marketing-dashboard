// ORDER #1796: the local SigLIP model (#1790), loaded only when it is asked for.
//
// @huggingface/transformers is an OPTIONAL dependency. When it is not installed
// (or PHOTO_MEANING=off), loadTransformers() answers null and every caller falls
// back: the night step prints EMBED SKIPPED and exits 4, the Photos page
// searches by tags exactly as before. The model files download once from
// Hugging Face into the cache folder; no photo and no search is ever sent there.
//
//   image side: the Box's night step only (jobs/photo_embed.js)
//   text side:  wherever the Photos page runs, for the typed words
'use strict';

const path = require('path');
const os = require('os');
const { MODEL_ID, textPrompt } = require('./photo-meaning');

function loadTransformers({ env = process.env, req = require } = {}) {
  if (String(env.PHOTO_MEANING || '').toLowerCase() === 'off') return null;
  try { return req('@huggingface/transformers'); } catch (_) { return null; }
}

const pooled = (out) => Array.from(out.pooler_output.data);

// side: 'image', 'text' or 'both'. Each half loads on first use and stays loaded.
function createLocalEmbedder({ tf, model = MODEL_ID, side = 'both',
  cacheDir = process.env.PHOTO_MODEL_CACHE || path.join(os.homedir(), '.cache', 'ihg-photo-model') } = {}) {
  if (!tf) return null;
  tf.env.cacheDir = cacheDir;
  tf.env.allowLocalModels = false;
  let vision = null;
  let text = null;
  const loadVision = () => (vision = vision || Promise.all([
    tf.AutoProcessor.from_pretrained(model), tf.SiglipVisionModel.from_pretrained(model, { dtype: 'fp32' })]));
  const loadText = () => (text = text || Promise.all([
    tf.AutoTokenizer.from_pretrained(model), tf.SiglipTextModel.from_pretrained(model, { dtype: 'fp32' })]));
  const e = { model };
  if (side !== 'text') {
    e.embedImage = async (bytes) => {
      const [processor, m] = await loadVision();
      const img = await tf.RawImage.fromBlob(new Blob([bytes]));
      const inputs = await processor(img);
      return pooled(await m({ pixel_values: inputs.pixel_values }));
    };
  }
  if (side !== 'image') {
    e.embedText = async (q) => {
      const [tokenizer, m] = await loadText();
      const enc = tokenizer([textPrompt(q)], { padding: 'max_length', max_length: 64, truncation: true });
      return pooled(await m(enc));
    };
  }
  return e;
}

module.exports = { loadTransformers, createLocalEmbedder };
