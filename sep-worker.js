// CaptionPress – vocal remover worker. Separates the singing voice from the music on this computer with the
// HTDemucs AI model (WebGPU when available, otherwise WebAssembly). Nothing is uploaded.
//
// The STFT helpers and the model input/output handling below come from demucs-web by timcsy:
/*
MIT License

Copyright (c) 2024

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.webgpu.min.mjs';
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
ort.env.wasm.numThreads = 1;

const MODEL_URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
const MODEL_CACHE = 'captionpress-sep';
const SAMPLE_RATE = 44100, FFT_SIZE = 4096, HOP_SIZE = 1024, TRAINING_SAMPLES = 343980, MODEL_SPEC_BINS = 2048, MODEL_SPEC_FRAMES = 336, SEGMENT_OVERLAP = 0.25;
const VOCALS = 3;

/**
 * Fast FFT/iFFT implementation using Cooley-Tukey radix-2 algorithm
 */

const fftTwiddles = new Map();
const ifftTwiddles = new Map();
const hannWindows = new Map();

function getFFTTwiddles(n) {
  if (fftTwiddles.has(n)) return fftTwiddles.get(n);
  const real = new Float32Array(n / 2);
  const imag = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    const angle = -2 * Math.PI * k / n;
    real[k] = Math.cos(angle);
    imag[k] = Math.sin(angle);
  }
  const twiddles = { real, imag };
  fftTwiddles.set(n, twiddles);
  return twiddles;
}

function getIFFTTwiddles(n) {
  if (ifftTwiddles.has(n)) return ifftTwiddles.get(n);
  const real = new Float32Array(n / 2);
  const imag = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    const angle = 2 * Math.PI * k / n;
    real[k] = Math.cos(angle);
    imag[k] = Math.sin(angle);
  }
  const twiddles = { real, imag };
  ifftTwiddles.set(n, twiddles);
  return twiddles;
}

function getHannWindow(size) {
  if (hannWindows.has(size)) return hannWindows.get(size);
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / size));
  }
  hannWindows.set(size, window);
  return window;
}

function bitReverse(n, bits) {
  let result = 0;
  for (let i = 0; i < bits; i++) {
    result = (result << 1) | (n & 1);
    n >>= 1;
  }
  return result;
}

function fft(realOut, imagOut, realIn, n) {
  const bits = Math.log2(n) | 0;
  const twiddles = getFFTTwiddles(n);

  for (let i = 0; i < n; i++) {
    const j = bitReverse(i, bits);
    realOut[i] = realIn[j];
    imagOut[i] = 0;
  }

  for (let size = 2; size <= n; size *= 2) {
    const halfSize = size / 2;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < halfSize; j++) {
        const k = j * step;
        const tReal = twiddles.real[k];
        const tImag = twiddles.imag[k];
        const idx1 = i + j;
        const idx2 = i + j + halfSize;
        const eReal = realOut[idx1];
        const eImag = imagOut[idx1];
        const oReal = realOut[idx2] * tReal - imagOut[idx2] * tImag;
        const oImag = realOut[idx2] * tImag + imagOut[idx2] * tReal;
        realOut[idx1] = eReal + oReal;
        imagOut[idx1] = eImag + oImag;
        realOut[idx2] = eReal - oReal;
        imagOut[idx2] = eImag - oImag;
      }
    }
  }
}

function ifft(realOut, imagOut, realIn, imagIn, n) {
  const bits = Math.log2(n) | 0;
  const twiddles = getIFFTTwiddles(n);

  for (let i = 0; i < n; i++) {
    const j = bitReverse(i, bits);
    realOut[i] = realIn[j];
    imagOut[i] = imagIn[j];
  }

  for (let size = 2; size <= n; size *= 2) {
    const halfSize = size / 2;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < halfSize; j++) {
        const k = j * step;
        const tReal = twiddles.real[k];
        const tImag = twiddles.imag[k];
        const idx1 = i + j;
        const idx2 = i + j + halfSize;
        const eReal = realOut[idx1];
        const eImag = imagOut[idx1];
        const oReal = realOut[idx2] * tReal - imagOut[idx2] * tImag;
        const oImag = realOut[idx2] * tImag + imagOut[idx2] * tReal;
        realOut[idx1] = eReal + oReal;
        imagOut[idx1] = eImag + oImag;
        realOut[idx2] = eReal - oReal;
        imagOut[idx2] = eImag - oImag;
      }
    }
  }

  for (let i = 0; i < n; i++) {
    realOut[i] /= n;
    imagOut[i] /= n;
  }
}

function stft(signal, fftSize, hopSize) {
  const numFrames = Math.floor((signal.length - fftSize) / hopSize) + 1;
  const numBins = fftSize / 2 + 1;
  const window = getHannWindow(fftSize);
  const scale = 1.0 / Math.sqrt(fftSize);

  const specReal = new Float32Array(numFrames * numBins);
  const specImag = new Float32Array(numFrames * numBins);
  const frameReal = new Float32Array(fftSize);
  const frameImag = new Float32Array(fftSize);
  const windowedFrame = new Float32Array(fftSize);

  for (let frame = 0; frame < numFrames; frame++) {
    const start = frame * hopSize;
    for (let i = 0; i < fftSize; i++) {
      windowedFrame[i] = signal[start + i] * window[i];
    }
    fft(frameReal, frameImag, windowedFrame, fftSize);
    const outOffset = frame * numBins;
    for (let k = 0; k < numBins; k++) {
      specReal[outOffset + k] = frameReal[k] * scale;
      specImag[outOffset + k] = frameImag[k] * scale;
    }
  }

  return { real: specReal, imag: specImag, numFrames, numBins };
}

function istft(specReal, specImag, numFrames, numBins, fftSize, hopSize, length) {
  const outputLength = length || (numFrames - 1) * hopSize + fftSize;
  const output = new Float32Array(outputLength);
  const windowSum = new Float32Array(outputLength);
  const window = getHannWindow(fftSize);
  const scale = Math.sqrt(fftSize);

  const fullReal = new Float32Array(fftSize);
  const fullImag = new Float32Array(fftSize);
  const outReal = new Float32Array(fftSize);
  const outImag = new Float32Array(fftSize);

  for (let frame = 0; frame < numFrames; frame++) {
    fullReal.fill(0);
    fullImag.fill(0);

    for (let k = 0; k < numBins; k++) {
      fullReal[k] = specReal[frame * numBins + k];
      fullImag[k] = specImag[frame * numBins + k];
    }

    for (let k = 1; k < numBins - 1; k++) {
      fullReal[fftSize - k] = fullReal[k];
      fullImag[fftSize - k] = -fullImag[k];
    }

    ifft(outReal, outImag, fullReal, fullImag, fftSize);

    const start = frame * hopSize;
    for (let i = 0; i < fftSize && start + i < outputLength; i++) {
      output[start + i] += outReal[i] * window[i] * scale;
      windowSum[start + i] += window[i] * window[i];
    }
  }

  for (let i = 0; i < outputLength; i++) {
    if (windowSum[i] > 1e-8) {
      output[i] /= windowSum[i];
    }
  }

  return output;
}

function reflectPad(signal, padLeft, padRight) {
  const length = signal.length;
  const output = new Float32Array(padLeft + length + padRight);

  for (let i = 0; i < padLeft; i++) {
    const srcIdx = Math.min(padLeft - i, length - 1);
    output[i] = signal[srcIdx];
  }

  output.set(signal, padLeft);

  for (let i = 0; i < padRight; i++) {
    const srcIdx = Math.max(0, length - 2 - i);
    output[padLeft + length + i] = signal[srcIdx];
  }

  return output;
}


// the vocals track (index 3) of the model's frequency output, back in the time domain
function vocalsFromFreq(freqOutput) {
  const nb = MODEL_SPEC_BINS, nf = MODEL_SPEC_FRAMES, base = VOCALS * 4 * nb * nf;
  const paddedBins = nb + 1, paddedFrames = nf + 4;
  const pad = (c) => {
    const re = new Float32Array(paddedFrames * paddedBins), im = new Float32Array(paddedFrames * paddedBins);
    for (let f = 0; f < nf; f++) for (let b = 0; b < nb; b++) {
      const d = (f + 2) * paddedBins + b;
      re[d] = freqOutput[base + (c * 2) * nb * nf + b * nf + f];
      im[d] = freqOutput[base + (c * 2 + 1) * nb * nf + b * nf + f];
    }
    return { re, im };
  };
  const off = FFT_SIZE / 2 + Math.floor(HOP_SIZE / 2) * 3, len = (paddedFrames - 1) * HOP_SIZE + FFT_SIZE;
  const out = [0, 1].map((c) => { const p = pad(c); return istft(p.re, p.im, paddedFrames, paddedBins, FFT_SIZE, HOP_SIZE, len).subarray(off, off + TRAINING_SAMPLES); });
  return out;
}
function prepareModelInput(leftChannel, rightChannel) {
  const inputLength = TRAINING_SAMPLES;
  const le = Math.ceil(inputLength / HOP_SIZE);
  const pad = Math.floor(HOP_SIZE / 2) * 3;
  const padRight = pad + le * HOP_SIZE - inputLength;
  const centerPad = FFT_SIZE / 2;
  const sl = stft(reflectPad(reflectPad(leftChannel, pad, padRight), centerPad, centerPad), FFT_SIZE, HOP_SIZE);
  const sr = stft(reflectPad(reflectPad(rightChannel, pad, padRight), centerPad, centerPad), FFT_SIZE, HOP_SIZE);
  const nb = MODEL_SPEC_BINS, nf = MODEL_SPEC_FRAMES;
  const mag = new Float32Array(4 * nb * nf);
  for (let f = 0; f < nf; f++) for (let b = 0; b < nb; b++) {
    const s = (f + 2) * sl.numBins + b, d = b * nf + f;
    mag[d] = sl.real[s]; mag[nb * nf + d] = sl.imag[s]; mag[2 * nb * nf + d] = sr.real[s]; mag[3 * nb * nf + d] = sr.imag[s];
  }
  const wave = new Float32Array(2 * inputLength);
  wave.set(leftChannel, 0); wave.set(rightChannel, inputLength);
  return { wave, mag };
}

// the model is downloaded once and kept on this computer
async function modelBytes() {
  let cache = null;
  try { cache = await caches.open(MODEL_CACHE); } catch (_) {}
  let res = cache ? await cache.match(MODEL_URL) : null;
  const fromCache = !!res;
  if (!res) {
    res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error('The vocal remover could not be downloaded (' + res.status + '). Check the internet connection and try again.');
  }
  const total = Number(res.headers.get('Content-Length')) || 172000000;
  const reader = res.body.getReader();
  const parts = []; let got = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (!fromCache && got - last > 1e6) { last = got; postMessage({ type: 'progress', phase: 'download', p: Math.min(1, got / total) }); }
  }
  const buf = new Uint8Array(got); let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  if (!fromCache && cache) { try { await cache.put(MODEL_URL, new Response(buf.slice(0), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(got) } })); } catch (_) {} }
  return buf;
}

let session = null, device = '';
async function hasWebGPU() { try { return !!(self.navigator.gpu && (await self.navigator.gpu.requestAdapter())); } catch (_) { return false; } }
async function load() {
  if (session) return;
  const bytes = await modelBytes();
  postMessage({ type: 'progress', phase: 'load', p: 0 });
  const tries = (await hasWebGPU()) ? ['webgpu', 'wasm'] : ['wasm'];
  let err = null;
  for (const ep of tries) {
    try { session = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: 'basic' }); device = ep; return; }
    catch (e) { err = e; }
  }
  throw err || new Error('The vocal remover could not start on this computer.');
}

async function separate(L, R) {
  const total = L.length;
  const stride = Math.floor(TRAINING_SAMPLES * (1 - SEGMENT_OVERLAP));
  const segs = Math.max(1, Math.ceil(Math.max(0, total - TRAINING_SAMPLES) / stride) + 1);
  const vL = new Float32Array(total), vR = new Float32Array(total), wsum = new Float32Array(total);
  let k = 0;
  for (let start = 0; start < total; start += stride) {
    if (cancel) throw new Error('cancelled');
    const len = Math.min(TRAINING_SAMPLES, total - start);
    const sL = new Float32Array(TRAINING_SAMPLES), sR = new Float32Array(TRAINING_SAMPLES);
    sL.set(L.subarray(start, start + len)); sR.set(R.subarray(start, start + len));
    const inp = prepareModelInput(sL, sR);
    const feeds = {};
    feeds[session.inputNames[0]] = new ort.Tensor('float32', inp.wave, [1, 2, TRAINING_SAMPLES]);
    if (session.inputNames.length > 1) feeds[session.inputNames[1]] = new ort.Tensor('float32', inp.mag, [1, 4, MODEL_SPEC_BINS, MODEL_SPEC_FRAMES]);
    const res = await session.run(feeds);
    let td = null, tdims = null, fd = null;
    for (const n of session.outputNames) {
      const t = res[n];
      if (t.dims.length === 4 && t.dims[2] === 2) { td = t.data; tdims = t.dims; }
      else if (t.dims.length === 5 && t.dims[2] === 4) fd = t.data;
    }
    if (!td) throw new Error('The vocal remover gave an unexpected result.');
    const ns = tdims[3], fr = fd ? vocalsFromFreq(fd) : null;
    const tb = VOCALS * 2 * ns;
    for (let i = 0; i < len; i++) {
      const w = Math.min(1, i / (stride * 0.5), (len - i) / (stride * 0.5));
      const a = td[tb + i] + (fr ? fr[0][i] : 0), b = td[tb + ns + i] + (fr ? fr[1][i] : 0);
      vL[start + i] += a * w; vR[start + i] += b * w; wsum[start + i] += w;
    }
    for (const n of session.outputNames) { try { res[n].dispose && res[n].dispose(); } catch (_) {} }
    k++;
    postMessage({ type: 'progress', phase: 'separate', p: k / segs });
    if (start + TRAINING_SAMPLES >= total) break;
  }
  for (let i = 0; i < total; i++) if (wsum[i] > 0) { vL[i] /= wsum[i]; vR[i] /= wsum[i]; }
  return [vL, vR];
}

let cancel = false;
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'cancel') { cancel = true; return; }
  if (m.type !== 'run') return;
  cancel = false;
  try {
    await load();
    postMessage({ type: 'progress', phase: 'separate', p: 0, device });
    const [vL, vR] = await separate(m.left, m.right);
    postMessage({ type: 'done', vL, vR, device }, [vL.buffer, vR.buffer]);
  } catch (err) {
    postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
