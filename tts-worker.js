// CaptionPress AI voice worker: Piper text-to-speech (open-source, MIT) running on this computer.
/* global ort */
importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.wasm.min.js');
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';
ort.env.wasm.numThreads = 1;

const HF = 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main';
const PHONEMIZE = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';
const GLUE = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/dist/piper-DeOu3H9E.js';
const CACHE = 'captionpress-voices';

let glue = null;
const voices = {}; // voiceId -> { session, config }

function pathOf(id) {
  // e.g. vi_VN-vais1000-medium -> vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx
  const m = id.match(/^(([a-z]{2})_[A-Z]{2})-(.+)-(x_low|low|medium|high)$/);
  if (!m) throw new Error('Unknown voice ' + id);
  return `${m[2]}/${m[1]}/${m[3]}/${m[4]}/${id}.onnx`;
}

async function fetchCached(url, onProgress) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url);
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok) throw new Error('Download failed (' + res.status + ')');
  const total = +(res.headers.get('Content-Length') || 0);
  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); loaded += value.length;
    if (onProgress) onProgress(loaded, total);
  }
  const blob = new Blob(parts);
  try { await cache.put(url, new Response(blob)); } catch (_) {}
  return blob.arrayBuffer();
}

async function loadVoice(id, report) {
  if (voices[id]) return voices[id];
  const p = pathOf(id);
  const config = JSON.parse(new TextDecoder().decode(await fetchCached(`${HF}/${p}.json`)));
  const model = await fetchCached(`${HF}/${p}`, (l, t) => report && report(l, t));
  const session = await ort.InferenceSession.create(model);
  voices[id] = { session, config };
  return voices[id];
}

async function phonemize(text, espeakVoice) {
  if (!glue) glue = await import(GLUE);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Phonemizer timed out')), 20000);
    glue.createPiperPhonemize({
      print: (line) => { clearTimeout(timer); try { resolve(JSON.parse(line).phoneme_ids); } catch (e) { reject(e); } },
      printErr: () => {},
      locateFile: (f) => (f.endsWith('.wasm') ? `${PHONEMIZE}.wasm` : f.endsWith('.data') ? `${PHONEMIZE}.data` : f),
    }).then((mod) => mod.callMain(['-l', espeakVoice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']))
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

async function speak(id, text, speed) {
  const v = await loadVoice(id, (l, t) => self.postMessage({ type: 'progress', loaded: l, total: t }));
  const cfg = v.config;
  const ids = await phonemize(text, cfg.espeak.voice);
  const inf = cfg.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / (speed || 1), inf.noise_w ?? 0.8]), [3]),
  };
  if (cfg.speaker_id_map && Object.keys(cfg.speaker_id_map).length) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  const out = await v.session.run(feeds);
  const data = Float32Array.from(out.output.data);
  return { data, sampleRate: cfg.audio.sample_rate };
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'speak') {
      const r = await speak(m.voice, m.text, m.speed);
      self.postMessage({ type: 'audio', id: m.id, data: r.data, sampleRate: r.sampleRate }, [r.data.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
