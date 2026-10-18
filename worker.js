// CaptionPress speech-recognition worker. Runs Whisper on this computer (WebGPU when available, otherwise WebAssembly).
import { pipeline, env, AutoProcessor, AutoModel } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

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

// Voice fingerprints for telling speakers apart (WeSpeaker ResNet34, about 27 MB).
const SPK_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';
let spk = null;
async function loadSpk() {
  if (spk) return spk;
  const progress_callback = (p) => self.postMessage({ type: 'progress', src: 'spk', p });
  const proc = await AutoProcessor.from_pretrained(SPK_MODEL, { progress_callback });
  let model = null, dev = 'wasm';
  if (await hasWebGPU()) { try { model = await AutoModel.from_pretrained(SPK_MODEL, { device: 'webgpu', dtype: 'fp32', progress_callback }); dev = 'webgpu'; } catch (_) { model = null; } }
  if (!model) model = await AutoModel.from_pretrained(SPK_MODEL, { device: 'wasm', dtype: 'fp32', progress_callback });
  spk = { proc, model, dev };
  return spk;
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
    } else if (m.type === 'embed') {
      const s = await loadSpk();
      const out = [];
      for (const a of m.audios) {
        if (!a || a.length < 8000) { out.push(null); continue; }
        const o = await s.model(await s.proc(a));
        const t = o.last_hidden_state || o[Object.keys(o)[0]];
        out.push(Float32Array.from(t.data));
      }
      self.postMessage({ type: 'embedded', id: m.id, out, device: s.dev });
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
