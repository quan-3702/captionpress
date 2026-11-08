// CaptionPress – key and speed worker. Makes music higher / lower (in semitones) and faster / slower without
// changing the other: a stereo phase vocoder with phase locking and transient reset stretches the time, then the sound is resampled.
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

// Time-stretch stereo sound by `s` (output is s times as long). Both channels share one phase plan, worked out
// from their sum, so the stereo picture stays put (no "phasey" sound), and the phase is reset on drum hits and other
// sudden sounds so they stay sharp instead of being smeared.
function stretch(chans, s, report) {
  if (Math.abs(s - 1) < 1e-6) return chans;
  const C = chans.length, ha = HS / s, len = chans[0].length;
  const pad = N / 2;
  const srcs = chans.map((x) => { const a = new Float32Array(len + N * 2); a.set(x, pad); return a; });
  const frames = Math.max(1, Math.floor((len + pad) / ha) + 1);
  const outLen = Math.ceil(len * s) + N * 2;
  const outs = chans.map(() => new Float64Array(outLen)), norm = new Float64Array(outLen);
  const half = N / 2 + 1;
  const re = chans.map(() => new Float64Array(N)), im = chans.map(() => new Float64Array(N));
  const mag = new Float64Array(half), ph = new Float64Array(half), prevPh = new Float64Array(half), synPh = new Float64Array(half), prevMag = new Float64Array(half);
  const cph = chans.map(() => new Float64Array(half)), cmag = chans.map(() => new Float64Array(half));
  const peaks = new Int32Array(half);
  let fluxAvg = 0, lastReset = -10;
  for (let m = 0; m < frames; m++) {
    const ta = m * ha, i0 = Math.floor(ta), fr = ta - i0;
    for (let c = 0; c < C; c++) {
      const src = srcs[c], r = re[c], q = im[c];
      for (let i = 0; i < N; i++) { const a = src[i0 + i] || 0, b = src[i0 + i + 1] || 0; r[i] = (a + (b - a) * fr) * win[i]; q[i] = 0; }
      fft(r, q, false);
      for (let k = 0; k < half; k++) { cmag[c][k] = Math.hypot(r[k], q[k]); cph[c][k] = Math.atan2(q[k], r[k]); }
    }
    // the sum of the channels drives the phase plan
    let flux = 0, energy = 0;
    for (let k = 0; k < half; k++) {
      let sr = 0, si = 0; for (let c = 0; c < C; c++) { sr += re[c][k]; si += im[c][k]; }
      mag[k] = Math.hypot(sr, si); ph[k] = Math.atan2(si, sr);
      const d = mag[k] - prevMag[k]; if (d > 0) flux += d; energy += mag[k];
    }
    // a sudden sound: much more new energy than usual → start the phases again from the original (sharp hit)
    const onset = m > 2 && flux > Math.max(1e-6, fluxAvg * 2.2) && flux > energy * 0.25 && m - lastReset > 3;
    fluxAvg = fluxAvg ? fluxAvg * 0.9 + flux * 0.1 : flux;
    if (m === 0 || onset) { synPh.set(ph); if (onset) lastReset = m; }
    else {
      let np = 0;
      for (let k = 2; k < half - 2; k++) if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > mag[k - 2] && mag[k] >= mag[k + 2]) peaks[np++] = k;
      if (!np) peaks[np++] = 1;
      for (let p = 0; p < np; p++) {
        const k = peaks[p], om = TWO_PI * k / N;
        const dphi = wrap(ph[k] - prevPh[k] - om * ha);
        synPh[k] = synPh[k] + (om + dphi / ha) * HS;
      }
      let p = 0;
      for (let k = 0; k < half; k++) {
        while (p < np - 1 && Math.abs(peaks[p + 1] - k) <= Math.abs(peaks[p] - k)) p++;
        const pk = peaks[p];
        if (k !== pk) synPh[k] = synPh[pk] + (ph[k] - ph[pk]);
      }
      for (let p2 = 0; p2 < np; p2++) synPh[peaks[p2]] = wrap(synPh[peaks[p2]]);
    }
    prevPh.set(ph); prevMag.set(mag);
    const ts = m * HS;
    for (let c = 0; c < C; c++) {
      const r = re[c], q = im[c], M = cmag[c], P = cph[c];
      // each channel keeps its own loudness and its own phase difference to the sum (its place in the stereo picture)
      for (let k = 0; k < half; k++) { const a = synPh[k] + (P[k] - ph[k]); r[k] = M[k] * Math.cos(a); q[k] = M[k] * Math.sin(a); }
      for (let k = half; k < N; k++) { r[k] = r[N - k]; q[k] = -q[N - k]; }
      fft(r, q, true);
      const o = outs[c];
      for (let i = 0; i < N; i++) { const t = ts + i; if (t >= outLen) break; o[t] += r[i] / N * win[i]; }
    }
    for (let i = 0; i < N; i++) { const t = ts + i; if (t >= outLen) break; norm[t] += win[i] * win[i]; }
    if (report && m % 200 === 0) report(m / frames);
  }
  const want = Math.round(len * s);
  return outs.map((out) => { const y = new Float32Array(want); for (let i = 0; i < want; i++) { const o = i + pad; y[i] = norm[o] > 1e-3 ? out[o] / norm[o] : 0; } return y; });
}
// read x at a speed of `p` (p > 1: higher and shorter) with a windowed-sinc filter; when going higher the
// filter also removes the sounds that would fold back as harsh noise (anti-aliasing)
const TAPS = 16;
function resample(x, p) {
  if (Math.abs(p - 1) < 1e-6) return x;
  const n = Math.floor((x.length - 1) / p), y = new Float32Array(n), last = x.length - 1;
  const fc = Math.min(1, 1 / p) * 0.97, half = Math.ceil(TAPS / Math.min(1, fc));
  for (let i = 0; i < n; i++) {
    const t = i * p, k0 = Math.floor(t);
    let acc = 0, wsum = 0;
    for (let k = k0 - half + 1; k <= k0 + half; k++) {
      const d = t - k, ad = Math.abs(d) * fc;
      if (ad >= TAPS) continue;
      const sinc = ad < 1e-9 ? 1 : Math.sin(Math.PI * ad) / (Math.PI * ad);
      const w = 0.5 + 0.5 * Math.cos(Math.PI * ad / TAPS);
      const h = sinc * w;
      acc += h * (x[k < 0 ? 0 : k > last ? last : k]); wsum += h;
    }
    y[i] = wsum ? acc / wsum : 0;
  }
  return y;
}
self.onmessage = (e) => {
  const m = e.data;
  if (m.type !== 'run') return;
  try {
    const p = Math.pow(2, (Number(m.semis) || 0) / 12), tempo = Number(m.tempo) || 1;
    const s = p / tempo;
    const chans = m.chans;
    const st = stretch(chans, s, (f) => postMessage({ type: 'progress', p: f * 0.85 }));
    const out = st.map((x, c) => { const y = resample(x, p); postMessage({ type: 'progress', p: 0.85 + 0.15 * (c + 1) / st.length }); return y; });
    postMessage({ type: 'done', chans: out }, out.map((x) => x.buffer));
  } catch (err) { postMessage({ type: 'error', message: String((err && err.message) || err) }); }
};
