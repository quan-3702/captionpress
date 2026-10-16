// CaptionPress speech-recognition worker. Runs Whisper on this computer (WebGPU when available, otherwise WebAssembly).
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;
env.useBrowserCache = true;

let asr = null;
let mt = null, mtKey = '';
let loadedKey = '';
let device = 'wasm';

async function hasWebGPU() {
  try { return !!(self.navigator.gpu && (await self.navigator.gpu.requestAdapter())); } catch (_) { return false; }
}

async function load(model) {
  const want = (await hasWebGPU()) ? 'webgpu' : 'wasm';
  const key = model + '|' + want;
  if (asr && loadedKey === key) return;
  if (asr && asr.dispose) { try { await asr.dispose(); } catch (_) {} }
  asr = null;
  const progress_callback = (p) => self.postMessage({ type: 'progress', p });
  const attempt = async (dev) => {
    const dtype = dev === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8';
    return pipeline('automatic-speech-recognition', model, { device: dev, dtype, progress_callback });
  };
  try {
    asr = await attempt(want);
    device = want;
  } catch (err) {
    if (want !== 'webgpu') throw err;
    asr = await attempt('wasm');
    device = 'wasm';
  }
  loadedKey = model + '|' + want;
}

async function loadMt(model) {
  if (mt && mtKey === model) return;
  if (mt && mt.dispose) { try { await mt.dispose(); } catch (_) {} }
  mt = null;
  mt = await pipeline('translation', model, { dtype: 'q8', device: 'wasm', progress_callback: (p) => self.postMessage({ type: 'progress', src: 'mt', p }) });
  mtKey = model;
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      await load(m.model);
      self.postMessage({ type: 'ready', device });
    } else if (m.type === 'translate') {
      await loadMt(m.model);
      const out = [];
      for (const t of m.texts) {
        const r = await mt(t, { max_new_tokens: 300 });
        out.push((r && r[0] && r[0].translation_text) || '');
      }
      self.postMessage({ type: 'translated', id: m.id, out });
    } else if (m.type === 'run') {
      const opts = { return_timestamps: true, task: m.task || 'transcribe' };
      if (m.language) opts.language = m.language;
      const out = await asr(m.audio, opts);
      self.postMessage({ type: 'result', id: m.id, chunks: out.chunks || [], text: out.text || '' });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
