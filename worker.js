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

async function load(model, big) {
  const want = (await hasWebGPU()) ? 'webgpu' : 'wasm';
  if (big && want !== 'webgpu') throw new Error('The “Most accurate” quality needs a graphics card (WebGPU), which this computer does not offer. Choose “Very accurate” instead.');
  const key = model + '|' + want;
  if (asr && loadedKey === key) return;
  if (asr && asr.dispose) { try { await asr.dispose(); } catch (_) {} }
  asr = null;
  const progress_callback = (p) => self.postMessage({ type: 'progress', p });
  const attempt = async (dev) => {
    const dtype = big ? { encoder_model: 'q4', decoder_model_merged: 'q4' } : dev === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8';
    return pipeline('automatic-speech-recognition', model, { device: dev, dtype, progress_callback });
  };
  try {
    try { asr = await attempt(want); }
    catch (err) { // the graphics card can be busy for a moment after the engine was restarted: try once more
      if (want !== 'webgpu') throw err;
      await new Promise((r) => setTimeout(r, 2500));
      asr = await attempt(want);
    }
    device = want;
  } catch (err) {
    if (want !== 'webgpu' || big) throw (big ? new Error('The graphics card did not answer. Close other programs or browser tabs that use a lot of graphics, then restart CaptionPress and try again – or choose “Very accurate” quality.') : err);
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
      await load(m.model, !!m.big);
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
      const opts = { return_timestamps: m.words ? 'word' : true, task: m.task || 'transcribe' };
      if (m.language) opts.language = m.language;
      // a short piece cannot hold many words: a limit stops Whisper looping on music (the cause of most "stuck" pieces)
      if (m.audio && m.audio.length) opts.max_new_tokens = Math.min(440, Math.max(64, Math.ceil(m.audio.length / 16000 * 12)));
      let out, words = !!m.words;
      try { out = await asr(m.audio, opts); }
      catch (err) {
        if (!words) throw err;
        words = false; opts.return_timestamps = true; // model without word timing: fall back to sentence timing
        out = await asr(m.audio, opts);
      }
      self.postMessage({ type: 'result', id: m.id, chunks: out.chunks || [], text: out.text || '', words });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
