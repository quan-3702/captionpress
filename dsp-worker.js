// CaptionPress – key and speed worker. Makes music higher / lower (in semitones) and faster / slower without
// changing the other: a phase vocoder with phase locking stretches the time, then the sound is resampled.
const N = 4096, HS = 1024;
const win = new Float64Array(N);
for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
const rev = new Uint32Array(N), cosT = new Float64Array(N / 2), sinT = new Float64Array(N / 2);
{
  const bits = Math.log2(N);
  for (let i = 0; i < N; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
  for (let k = 0; k < N / 2; k++) { cosT[k] = Math.cos(2 * Math.PI * k / N); sinT[k] = Math.sin(2 * Math.PI * k / N); }
}
// in-place complex FFT (inverse = true gives the unscaled inverse)
function fft(re, im, inverse) {
  for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let s = 0; s < N; s += size) {
      for (let k = 0; k < half; k++) {
        const c = cosT[k * step], sn = inverse ? sinT[k * step] : -sinT[k * step];
        const a = s + k, b = a + half;
        const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}
const TWO_PI = 2 * Math.PI;
const wrap = (x) => x - TWO_PI * Math.round(x / TWO_PI);

// time-stretch one channel by `s` (output is s times as long)
function stretch(x, s, report) {
  if (Math.abs(s - 1) < 1e-6) return x;
  const ha = HS / s, len = x.length;
  const pad = N / 2;
  const src = new Float32Array(len + N * 2); src.set(x, pad);
  const frames = Math.max(1, Math.floor((len + pad) / ha) + 1);
  const outLen = Math.ceil(len * s) + N * 2;
  const out = new Float64Array(outLen), norm = new Float64Array(outLen);
  const half = N / 2 + 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  const mag = new Float64Array(half), ph = new Float64Array(half), prevPh = new Float64Array(half), synPh = new Float64Array(half);
  const peaks = new Int32Array(half);
  for (let m = 0; m < frames; m++) {
    const ta = m * ha, i0 = Math.floor(ta), fr = ta - i0;
    for (let i = 0; i < N; i++) {
      const a = src[i0 + i] || 0, b = src[i0 + i + 1] || 0;
      re[i] = (a + (b - a) * fr) * win[i]; im[i] = 0;
    }
    fft(re, im, false);
    for (let k = 0; k < half; k++) { mag[k] = Math.hypot(re[k], im[k]); ph[k] = Math.atan2(im[k], re[k]); }
    if (m === 0) synPh.set(ph);
    else {
      // peaks: louder than two neighbours on each side
      let np = 0;
      for (let k = 2; k < half - 2; k++) if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > mag[k - 2] && mag[k] >= mag[k + 2]) peaks[np++] = k;
      if (!np) peaks[np++] = 1;
      for (let p = 0; p < np; p++) {
        const k = peaks[p], om = TWO_PI * k / N;
        const dphi = wrap(ph[k] - prevPh[k] - om * ha);
        synPh[k] = synPh[k] + (om + dphi / ha) * HS;
      }
      // every other bin keeps its phase difference to the nearest peak (phase locking)
      let p = 0;
      for (let k = 0; k < half; k++) {
        while (p < np - 1 && Math.abs(peaks[p + 1] - k) <= Math.abs(peaks[p] - k)) p++;
        const pk = peaks[p];
        if (k !== pk) synPh[k] = synPh[pk] + (ph[k] - ph[pk]);
      }
      for (let p2 = 0; p2 < np; p2++) synPh[peaks[p2]] = wrap(synPh[peaks[p2]]);
    }
    prevPh.set(ph);
    for (let k = 0; k < half; k++) { re[k] = mag[k] * Math.cos(synPh[k]); im[k] = mag[k] * Math.sin(synPh[k]); }
    for (let k = half; k < N; k++) { re[k] = re[N - k]; im[k] = -im[N - k]; }
    fft(re, im, true);
    const ts = m * HS;
    for (let i = 0; i < N; i++) { const o = ts + i; if (o >= outLen) break; out[o] += re[i] / N * win[i]; norm[o] += win[i] * win[i]; }
    if (report && m % 200 === 0) report(m / frames);
  }
  const want = Math.round(len * s), y = new Float32Array(want);
  for (let i = 0; i < want; i++) { const o = i + pad; y[i] = norm[o] > 1e-3 ? out[o] / norm[o] : 0; }
  return y;
}
// read x at a speed of `p` (p > 1: higher and shorter) with cubic interpolation
function resample(x, p) {
  if (Math.abs(p - 1) < 1e-6) return x;
  const n = Math.floor((x.length - 1) / p), y = new Float32Array(n), last = x.length - 1;
  for (let i = 0; i < n; i++) {
    const t = i * p, k = Math.floor(t), f = t - k;
    const x0 = x[Math.max(0, k - 1)], x1 = x[k], x2 = x[Math.min(last, k + 1)], x3 = x[Math.min(last, k + 2)];
    y[i] = x1 + 0.5 * f * (x2 - x0 + f * (2 * x0 - 5 * x1 + 4 * x2 - x3 + f * (3 * (x1 - x2) + x3 - x0)));
  }
  return y;
}
self.onmessage = (e) => {
  const m = e.data;
  if (m.type !== 'run') return;
  try {
    const p = Math.pow(2, (Number(m.semis) || 0) / 12), tempo = Number(m.tempo) || 1;
    const s = p / tempo;
    const chans = m.chans, out = [];
    chans.forEach((x, c) => {
      const st = stretch(x, s, (f) => postMessage({ type: 'progress', p: (c + f) / chans.length }));
      out.push(resample(st, p));
    });
    postMessage({ type: 'done', chans: out }, out.map((x) => x.buffer));
  } catch (err) { postMessage({ type: 'error', message: String((err && err.message) || err) }); }
};
