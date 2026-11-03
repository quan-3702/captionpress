const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FREE_MINUTES = 10;
const STORE_BILLING = 'https://store.microsoft.com/billing';
const PRO_SKU = 'captionpress_pro';
const PRO_IDS = [PRO_SKU];
let STORE_URL = 'https://apps.microsoft.com/detail/9P8M0CKNNJPM';
let proAvailable = false; // Pro limits apply only when the Store actually sells the add-on
proAvailable = true; // owner's rule: Pro is never free – free limits apply everywhere (website, Store, offline) until Pro is bought
let proSku = PRO_SKU;
let isPro = false;
const PRO_KEY = 'captionpress-pro', PRO_OK_KEY = 'captionpress-pro-ok', PRO_TRUST_DAYS = 30;
// The cached "owned" flag is only a convenience for offline Store users: never trusted on the website (nobody can buy
// there), and in the Store app only for 30 days after the Store last confirmed the purchase.
function cachedPro() {
  if (!('getDigitalGoodsService' in window)) return false;
  try {
    if (localStorage.getItem(PRO_KEY) !== '1') return false;
    const raw = localStorage.getItem(PRO_OK_KEY);
    if (raw == null) { localStorage.setItem(PRO_OK_KEY, String(Date.now())); return true; } // buyer from an older version: confirmed once
    const ok = Number(raw), now = Date.now();
    return /^\d+$/.test(raw) && ok <= now + 60000 && now - ok < PRO_TRUST_DAYS * 864e5;
  } catch (_) { return false; }
}
isPro = cachedPro();
const unlocked = () => isPro || !proAvailable;

async function billing() {
  if (!('getDigitalGoodsService' in window)) return null;
  try { return await window.getDigitalGoodsService(STORE_BILLING); } catch (_) { return null; }
}
// fromStore: the Store has just answered – remember (owned) or forget (not owned) the purchase.
function setPro(v, fromStore) {
  isPro = v;
  if (fromStore) {
    try {
      if (v) { localStorage.setItem(PRO_KEY, '1'); localStorage.setItem(PRO_OK_KEY, String(Date.now())); }
      else { localStorage.removeItem(PRO_KEY); localStorage.removeItem(PRO_OK_KEY); }
    } catch (_) {}
  }
  const b = $('proBtn');
  b.textContent = v ? '★ Pro' : '★ Get Pro';
  b.classList.toggle('is-pro', v);
  b.hidden = !proAvailable && !v;
  document.body.classList.toggle('unlocked', unlocked());
  if (typeof renderAll === 'function') renderAll();
}
async function checkProAfterBuy() {
  for (let i = 0; i < 6; i++) {
    if (await checkPro()) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  proMessage('Thank you! If Pro is not unlocked within a minute, click “Restore purchase”.');
  return false;
}
async function checkPro() {
  const svc = await billing();
  if (!svc) return false;
  try {
    const details = await svc.getDetails(PRO_IDS).catch(() => []);
    if (details[0]) { proSku = details[0].itemId; if (!PRO_IDS.includes(proSku)) PRO_IDS.push(proSku); }
    const list = await svc.listPurchases();
    const owned = list.some((p) => PRO_IDS.includes(p.itemId));
    if (owned || details.length) { setPro(owned, true); return owned; }
    setPro(isPro); // Store did not answer (offline): keep what we knew
    return isPro;
  } catch (_) { return isPro; }
}
function proMessage(text) { const m = $('proMsg'); m.hidden = !text; m.textContent = text || ''; }
async function openPro(reason) {
  proMessage(reason || '');
  const svc = await billing();
  if (!svc) {
    $('buyBtn').textContent = 'Get CaptionPress on Microsoft Store';
    $('restoreBtn').hidden = true;
  } else {
    $('restoreBtn').hidden = false;
    if (!isPro) checkPro().then((ok) => { if (ok) proMessage('Pro is unlocked. ★'); }); // a buyer whose 30 offline days ran out is unlocked again here
    try {
      const [d] = await svc.getDetails([proSku]);
      if (!d) proMessage((reason ? reason + ' ' : '') + 'Pro is being added to the Microsoft Store and will be on sale very soon – please check again in a day or two.');
      const price = d && d.price ? new Intl.NumberFormat(undefined, { style: 'currency', currency: d.price.currency }).format(Number(d.price.value)) : '';
      $('buyBtn').textContent = price ? `Unlock Pro – ${price}` : 'Unlock Pro';
    } catch (_) { $('buyBtn').textContent = 'Unlock Pro'; }
  }
  if (!$('proDialog').open) $('proDialog').showModal();
}
async function buyPro() {
  const svc = await billing();
  if (!svc) { window.open(STORE_URL, '_blank'); return; }
  const methods = [{ supportedMethods: STORE_BILLING, data: { sku: proSku } }];
  try {
    let req;
    try { req = new PaymentRequest(methods); }
    catch (_) { req = new PaymentRequest(methods, { total: { label: 'Total', amount: { currency: 'USD', value: '0' } } }); }
    const res = await req.show();
    await res.complete('success');
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    proMessage('Purchase could not be completed: ' + (e.message || e));
    return;
  }
  if (await checkProAfterBuy()) { proMessage('Thank you! Pro is unlocked. ★'); setTimeout(() => $('proDialog').close(), 1500); }
}
function needsPro(reason) {
  if (unlocked()) return false;
  openPro(reason);
  return true;
}

// ---------- CaptionPress core: pure functions (no DOM) ----------
const SR = 16000; // Whisper sample rate

// "_timestamped" exports can time every single word, which keeps subtitles in sync with the speech.
const MODELS = {
  fast: { id: 'onnx-community/whisper-tiny_timestamped', name: 'Fast', size: '≈ 80 MB', pro: false },
  accurate: { id: 'onnx-community/whisper-base_timestamped', name: 'Accurate', size: '≈ 150 MB', pro: true },
  best: { id: 'onnx-community/whisper-small_timestamped', name: 'Very accurate', size: '≈ 500 MB', pro: true },
  turbo: { id: 'onnx-community/whisper-large-v3-turbo_timestamped', name: 'Most accurate, all languages (needs a graphics card)', size: '≈ 750 MB', pro: true, gpu: true },
};

const LANGS = [
  ['', 'Detect automatically'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ru', 'Russian'], ['uk', 'Ukrainian'],
  ['pl', 'Polish'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['ja', 'Japanese'],
  ['ko', 'Korean'], ['zh', 'Chinese'], ['vi', 'Vietnamese'], ['id', 'Indonesian'], ['th', 'Thai'],
  ['ms', 'Malay'], ['tl', 'Filipino (Tagalog)'], ['sv', 'Swedish'], ['da', 'Danish'], ['no', 'Norwegian'],
  ['fi', 'Finnish'], ['cs', 'Czech'], ['ro', 'Romanian'], ['hu', 'Hungarian'], ['el', 'Greek'], ['he', 'Hebrew'],
];


// ---- AI voices (Piper, open-source). [id, label] grouped by language code used in LANGS ----
const VOICES = {
  en: [['en_US-lessac-medium', 'Lessac – US, female'], ['en_US-ryan-medium', 'Ryan – US, male'], ['en_US-amy-medium', 'Amy – US, female'], ['en_US-joe-medium', 'Joe – US, male'], ['en_US-kristin-medium', 'Kristin – US, female'], ['en_GB-alan-medium', 'Alan – British, male'], ['en_GB-jenny_dioco-medium', 'Jenny – British, female']],
  vi: [['vi_VN-vais1000-medium', 'Vais – Vietnamese, female'], ['vi_VN-25hours_single-low', '25hours – Vietnamese'], ['vi_VN-vivos-x_low', 'Vivos – Vietnamese']],
  es: [['es_ES-davefx-medium', 'Dave – Spain, male'], ['es_ES-sharvard-medium', 'Sharvard – Spain'], ['es_MX-claude-high', 'Claude – Mexico']],
  fr: [['fr_FR-siwis-medium', 'Siwis – female'], ['fr_FR-tom-medium', 'Tom – male'], ['fr_FR-upmc-medium', 'UPMC']],
  de: [['de_DE-thorsten-medium', 'Thorsten – male'], ['de_DE-kerstin-low', 'Kerstin – female'], ['de_DE-eva_k-x_low', 'Eva – female']],
  it: [['it_IT-riccardo-x_low', 'Riccardo – male']],
  pt: [['pt_BR-faber-medium', 'Faber – Brazil, male'], ['pt_PT-tugão-medium', 'Tugão – Portugal']],
  nl: [['nl_BE-nathalie-medium', 'Nathalie – female'], ['nl_NL-mls-medium', 'MLS – Netherlands']],
  ru: [['ru_RU-irina-medium', 'Irina – female'], ['ru_RU-dmitri-medium', 'Dmitri – male'], ['ru_RU-denis-medium', 'Denis – male']],
  uk: [['uk_UA-ukrainian_tts-medium', 'Ukrainian TTS']],
  pl: [['pl_PL-gosia-medium', 'Gosia – female'], ['pl_PL-darkman-medium', 'Darkman – male']],
  tr: [['tr_TR-fettah-medium', 'Fettah – male'], ['tr_TR-dfki-medium', 'DFKI']],
  ar: [['ar_JO-kareem-medium', 'Kareem – male']],
  zh: [['zh_CN-huayan-medium', 'Huayan – female']],
  sv: [['sv_SE-nst-medium', 'NST']], da: [['da_DK-talesyntese-medium', 'Talesyntese']], no: [['no_NO-talesyntese-medium', 'Talesyntese']],
  fi: [['fi_FI-harri-medium', 'Harri – male']], cs: [['cs_CZ-jirka-medium', 'Jirka – male']], ro: [['ro_RO-mihai-medium', 'Mihai – male']],
  hu: [['hu_HU-anna-medium', 'Anna – female']], el: [['el_GR-rapunzelina-low', 'Rapunzelina – female']],
};
const SAMPLE_LINE = {
  en: 'Hello! This is how your video will sound with this voice.', vi: 'Xin chào! Đây là giọng đọc cho video của bạn.',
  es: '¡Hola! Así sonará tu vídeo con esta voz.', fr: 'Bonjour ! Voici comment votre vidéo sonnera avec cette voix.',
  de: 'Hallo! So klingt dein Video mit dieser Stimme.', it: 'Ciao! Ecco come suonerà il tuo video con questa voce.',
  pt: 'Olá! É assim que o seu vídeo vai soar com esta voz.', ru: 'Привет! Так будет звучать ваше видео с этим голосом.',
};
const langOfVoice = (id) => String(id || '').slice(0, 2);
// Fit each spoken clip into its subtitle time: speed it up a little when it is too long for the gap.
function planVoice(cues, clips, total) {
  return cues.map((c, i) => {
    const clip = clips[i];
    if (!clip) return null;
    const next = cues[i + 1] ? cues[i + 1].start : total;
    const room = Math.max(0.3, next - c.start);
    const len = clip.length / clip.sampleRate;
    const rate = len > room ? Math.min(1.35, len / room) : 1;
    return { start: c.start, rate };
  });
}


// ---- translation (English subtitles -> another language, Opus-MT models, open-source) ----
const TR_LANGS = [
  ['vi', 'Vietnamese', 'Xenova/opus-mt-en-vi'], ['es', 'Spanish', 'Xenova/opus-mt-en-es'], ['fr', 'French', 'Xenova/opus-mt-en-fr'],
  ['de', 'German', 'Xenova/opus-mt-en-de'], ['it', 'Italian', 'Xenova/opus-mt-en-it'], ['zh', 'Chinese', 'Xenova/opus-mt-en-zh'],
  ['ja', 'Japanese', 'Xenova/opus-mt-en-jap'], ['ru', 'Russian', 'Xenova/opus-mt-en-ru'], ['uk', 'Ukrainian', 'Xenova/opus-mt-en-uk'],
  ['id', 'Indonesian', 'Xenova/opus-mt-en-id'], ['hi', 'Hindi', 'Xenova/opus-mt-en-hi'], ['ar', 'Arabic', 'Xenova/opus-mt-en-ar'],
  ['nl', 'Dutch', 'Xenova/opus-mt-en-nl'], ['sv', 'Swedish', 'Xenova/opus-mt-en-sv'], ['da', 'Danish', 'Xenova/opus-mt-en-da'],
  ['fi', 'Finnish', 'Xenova/opus-mt-en-fi'], ['cs', 'Czech', 'Xenova/opus-mt-en-cs'], ['ro', 'Romanian', 'Xenova/opus-mt-en-ro'],
  ['hu', 'Hungarian', 'Xenova/opus-mt-en-hu'],
];
// Join neighbouring lines into whole sentences so the translation has context. Returns [{from, to, text}]
function sentenceGroups(cues, maxLines) {
  maxLines = maxLines || 4;
  const groups = [];
  let cur = null;
  cues.forEach((c, i) => {
    const t = cleanText(c.text.replace(/\n/g, ' '));
    if (!cur) cur = { from: i, to: i, text: t };
    else { cur.to = i; cur.text += ' ' + t; }
    const ends = /[.!?…。！？]["')\]]?$/.test(t);
    const gap = cues[i + 1] ? cues[i + 1].start - c.end : 99;
    if (ends || gap > 1.2 || cur.to - cur.from + 1 >= maxLines || i === cues.length - 1) { groups.push(cur); cur = null; }
  });
  return groups;
}
// Split translated text over n lines in proportion to the original line lengths, cutting at spaces.
function distribute(text, weights) {
  const t = cleanText(text);
  const n = weights.length;
  if (n <= 1) return [t];
  const total = weights.reduce((a, b) => a + b, 0) || n;
  const out = [];
  let rest = t;
  let restW = total;
  for (let k = 0; k < n - 1; k++) {
    const target = Math.round(rest.length * (weights[k] / restW));
    let cut = -1, best = Infinity;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] !== ' ') continue;
      const d = Math.abs(i - target) - (/[,.;:!?]/.test(rest[i - 1]) ? 4 : 0);
      if (d < best) { best = d; cut = i; }
    }
    if (cut < 0) cut = Math.max(1, Math.min(rest.length - 1, target)); // no spaces (e.g. Chinese)
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
    restW -= weights[k];
  }
  out.push(rest);
  return out.map((x) => x || '…');
}

// ---- time ----
function fmtTime(sec, sep) {
  sep = sep || ',';
  if (!isFinite(sec) || sec < 0) sec = 0;
  let ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)}${sep}${p(ms, 3)}`;
}
// "1:02.3" style used in the editor
function fmtShort(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const t = Math.round(sec * 10) / 10;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = s.toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
function fmtClock(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
// accepts 01:02:03,456 · 1:02.3 · 62.5 · 62
function parseTime(str) {
  if (typeof str === 'number') return str;
  const s = String(str || '').trim().replace(',', '.');
  if (!s) return NaN;
  if (!/^[\d:.]+$/.test(s)) return NaN;
  const parts = s.split(':');
  if (parts.length > 3) return NaN;
  let total = 0;
  for (const p of parts) {
    if (p === '' || isNaN(Number(p))) return NaN;
    total = total * 60 + Number(p);
  }
  return total;
}

// ---- text ----
function cleanText(t) {
  return String(t || '').replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();
}
// Break into at most two balanced lines no longer than maxChars when possible.
function wrapText(text, maxChars) {
  maxChars = maxChars || 42;
  const t = cleanText(text);
  if (t.length <= maxChars) return t;
  const words = t.split(' ');
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const over = Math.max(0, a.length - maxChars) + Math.max(0, b.length - maxChars);
    const score = over * 100 + Math.abs(a.length - b.length);
    if (!best || score < best.score) best = { score, a, b };
  }
  return best ? best.a + '\n' + best.b : t;
}

// Split long text into balanced pieces of at most `limit` characters, preferring sentence ends, then commas, then spaces.
function splitText(text, limit) {
  const t = cleanText(text);
  if (t.length <= limit) return t ? [t] : [];
  const out = [];
  let rest = t;
  while (rest.length > limit) {
    const n = Math.ceil(rest.length / limit);
    const target = rest.length / n;
    const lo = Math.floor(target * 0.6), hi = Math.min(limit, rest.length - 1);
    let best = -1, bestScore = Infinity;
    for (let i = lo; i <= hi; i++) {
      const ch = rest[i - 1], next = rest[i];
      let rank;
      if (/[.!?…。！？]/.test(ch) && (next === ' ' || next === undefined || /[^\w]/.test(next))) rank = 0;
      else if (/[,;:，、]/.test(ch) && next === ' ') rank = 1;
      else if (next === ' ') rank = 2;
      else continue;
      const score = rank * limit * 0.25 + Math.abs(i - target);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) best = Math.round(target); // no spaces (e.g. Chinese/Japanese)
    out.push(rest.slice(0, best).trim());
    rest = rest.slice(best).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

// Whisper segments -> subtitle cues: split long segments (time shared by length), wrap into 2 lines.
function segmentsToCues(segs, maxChars) {
  maxChars = maxChars || 42;
  const cues = [];
  for (const s of segs) {
    const text = cleanText(s.text);
    if (!text) continue;
    const start = s.start, end = Math.max(s.end, s.start + 0.3);
    const parts = splitText(text, maxChars * 2);
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let t = start;
    parts.forEach((p, i) => {
      const d = (end - start) * (p.length / total);
      const e = i === parts.length - 1 ? end : t + d;
      cues.push({ start: round3(t), end: round3(e), text: wrapText(p, maxChars) });
      t = e;
    });
  }
  return tidy(cues);
}
const round3 = (x) => Math.round(x * 1000) / 1000;

// Whisper word timestamps (relative to the window) -> subtitle cues.
// A new line starts after a sentence, after a pause, or when the line gets too long or too slow to read.
function wordsToCues(chunks, offset, windowEnd, maxChars, samples) {
  maxChars = maxChars || 42;
  const limit = maxChars * 2;
  const words = recWords(chunks, offset, windowEnd, samples);
  return groupWords(words, maxChars, limit);
}
// Whisper word chunks (relative to the window) -> [{s, e, t}] in seconds, with starts moved onto the speech.
function recWords(chunks, offset, windowEnd, samples) {
  const words = [];
  let last = 0;
  for (const c of chunks || []) {
    const ts = c.timestamp || [];
    let s = ts[0], e = ts[1];
    if (s == null || !isFinite(s)) s = last;
    if (e == null || !isFinite(e) || e < s) e = s + 0.3;
    e = Math.min(e, windowEnd - offset);
    last = e;
    if (!String(c.text || '').trim()) continue;
    words.push({ s: offset + s, e: offset + Math.max(e, s), t: String(c.text) });
  }
  if (samples && samples.length) {
    // A word that starts in silence is moved to where the speech actually starts (before the next word).
    for (let i = 0; i < words.length; i++) {
      const w = words[i], nextS = i + 1 < words.length ? words[i + 1].s : w.e + 3;
      const lim = Math.min(nextS, w.s + 3);
      let peak = 0;
      for (let t = w.s; t < lim; t += 0.02) peak = Math.max(peak, rms(samples, t * SR, t * SR + SR / 50));
      const thr = Math.max(0.004, peak * 0.1);
      const loud = (t) => rms(samples, t * SR, t * SR + SR / 20) >= thr;
      if (loud(w.s)) continue;
      let t = w.s;
      while (t < lim && !loud(t)) t += 0.02;
      if (t >= lim) continue;
      const len = Math.max(0.15, w.e - w.s);
      w.s = Math.max(w.s, t - 0.05);
      if (w.e < w.s + 0.15) w.e = Math.min(w.s + len, i + 1 < words.length ? Math.max(w.s + 0.15, words[i + 1].s) : w.s + len);
    }
  }
  fixLongWords(words, samples);
  snapOnsets(words, samples);
  return words;
}
// ---- word timing for songs ----
const isPunctEnd = (t) => /[.!?…,;:。！？，、]["'”’)\]]?$/.test(String(t || '').trim());
// Whisper often gives the word before or after a pause or an instrumental break the whole break, so a line would
// stay on screen during the break, or the next line would start (and be highlighted) seconds too early.
// Where the sound shows where the voice is, the word is cut to it; otherwise the usual Whisper pattern is assumed:
// the first word after a pause starts too early, the last word before a pause ends too late.
function fixLongWords(words, samples) {
  if (!words.length) return words;
  const durs = words.map((w) => w.e - w.s).filter((d) => d > 0).sort((a, b) => a - b);
  const med = durs.length ? durs[durs.length >> 1] : 0.4;
  const maxD = Math.max(0.6, Math.min(0.7, med) * 2); // a normal long word
  const long = Math.max(1.2, maxD * 1.5);
  const step = 0.05;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.e - w.s <= long) continue;
    const prev = words[i - 1], next = words[i + 1];
    let fixed = false;
    if (samples && samples.length) {
      const lv = [];
      for (let t = w.s; t < w.e - 1e-6; t += step) lv.push(rms(samples, t * SR, (t + step) * SR));
      const sorted = lv.slice().sort((a, b) => a - b);
      const lo = sorted[Math.floor(sorted.length * 0.1)], hi = sorted[Math.max(0, sorted.length - 3)]; // the voice may be a short part
      if (hi > 0.004 && hi > lo * 1.6) {
        const thr = lo + (hi - lo) * 0.5;
        const loud = lv.map((v) => v >= thr);
        for (let k = 1; k < loud.length; k++) if (!loud[k]) { let j = k; while (j < loud.length && !loud[j]) j++; if (j < loud.length && j - k <= 3) for (let m = k; m < j; m++) loud[m] = true; k = j; }
        let ra = -1, rb = -1;
        for (let k = 0; k < loud.length; k++) if (loud[k]) { let j = k; while (j < loud.length && loud[j]) j++; if (j - k > rb - ra) { ra = k; rb = j; } k = j; }
        const quiet = (a, b) => { let sum = 0; for (let k = a; k < b; k++) sum += lv[k]; return b > a && sum / (b - a) <= lo + (hi - lo) * 0.25; };
        if (ra >= 0) {
          const s0 = w.s;
          if (ra * step >= 0.3 && quiet(0, ra)) { w.s = round3(s0 + ra * step - 0.03); fixed = true; }
          if ((lv.length - rb) * step >= 0.8 && quiet(rb, lv.length)) { w.e = round3(Math.min(w.e, s0 + rb * step + 0.15)); fixed = true; }
        }
      }
    }
    if (fixed) continue;
    const startSus = !prev || prev.e <= w.s - 0.25 || isPunctEnd(prev.t);
    const endSus = !next || next.s >= w.e + 0.25 || isPunctEnd(w.t);
    if (endSus && !startSus) w.e = w.s + Math.min(w.e - w.s, Math.max(maxD, 2.5)); // a held note is fine, a whole break is not
    else if (startSus || w.e - w.s > 4) w.s = w.e - maxD;
  }
  return words;
}
// Whisper's word starts tend to come a little before the voice (often still in the end of the word before).
// When the sound clearly dips and rises again (an onset) within 0.3 s after the start, the word starts there.
function snapOnsets(words, samples) {
  if (!samples || !samples.length) return words;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.e - w.s < 0.2) continue;
    let peak = 0;
    for (let t = w.s; t < w.e; t += 0.02) peak = Math.max(peak, rms(samples, t * SR, (t + 0.04) * SR));
    if (peak < 0.004) continue;
    const hi = Math.min(w.s + 0.3, w.e - 0.12);
    let best = -1, bestR = 2;
    for (let t = w.s - 0.03; t <= hi; t += 0.01) {
      const after = rms(samples, t * SR, (t + 0.06) * SR), before = rms(samples, (t - 0.06) * SR, t * SR);
      const r = after / (before + 0.002);
      if (after >= peak * 0.4 && r > bestR) { bestR = r; best = t; }
    }
    if (best > w.s + 0.015) w.s = round3(best);
  }
  return words;
}
// recognised words -> one time per matching token (the units scriptTokens makes)
function tokTimes(words) {
  const out = [];
  for (const w of words || []) {
    const tk = scriptTokens(cleanText(w.t)), n = tk.length;
    tk.forEach((_, k) => out.push({ s: w.s + (w.e - w.s) * k / n, e: w.s + (w.e - w.s) * (k + 1) / n }));
  }
  return out;
}
// Store the time of every word of a subtitle line (relative to its start) so animated captions follow the real
// singing. Returns null when the words and times do not match up.
function attachWt(cue, toks) {
  const ws = capWords(cue.text);
  if (!ws.length || !toks || !toks.length) return null;
  const dur = Math.max(0.05, cue.end - cue.start);
  const out = [];
  let k = 0, last = cue.start;
  for (const o of ws) {
    const n = scriptTokens(o.w).length;
    if (!n) { out.push([last, last]); continue; }
    if (k + n > toks.length) return null;
    const s = toks[k].s, e = toks[k + n - 1].e;
    k += n; out.push([s, e]); last = e;
  }
  if (k !== toks.length) return null;
  return out.map(([s, e]) => { const a = Math.min(dur, Math.max(0, s - cue.start)); return [round3(a), round3(Math.min(dur, Math.max(a, e - cue.start)))]; });
}
const validWt = (c) => !!c && Array.isArray(c.wt) && c.wt.length > 0 && c.wt.every((p) => Array.isArray(p) && p.length === 2 && isFinite(p[0]) && isFinite(p[1]) && p[0] >= 0 && p[1] >= p[0]);
function groupWords(words, maxChars, limit) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur) { const text = cleanText(cur.t); if (text) out.push({ start: cur.s, end: cur.e, text, w0e: cur.w0e, wLs: cur.wLs, words: cur.ws }); } cur = null; };
  for (const w of words) {
    if (cur) {
      const gap = w.s - cur.e;
      const curText = cleanText(cur.t);
      const tail = curText.slice(-2);
      const sentence = /[.!?…。！？]["'”’)\]]?$/.test(tail);
      const clause = /[,;:，、]$/.test(tail);
      const nextLen = cleanText(cur.t + w.t).length;
      if (gap > 0.5 || nextLen > limit || w.e - cur.s > 7 ||
          (sentence && (curText.length >= 12 || gap > 0.25)) ||
          (clause && curText.length >= maxChars * 1.3)) flush();
    }
    if (!cur) cur = { s: w.s, e: w.e, t: w.t.replace(/^\s+/, ''), w0e: w.e, wLs: w.s, ws: [w] };
    else { cur.t += w.t; cur.e = w.e; cur.wLs = w.s; cur.ws.push(w); }
  }
  flush();
  return out;
}

// ---- lyrics / script alignment ----
// The user already has the exact words (song lyrics, a script). Speech recognition is only used for the timing:
// the recognised words are matched to the user's words, and every line of the text becomes one subtitle.
const normWord = (w) => String(w || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const bareWord = (w) => normWord(w).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
function scriptLines(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && !/^\[.*\]$/.test(l)); // skip "[Chorus]"-style headings
}
// Split a text into units for matching: words, or single characters for languages written without spaces.
function scriptTokens(line) {
  const out = [];
  for (const piece of line.split(' ')) {
    if (/[぀-ヿ㐀-鿿가-힯฀-๿]/.test(piece) && normWord(piece).length > 1) {
      for (const ch of normWord(piece)) out.push(ch);
    } else if (normWord(piece)) out.push(normWord(piece));
  }
  return out;
}
// Banded global alignment of the user's tokens (a) to the recognised tokens (b). Returns, for every token of a,
// the index in b it matched (or -1).
function alignTokens(a, b) {
  const n = a.length, m = b.length;
  const map = new Int32Array(n).fill(-1);
  if (!n || !m) return map;
  const band = Math.max(60, Math.ceil(Math.abs(n - m) * 1.2) + 60);
  const W = 2 * band + 1;
  const ab = a.map(bareWord), bb = b.map(bareWord);
  const cost = (i, j) => (a[i] === b[j] ? 0 : ab[i] === bb[j] ? 0.3 : 1.2);
  const GAP = 0.9;
  const center = (i) => Math.round(i * m / n);
  const D = new Float32Array((n + 1) * W).fill(Infinity);
  const P = new Uint8Array((n + 1) * W); // 1 = diagonal, 2 = up (skip a word of a), 3 = left (skip a word of b)
  const at = (i, j) => { const k = j - center(i) + band; return k >= 0 && k < W ? i * W + k : -1; };
  for (let i = 0; i <= n; i++) {
    const c = center(i);
    for (let j = Math.max(0, c - band); j <= Math.min(m, c + band); j++) {
      const k = at(i, j);
      if (i === 0 && j === 0) { D[k] = 0; continue; }
      let best = Infinity, from = 0, x;
      if (i > 0 && j > 0 && (x = at(i - 1, j - 1)) >= 0 && D[x] + cost(i - 1, j - 1) < best) { best = D[x] + cost(i - 1, j - 1); from = 1; }
      if (i > 0 && (x = at(i - 1, j)) >= 0 && D[x] + GAP < best) { best = D[x] + GAP; from = 2; }
      if (j > 0 && (x = at(i, j - 1)) >= 0 && D[x] + GAP * (i === 0 || i === n ? 0.6 : 1) < best) { best = D[x] + GAP * (i === 0 || i === n ? 0.6 : 1); from = 3; }
      D[k] = best; P[k] = from;
    }
  }
  let i = n, j = m;
  if (at(n, m) < 0 || !isFinite(D[at(n, m)])) return map;
  while (i > 0 || j > 0) {
    const k = at(i, j);
    if (k < 0) break;
    const f = P[k];
    if (f === 1) { if (a[i - 1] && cost(i - 1, j - 1) < 1) map[i - 1] = j - 1; else map[i - 1] = -2 - (j - 1); i--; j--; }
    else if (f === 2) i--;
    else if (f === 3) j--;
    else break;
  }
  return map;
}
const LINE_BREAK = 3; // seconds of quiet inside a line that mean "this word does not belong here"
const MAX_HOLD = 3; // longest time the last word of a line is held
// words: recognised [{s, e, t}] in time order. Returns cues, one per line of the text (long lines split).
function alignScript(text, words, maxChars, maxSec) {
  maxChars = maxChars || 42;
  const lines = scriptLines(text);
  const toks = [], owner = [];
  lines.forEach((l, li) => scriptTokens(l).forEach((t) => { toks.push(t); owner.push(li); }));
  const recT = [], recW = [];
  for (const w of words || []) {
    const tk = scriptTokens(cleanText(w.t)), n = tk.length;
    tk.forEach((t, k) => { recT.push(t); recW.push({ s: w.s + (w.e - w.s) * k / n, e: w.s + (w.e - w.s) * (k + 1) / n }); });
  }
  const map = alignTokens(toks, recT);
  // time for each token: exact/near match -> that word; substitution -> that word (less sure); gaps -> interpolate
  const ts = new Array(toks.length).fill(null);
  for (let i = 0; i < toks.length; i++) {
    const v = map[i];
    if (v >= 0) ts[i] = { s: recW[v].s, e: recW[v].e, sure: true };
    else if (v <= -2) ts[i] = { s: recW[-2 - v].s, e: recW[-2 - v].e, sure: false };
  }
  // drop "unsure" times that go backwards
  let lastS = -Infinity;
  for (let i = 0; i < ts.length; i++) { if (ts[i]) { if (ts[i].s < lastS - 0.05) ts[i] = null; else lastS = ts[i].s; } }
  const byLine = lines.map(() => []);
  owner.forEach((o, k) => byLine[o].push(k));
  // A line is sung in one go: words of a line that are timed far away from the rest of it (a word heard in an
  // instrumental break matched to the first or last word of the line) are dropped and placed next to their line again.
  for (const idx of byLine) {
    const timed = idx.filter((k) => ts[k]);
    if (timed.length < 2) continue;
    const groups = [[timed[0]]];
    for (let j = 1; j < timed.length; j++) {
      if (ts[timed[j]].s - ts[timed[j - 1]].e > LINE_BREAK + 0.4 * (timed[j] - timed[j - 1] - 1)) groups.push([]);
      groups[groups.length - 1].push(timed[j]);
    }
    if (groups.length < 2) continue;
    const score = (g) => g.reduce((n, k) => n + (ts[k].sure ? 1 : 0.4), 0);
    const keep = groups.reduce((x, g) => (score(g) > score(x) ? g : x));
    for (const g of groups) if (g !== keep) for (const k of g) ts[k] = null;
  }
  const perWord = 0.35;
  const prevK = new Int32Array(ts.length), nextK = new Int32Array(ts.length);
  for (let i = 0, p = -1; i < ts.length; i++) { prevK[i] = p; if (ts[i]) p = i; }
  for (let i = ts.length - 1, q = -1; i >= 0; i--) { nextK[i] = q; if (ts[i]) q = i; }
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] && ts[i].s != null) continue;
    const prev = prevK[i] >= 0 ? prevK[i] : null, next = nextK[i] >= 0 ? nextK[i] : null;
    if (prev != null && next != null) {
      const span = ts[next].s - ts[prev].e, steps = next - prev;
      if (span > steps * perWord * 2 + 1.5) {
        // a pause or an instrumental break lies here: the words stay with their own line, never spread over the break
        const s = owner[i] === owner[prev] ? ts[prev].e + (i - prev - 1) * perWord : Math.max(ts[prev].e, ts[next].s - (next - i) * perWord);
        ts[i] = { s, e: Math.min(s + perWord, ts[next].s) };
      } else {
        const s = ts[prev].e + span * (i - prev - 0.5) / steps;
        ts[i] = { s, e: s + Math.min(perWord, span / steps) };
      }
    } else if (prev != null) { const s = ts[prev].e + (i - prev - 1) * perWord; ts[i] = { s, e: s + perWord }; }
    else if (next != null) { const s = Math.max(0, ts[next].s - (next - i) * perWord); ts[i] = { s, e: s + perWord }; }
    else { ts[i] = { s: i * perWord, e: i * perWord + perWord }; }
  }
  // the line ends shortly after its last word, not at the end of the following instrumental break
  for (const idx of byLine) { const t = idx.length && ts[idx[idx.length - 1]]; if (t && t.e - t.s > MAX_HOLD) t.e = t.s + MAX_HOLD; }
  const cues = [];
  lines.forEach((line, li) => {
    const idx = byLine[li];
    if (!idx.length) return;
    const start = ts[idx[0]].s, end = Math.max(ts[idx[idx.length - 1]].e, start + 0.4);
    const parts = splitText(line, maxChars * 2);
    const counts = parts.map((p) => capWords(p).reduce((n, o) => n + scriptTokens(o.w).length, 0));
    const exact = counts.reduce((x, y) => x + y, 0) === idx.length;
    const total = parts.reduce((x, p) => x + p.length, 0) || 1;
    let t = start, k = 0;
    parts.forEach((p, j) => {
      let cs = t, ce = j === parts.length - 1 ? end : t + (end - start) * p.length / total;
      let toks2 = null;
      if (exact && counts[j]) {
        toks2 = idx.slice(k, k + counts[j]).map((x) => ts[x]);
        cs = j ? toks2[0].s : start;
        ce = j === parts.length - 1 ? end : Math.max(cs + 0.4, toks2[toks2.length - 1].e);
      }
      k += counts[j];
      const c = { start: round3(cs), end: round3(ce), text: wrapText(p, maxChars) };
      const wt = toks2 && attachWt(c, toks2);
      if (wt) c.wt = wt;
      cues.push(c);
      t = ce;
    });
  });
  return tidy(cues.filter((c) => maxSec == null || c.start < maxSec));
}

// Move cue edges onto the real speech: Whisper sometimes starts the first word of a line during the
// silence before it (or ends the last word late). Uses the loudness of the audio around each edge.
function snapToSpeech(cues, samples) {
  if (!samples || !samples.length) return cues;
  const F = SR / 50; // 20 ms frames
  const frameRms = (t) => rms(samples, t * SR, t * SR + F);
  for (const c of cues) {
    let peak = 0;
    for (let t = c.start; t < c.end; t += 0.02) peak = Math.max(peak, frameRms(t));
    const thr = Math.max(0.004, peak * 0.1);
    const loud = (t) => rms(samples, t * SR, t * SR + SR / 10) >= thr; // 100 ms look-ahead
    if (!loud(c.start)) {
      const lim = Math.min((c.w0e != null ? c.w0e : c.end) - 0.05, c.start + 3);
      let t = c.start;
      while (t < lim && !loud(t)) t += 0.02;
      if (t < lim) c.start = Math.max(c.start, t - 0.08);
    }
    if (!loud(c.end - 0.1)) {
      const lim = Math.max((c.wLs != null ? c.wLs : c.start) + 0.15, c.start + 0.3);
      let t = c.end - 0.1;
      while (t > lim && !loud(t)) t -= 0.02;
      if (t > lim) c.end = Math.min(c.end, t + 0.1 + 0.25);
    }
    delete c.w0e; delete c.wLs;
  }
  return cues;
}

// Sort, remove empties, make sure every cue has a sensible length and none overlap.
function tidy(cues) {
  const list = cues
    .filter((c) => c && isFinite(c.start) && isFinite(c.end) && cleanText(c.text))
    .map((c) => { const o = { start: Math.max(0, c.start), end: Math.max(0, c.end), text: String(c.text).trim() }; if (c.spk != null && c.spk >= 0) o.spk = c.spk; if (c.star) o.star = true; if (validWt(c)) o.wt = c.wt.map((p) => [round3(p[0]), round3(p[1])]); return o; })
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c.end <= c.start) c.end = c.start + 1;
    const next = list[i + 1];
    if (next && c.end > next.start) c.end = Math.max(c.start + 0.2, next.start);
    c.start = round3(c.start); c.end = round3(c.end);
  }
  return list;
}

// Drop Whisper's typical "hallucinations" on silence / repeated loops.
const JUNK = /^(\[?(music|applause|silence|blank_audio|no speech|inaudible)\]?|\(.*\)|♪+|\.+|-+|thanks? (you )?for watching[.!]*|subscribe[.!]*)$/i;
function filterSegments(segs) {
  const out = [];
  for (const s of segs) {
    const t = cleanText(s.text);
    if (!t || JUNK.test(t.replace(/[\[\]]/g, (m) => m))) continue;
    const prev = out[out.length - 1];
    if (prev && cleanText(prev.text).toLowerCase() === t.toLowerCase() && s.start - prev.end < 1.5) { prev.end = s.end; continue; }
    out.push(Object.assign({}, s, { text: t }));
  }
  return out;
}

// Whisper output chunks (timestamps relative to the window) -> absolute segments
function chunksToSegments(chunks, offset, windowEnd) {
  const segs = [];
  for (const c of chunks || []) {
    const ts = c.timestamp || [];
    let s = ts[0], e = ts[1];
    if (s == null || !isFinite(s)) s = 0;
    if (e == null || !isFinite(e)) e = windowEnd - offset;
    segs.push({ start: offset + s, end: offset + Math.min(e, windowEnd - offset), text: c.text });
  }
  return segs;
}

// ---- audio windows ----
function rms(samples, from, to) {
  from = Math.max(0, from | 0); to = Math.min(samples.length, to | 0);
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return to > from ? Math.sqrt(sum / (to - from)) : 0;
}
// Quietest 100 ms frame between `from` and `to` (seconds); returns time in seconds.
function quietPoint(samples, from, to) {
  const frame = SR / 10;
  let best = to, bestV = Infinity;
  for (let t = from; t + 0.1 <= to; t += 0.1) {
    const v = rms(samples, t * SR, t * SR + frame);
    if (v < bestV) { bestV = v; best = t + 0.05; }
  }
  return best;
}
// Plan ≤ 30 s windows, cutting at a quiet moment so words are not split.
function planWindows(samples, maxSec) {
  const dur = samples.length / SR;
  const limit = Math.min(dur, maxSec || dur);
  const wins = [];
  let start = 0;
  while (start < limit - 0.05) {
    let end;
    if (limit - start <= 29.5) end = limit;
    else end = quietPoint(samples, start + 20, start + 29.5);
    wins.push({ start: round3(start), end: round3(end) });
    start = end;
  }
  return wins;
}
const isSilent = (samples, w) => rms(samples, w.start * SR, w.end * SR) < 0.0025;

// ---- subtitle files ----
// an empty line inside a cue would end it early in SRT/VTT files
const cueBody = (t) => String(t).split('\n').filter((l) => l.trim()).join('\n');
function toSRT(cues) {
  return cues.map((c, i) => `${i + 1}\n${fmtTime(c.start, ',')} --> ${fmtTime(c.end, ',')}\n${cueBody(c.text)}\n`).join('\n');
}
function toVTT(cues) {
  return 'WEBVTT\n\n' + cues.map((c) => `${fmtTime(c.start, '.')} --> ${fmtTime(c.end, '.')}\n${cueBody(c.text)}\n`).join('\n');
}
function toTXT(cues) {
  return cues.map((c) => c.text.replace(/\n/g, ' ')).join('\n') + '\n';
}
function toTXTStamped(cues) {
  return cues.map((c) => `[${fmtClock(c.start)}] ${c.text.replace(/\n/g, ' ')}`).join('\n') + '\n';
}
function parseSubs(text) {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = src.split(/\n{2,}/);
  const cues = [];
  const re = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
  for (const b of blocks) {
    const lines = b.split('\n');
    const k = lines.findIndex((l) => re.test(l));
    if (k < 0) continue;
    const m = lines[k].match(re);
    const txt = lines.slice(k + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (!txt) continue;
    cues.push({ start: parseTime(m[1]), end: parseTime(m[2]), text: txt });
  }
  return tidy(cues);
}

// ---- editing helpers ----
// ---------- word timing for animated captions ----------
// Whisper gives a time for each line. Inside a line every word gets a share of the time by its length,
// with a little extra after a comma or full stop. Edited text keeps working because nothing is stored.
const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;
// the words of a caption as they are drawn (CJK: one character each)
function capWords(text) {
  const out = [];
  String(text || '').split('\n').forEach((ln, li) => {
    const toks = ln.match(/[぀-ヿ㐀-鿿豈-﫿][、。，！？]?|[^\s぀-ヿ㐀-鿿豈-﫿]+/g) || [];
    let prevCjk = false;
    toks.forEach((w, k) => {
      const cjk = CJK.test(w);
      out.push({ w, line: li, sp: k > 0 && !(cjk && prevCjk) });
      prevCjk = cjk;
    });
  });
  return out;
}
// Lines made from the sound keep the real time of every word (cue.wt, relative to the line start).
// Otherwise every word gets a share of the line's time by its length.
function wordTimes(cue) {
  const out = capWords(cue && cue.text);
  if (!out.length) return out;
  if (validWt(cue) && cue.wt.length === out.length) {
    const end = Math.max(cue.start + 0.05, cue.end);
    out.forEach((o, i) => { o.s = Math.min(end, cue.start + cue.wt[i][0]); o.e = Math.min(end, Math.max(o.s, cue.start + cue.wt[i][1])); });
    return out;
  }
  const weight = (w) => {
    const letters = (w.match(/[\p{L}\p{N}]/gu) || []).length;
    return Math.max(1, letters) + 1.5 + (/[.,!?;:…、。，！？]$/.test(w) ? 2.5 : 0);
  };
  const dur = Math.max(0.05, cue.end - cue.start);
  const span = dur - Math.min(0.15, dur * 0.1);
  const ws = out.map((o) => weight(o.w)), tot = ws.reduce((a, b) => a + b, 0);
  let acc = 0;
  out.forEach((o, i) => { o.s = cue.start + span * acc / tot; acc += ws[i]; o.e = cue.start + span * acc / tot; });
  return out;
}
// how much of each word is sung at time t (0…1) – the karaoke colour moves smoothly across the word
function wordFill(words, t) {
  return words.map((o) => (t >= o.e ? (t >= o.s ? 1 : 0) : t <= o.s ? 0 : (t - o.s) / Math.max(0.01, o.e - o.s)));
}
// the word being spoken at time t (-1 before the first word)
function wordAt(words, t) {
  let k = -1;
  for (let i = 0; i < words.length; i++) if (words[i].s <= t) k = i; else break;
  return k;
}
// short groups of words for "pop-up words" captions: up to max words, a new group after punctuation
function popChunks(words, max) {
  max = max || 3;
  const out = []; let cur = [];
  words.forEach((o, i) => {
    cur.push(i);
    const letters = cur.reduce((n, j) => n + words[j].w.length, 0);
    if (cur.length >= max || /[.,!?;:…、。，！？]$/.test(o.w) || letters > 16) { out.push(cur); cur = []; }
  });
  if (cur.length) out.push(cur);
  return out;
}
const CAP_PRESETS = {
  classic: { name: 'Classic', size: 5, pos: 'bottom', color: '#ffffff', bg: 'box', chars: 42, anim: 'none', hl: '#ffd400', font: 'normal', upper: false, ol: '#000000' },
  tiktok: { name: 'TikTok bold', size: 7, pos: 'middle', color: '#ffffff', bg: 'shadow', chars: 32, anim: 'highlight', hl: '#ffd400', font: 'heavy', upper: true, ol: '#000000' },
  pop: { name: 'Pop-up words', size: 10, pos: 'middle', color: '#ffffff', bg: 'shadow', chars: 32, anim: 'pop', hl: '#3ee07a', font: 'heavy', upper: true, ol: '#000000' },
  karaoke: { name: 'Karaoke', size: 6, pos: 'bottom', color: '#ffffff', bg: 'shadow', chars: 42, anim: 'fill', hl: '#33c3ff', font: 'heavy', upper: false, ol: '#000000' },
  karaoke2: { name: 'Karaoke – 2 lines', size: 6.5, pos: 'bottom', color: '#ffffff', bg: 'shadow', chars: 42, anim: 'karaoke2', hl: '#1e6bff', font: 'heavy', upper: false, ol: '#0a1a4a', olHl: '#ffffff', leadIn: true },
  boxed: { name: 'Box highlight', size: 6, pos: 'bottom', color: '#ffffff', bg: 'box', chars: 32, anim: 'highlight', hl: '#ff5ca8', font: 'heavy', upper: false, ol: '#000000' },
};
const STYLE_DEFAULT = { size: 5, pos: 'bottom', color: '#ffffff', bg: 'box', chars: 42, anim: 'none', hl: '#ffd400', font: 'normal', upper: false,
  family: '', dx: 0, dy: 0, ol: '#000000', olHl: '#ffffff', leadIn: true, kOff: 0.1 };

// ---------- two-line karaoke (lyrics videos) ----------
// Lines take turns in an upper row (left) and a lower row (right). The next line is already shown in the free row
// so the singer can read ahead; a line goes away shortly after it is sung. After a break of `gap` seconds a new
// block starts in the upper row, with a lead-in countdown (4 dots) before its first word.
const KARAOKE = { gap: 3, lead: 3, ahead: 6, hold: 0.5, minLead: 0.8 };
function karaokePlan(list, o) {
  o = Object.assign({}, KARAOKE, o);
  const plan = list.map((c, i) => ({ row: 0, block: !i || c.start - list[i - 1].end >= o.gap, appear: c.start, remove: c.end, lead: null }));
  plan.forEach((p, i) => { if (!p.block) p.row = 1 - plan[i - 1].row; });
  plan.forEach((p, i) => {
    const c = list[i];
    let rm = c.end + o.hold;
    // the row is needed by the line after next
    if (list[i + 2] && !plan[i + 1].block && !plan[i + 2].block) rm = Math.min(rm, Math.max(c.end, list[i + 2].start - 0.25));
    if (list[i + 1] && plan[i + 1].block) rm = Math.min(rm, Math.max(c.end, list[i + 1].start - Math.min(o.lead, o.gap - o.hold)));
    p.remove = rm;
  });
  plan.forEach((p, i) => {
    const c = list[i];
    if (p.block) {
      const room = i ? c.start - plan[i - 1].remove : c.start;
      const lead = Math.max(0, Math.min(o.lead, room));
      p.appear = c.start - lead;
      if (o.leadIn && lead >= o.minLead) p.lead = { from: c.start - lead, to: c.start };
    } else {
      const free = plan[i - 1].block ? plan[i - 1].appear : plan[i - 2].remove;
      p.appear = Math.min(c.start, Math.max(free, c.start - o.ahead));
    }
  });
  return plan;
}
// lines on screen at time t: [{ i, row }]
function karaokeVisible(plan, t) {
  const out = [];
  plan.forEach((p, i) => { if (t >= p.appear && t < p.remove) out.push({ i, row: p.row }); });
  return out;
}
// lead-in countdown: how many of the 4 dots are still shown at time t
function leadDots(lead, t) {
  if (!lead || t < lead.from || t >= lead.to) return 0;
  return Math.max(1, Math.min(4, Math.ceil(4 * (lead.to - t) / (lead.to - lead.from))));
}

// ---------- project files (.cpproj) ----------
const PROJECT_VER = 1;
function makeProject(d) {
  return JSON.stringify({
    app: 'CaptionPress', kind: 'project', version: PROJECT_VER, saved: new Date().toISOString(),
    video: d.video || null,
    subtitles: (d.cues || []).map((c) => { const o = { start: c.start, end: c.end, text: c.text }; if (validWt(c)) o.wt = c.wt; if (c.spk != null && c.spk >= 0) o.spk = c.spk; if (c.star) o.star = true; return o; }),
    speakers: d.names || [], style: d.style || {}, lyrics: d.lyrics || '',
  }, null, 1);
}
// Returns { cues, names, style, lyrics, video } or throws a friendly error.
function readProject(text) {
  let p;
  try { p = JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch (_) { throw new Error('This file is not a CaptionPress project.'); }
  if (!p || typeof p !== 'object' || p.app !== 'CaptionPress' || !Array.isArray(p.subtitles)) throw new Error('This file is not a CaptionPress project.');
  if (Number(p.version) > PROJECT_VER) throw new Error('This project was saved by a newer CaptionPress. Please update the app.');
  const cues = tidy(p.subtitles.filter((c) => c && typeof c === 'object').map((c) => {
    const o = { start: Number(c.start), end: Number(c.end), text: String(c.text == null ? '' : c.text).slice(0, 2000) };
    if (Number.isInteger(c.spk) && c.spk >= 0 && c.spk < 50) o.spk = c.spk;
    if (c.star === true) o.star = true;
    if (validWt(c)) o.wt = c.wt;
    return o;
  }));
  const st = {};
  const src = p.style && typeof p.style === 'object' ? p.style : {};
  for (const [k, v] of Object.entries(STYLE_DEFAULT)) if (k in src && typeof src[k] === typeof v) st[k] = src[k];
  const v = p.video && typeof p.video === 'object' ? { name: String(p.video.name || '').slice(0, 300), duration: Number(p.video.duration) || 0, size: Number(p.video.size) || 0 } : null;
  return { cues, names: Array.isArray(p.speakers) ? p.speakers.slice(0, 50).map((x) => String(x).slice(0, 80)) : [], style: st, lyrics: typeof p.lyrics === 'string' ? p.lyrics.slice(0, 200000) : '', video: v };
}

// ---------- filler words and pauses ----------
// "um", "uh" and friends in the main languages; a word is removed only when it stands alone
const FILLERS = ['um', 'umm', 'uh', 'uhh', 'uhm', 'uhmm', 'er', 'erm', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mmm', 'eh', 'ehm', 'euh', 'heu', 'äh', 'ähm', 'öhm', 'ehh', 'ờ', 'ờm', 'ừm', 'ừ', 'ơ', 'à', 'ừa', 'em…'];
const fillerRe = new RegExp('(^|[\\s,(])(' + FILLERS.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?=[\\s,.!?…)]|$)[,.…]*', 'giu');
function removeFillers(cues) {
  let count = 0;
  const out = [];
  cues.forEach((c) => {
    let t = String(c.text || '');
    const before = t;
    t = t.replace(fillerRe, (m, lead) => { count++; return lead === ',' ? ',' : lead; });
    t = t.replace(/,(\s*),/g, ',$1'); // tidy doubled commas
    // "we, uh, need" → "we need": a comma that only fenced the filler goes too
    if (/\b(um|uh|er|erm|ah|hmm|eh|ờ|ừm|à)\b,/iu.test(before)) t = t.replace(/(\p{L}),\s+(\p{Ll})/gu, (m, a, b, off) => (before.includes(a + ', ' + b) ? m : a + ' ' + b));
    if (t === before) { out.push(c); return; }
    t = t.split('\n').map((ln) => ln.replace(/\s{2,}/g, ' ').replace(/^[\s,]+/, '').replace(/\s+([,.!?…])/g, '$1').replace(/,\s*([.!?…])/g, '$1').replace(/,+/g, ',').trim()).filter(Boolean).join('\n');
    if (t && before.trimStart()[0] && before.trimStart()[0] === before.trimStart()[0].toUpperCase()) t = t.charAt(0).toUpperCase() + t.slice(1);
    if (t.replace(/[\s,.!?…]/g, '')) out.push(Object.assign({}, c, { text: t }));
  });
  return { cues: out, count };
}
// Long pauses in the sound: quiet stretches of at least minGap seconds. A little quiet (pad) is kept on each side.
function findPauses(samples, opts) {
  opts = opts || {};
  const minGap = opts.minGap || 0.8, pad = opts.pad == null ? 0.2 : opts.pad, F = Math.round(SR * 0.02);
  const n = Math.floor(samples.length / F);
  if (!n) return [];
  const lv = new Float32Array(n);
  for (let i = 0; i < n; i++) lv[i] = rms(samples, i * F, i * F + F);
  const sorted = Array.from(lv).sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.1)], loud = sorted[Math.floor(n * 0.9)] || 0.01;
  const th = Math.max(0.003, floor * 2.5, Math.min(loud * 0.08, floor + (loud - floor) * 0.06));
  const out = [];
  let s = -1;
  for (let i = 0; i <= n; i++) {
    const quiet = i < n && lv[i] < th;
    if (quiet && s < 0) s = i;
    if (!quiet && s >= 0) {
      const a = s * 0.02, b = i * 0.02;
      if (b - a >= minGap) {
        const ca = a === 0 ? 0 : a + pad, cb = i === n ? b : b - pad; // keep the start/end of the file trimmed fully
        if (cb - ca > 0.15) out.push({ start: Math.round(ca * 1000) / 1000, end: Math.round(cb * 1000) / 1000 });
      }
      s = -1;
    }
  }
  return out;
}
// the parts of the file that stay
function keepParts(duration, cuts) {
  const out = []; let t = 0;
  cuts.forEach((c) => { if (c.start > t + 0.01) out.push({ start: t, end: c.start }); t = Math.max(t, c.end); });
  if (duration > t + 0.01) out.push({ start: t, end: duration });
  return out;
}
// subtitle times after the pauses are cut out
function retimeCues(cues, cuts) {
  const map = (t) => { let d = 0; for (const c of cuts) { if (t >= c.end) d += c.end - c.start; else if (t > c.start) { d += t - c.start; break; } else break; } return Math.round((t - d) * 1000) / 1000; };
  return cues.map((c) => {
    const o = Object.assign({}, c, { start: map(c.start), end: map(c.end) });
    if (cuts.some((x) => x.start < c.end && x.end > c.start)) delete o.wt; // a pause inside the line was cut: word times no longer fit
    return o;
  }).filter((c) => c.end - c.start >= 0.2);
}
function cueAt(cues, t) {
  let lo = 0, hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].end <= t) lo = mid + 1;
    else if (cues[mid].start > t) hi = mid - 1;
    else return mid;
  }
  return -1;
}
function splitCue(cues, i, pos) {
  const c = cues[i];
  const flat = c.text.replace(/\n/g, ' ');
  if (pos == null || pos <= 0 || pos >= flat.length) {
    const mid = flat.length / 2;
    let best = -1;
    for (let k = 0; k < flat.length; k++) if (flat[k] === ' ' && (best < 0 || Math.abs(k - mid) < Math.abs(best - mid))) best = k;
    pos = best > 0 ? best : Math.floor(flat.length / 2);
  }
  const a = flat.slice(0, pos).trim(), b = flat.slice(pos).trim();
  if (!a || !b) return cues;
  let t = c.start + (c.end - c.start) * (a.length / (a.length + b.length));
  const na = capWords(a).length, keepWt = validWt(c) && na + capWords(b).length === c.wt.length && capWords(c.text).length === c.wt.length;
  if (keepWt && c.wt[na][0] > 0.05 && c.start + c.wt[na][0] < c.end - 0.05) t = c.start + c.wt[na][0];
  const out = cues.slice();
  const x = { start: c.start, end: round3(t), text: wrapText(a) }, y = { start: round3(t), end: c.end, text: wrapText(b) };
  if (keepWt) { const d = y.start - c.start; x.wt = c.wt.slice(0, na); y.wt = c.wt.slice(na).map(([p, q]) => [round3(Math.max(0, p - d)), round3(Math.max(0, q - d))]); }
  if (c.spk != null) { x.spk = c.spk; y.spk = c.spk; }
  if (c.star) x.star = true;
  out.splice(i, 1, x, y);
  return out;
}
function mergeCue(cues, i) {
  if (i < 0 || i >= cues.length - 1) return cues;
  const a = cues[i], b = cues[i + 1];
  const out = cues.slice();
  const m = { start: a.start, end: b.end, text: wrapText(a.text.replace(/\n/g, ' ') + ' ' + b.text.replace(/\n/g, ' ')) };
  if (a.spk != null) m.spk = a.spk; else if (b.spk != null) m.spk = b.spk;
  if (a.star || b.star) m.star = true;
  if (validWt(a) && validWt(b)) { const d = b.start - a.start; m.wt = a.wt.concat(b.wt.map(([p, q]) => [round3(p + d), round3(q + d)])); }
  out.splice(i, 2, m);
  return out;
}
function shiftCues(cues, delta, fromIndex) {
  fromIndex = fromIndex || 0;
  return tidy(cues.map((c, i) => (i < fromIndex ? c : { ...c, start: Math.max(0, c.start + delta), end: Math.max(0.2, c.end + delta) })));
}
function replaceAll(cues, find, repl, matchCase) {
  if (!find) return { cues, count: 0 };
  const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi');
  let count = 0;
  const out = cues.map((c) => {
    const t = c.text.replace(re, () => { count++; return repl; });
    return t === c.text ? c : { ...c, text: t };
  });
  return { cues: out, count };
}
function rewrapAll(cues, maxChars) {
  return cues.map((c) => ({ ...c, text: wrapText(c.text.replace(/\n/g, ' '), maxChars) }));
}

// ---- Speakers (meeting notes) ----
// validated categorical order (light surface / dark surface)
const SPK_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const SPK_COLORS_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
// The piece of audio used to recognise the voice in each line (null when the line is too short).
function speakerPieces(cues, minLen, maxLen) {
  minLen = minLen || 0.5; maxLen = maxLen || 8;
  return cues.map((c) => {
    const d = c.end - c.start;
    if (!(d >= minLen)) return null;
    if (d <= maxLen) return { start: c.start, end: c.end };
    const mid = (c.start + c.end) / 2;
    return { start: mid - maxLen / 2, end: mid + maxLen / 2 };
  });
}
function unitVec(v) {
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / n;
  return o;
}
function dot(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }
// Average-linkage agglomerative clustering (nearest-neighbour chain). Returns merges [a, b, similarity].
function agglomerate(vecs, weights) {
  const n = vecs.length;
  const S = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { const s = dot(vecs[i], vecs[j]); S[i * n + j] = s; S[j * n + i] = s; }
  const size = weights ? weights.slice() : new Array(n).fill(1);
  const alive = new Uint8Array(n).fill(1);
  const merges = [];
  let left = n;
  const chain = [];
  while (left > 1) {
    if (!chain.length) { for (let i = 0; i < n; i++) if (alive[i]) { chain.push(i); break; } }
    const a = chain[chain.length - 1];
    const prev = chain.length > 1 ? chain[chain.length - 2] : -1;
    let best = -1, bs = -Infinity;
    for (let j = 0; j < n; j++) {
      if (j === a || !alive[j]) continue;
      const s = S[a * n + j];
      if (s > bs || (s === bs && j === prev)) { bs = s; best = j; }
    }
    if (best === prev) {
      chain.pop(); chain.pop();
      const x = Math.min(a, best), y = Math.max(a, best);
      merges.push([x, y, bs]);
      const wx = size[x], wy = size[y];
      for (let k = 0; k < n; k++) {
        if (!alive[k] || k === x || k === y) continue;
        const s = (wx * S[x * n + k] + wy * S[y * n + k]) / (wx + wy);
        S[x * n + k] = s; S[k * n + x] = s;
      }
      size[x] = wx + wy; alive[y] = 0; left--;
    } else chain.push(best);
  }
  return merges;
}
// Cut the merge tree: stop at `k` groups, or (k = 0) when groups are less alike than `threshold`.
function cutTree(n, merges, k, threshold) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const sorted = merges.slice().sort((a, b) => b[2] - a[2]);
  let groups = n;
  for (const [a, b, s] of sorted) {
    if (k ? groups <= k : s < threshold) break;
    const ra = find(a), rb = find(b);
    if (ra !== rb) { parent[rb] = ra; groups--; }
  }
  return Array.from({ length: n }, (_, i) => find(i));
}
// embs: one vector (or null) per line; durs: line lengths. opts: { k (0 = automatic), threshold }.
function diarize(embs, durs, opts) {
  opts = opts || {};
  const k = opts.k || 0, threshold = opts.threshold == null ? 0.42 : opts.threshold;
  const idx = [], vecs = [], w = [];
  embs.forEach((e, i) => { if (e) { idx.push(i); vecs.push(unitVec(e)); w.push(Math.max(0.5, durs[i] || 1)); } });
  const labels = new Array(embs.length).fill(-1);
  if (!idx.length) return labels.map(() => 0);
  let lab = idx.length === 1 ? [0] : cutTree(idx.length, agglomerate(vecs, w), Math.min(k, idx.length), threshold);
  // centroids
  const cent = (labs) => {
    const m = new Map();
    labs.forEach((l, j) => {
      if (!m.has(l)) m.set(l, { v: new Float32Array(vecs[0].length), d: 0 });
      const g = m.get(l); for (let t = 0; t < g.v.length; t++) g.v[t] += vecs[j][t] * w[j]; g.d += w[j];
    });
    for (const g of m.values()) g.v = unitVec(g.v);
    return m;
  };
  let groups = cent(lab);
  if (!k && groups.size > 1) {
    // fold tiny groups (a cough, a laugh, a noise) into the nearest real speaker
    const totalD = w.reduce((a, b) => a + b, 0);
    const minD = Math.max(4, totalD * 0.02);
    const big = [...groups.entries()].filter(([, g]) => g.d >= minD).map(([l]) => l);
    if (big.length) {
      // a small group with a clearly different voice is kept (someone who says little); a small group close to a big one is noise
      const keep = new Set(big);
      for (const [l, g] of groups) {
        if (keep.has(l) || g.d < 1.5) continue;
        const near = Math.max(...big.map((b) => dot(g.v, groups.get(b).v)));
        if (near < 0.3) keep.add(l);
      }
      const bigs = [...keep];
      lab = lab.map((l, j) => {
        if (keep.has(l)) return l;
        let best = bigs[0], bs = -Infinity;
        for (const b of bigs) { const s = dot(vecs[j], groups.get(b).v); if (s > bs) { bs = s; best = b; } }
        return best;
      });
      groups = cent(lab);
    }
  }
  // one pass of re-assignment to the closest centre (cleans up early merges)
  if (groups.size > 1) {
    lab = lab.map((l, j) => {
      let best = l, bs = dot(vecs[j], groups.get(l).v);
      for (const [g, c] of groups) { const s = dot(vecs[j], c.v); if (s > bs + 0.02) { bs = s; best = g; } }
      return best;
    });
  }
  idx.forEach((i, j) => (labels[i] = lab[j]));
  // short lines without a voice sample take the neighbour's speaker
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] >= 0) continue;
    let p = i - 1; while (p >= 0 && labels[p] < 0) p--;
    let q = i + 1; while (q < labels.length && labels[q] < 0) q++;
    labels[i] = p >= 0 ? labels[p] : q < labels.length ? labels[q] : 0;
  }
  // a very short line between two lines of the same person is that person too
  for (let i = 1; i < labels.length - 1; i++) {
    if ((durs[i] || 0) < 1 && labels[i - 1] === labels[i + 1] && labels[i] !== labels[i - 1]) labels[i] = labels[i - 1];
  }
  // number speakers in order of first appearance
  const order = new Map();
  return labels.map((l) => { if (!order.has(l)) order.set(l, order.size); return order.get(l); });
}
function spkName(names, i) { return (names && names[i]) || `Person ${i + 1}`; }
function speakerStats(cues, count) {
  const st = Array.from({ length: count }, () => ({ lines: 0, time: 0, first: -1 }));
  cues.forEach((c, i) => {
    if (c.spk == null || c.spk < 0 || c.spk >= count) return;
    const s = st[c.spk]; s.lines++; s.time += c.end - c.start; if (s.first < 0) s.first = i;
  });
  return st;
}
// Consecutive lines of the same person become one paragraph.
function speakerTurns(cues) {
  const out = [];
  for (const c of cues) {
    const text = c.text.replace(/\n/g, ' ').trim();
    const last = out[out.length - 1];
    if (last && !c.star && !last.star && last.spk === (c.spk == null ? -1 : c.spk) && c.start - last.end < 4) { last.text += ' ' + text; last.end = c.end; }
    else out.push({ spk: c.spk == null ? -1 : c.spk, start: c.start, end: c.end, text, star: !!c.star });
  }
  return out;
}
function toTXTSpeakers(cues, names) {
  return speakerTurns(cues).map((t) => `${t.star ? '★ ' : ''}[${fmtClock(t.start)}] ${t.spk >= 0 ? spkName(names, t.spk) + ': ' : ''}${t.text}`).join('\n\n') + '\n';
}
function toCSVSpeakers(cues, names) {
  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  return 'Start,End,Speaker,Text\r\n' + cues.map((c) => [fmtClock(c.start), fmtClock(c.end), q(c.spk != null && c.spk >= 0 ? spkName(names, c.spk) : ''), q(c.text.replace(/\n/g, ' '))].join(',')).join('\r\n') + '\r\n';
}

// ---- Remembered voices ----
// Weighted mean direction of several voice fingerprints.
function centroid(vecs, weights) {
  if (!vecs.length) return null;
  const v = new Float32Array(vecs[0].length);
  vecs.forEach((x, j) => { const u = unitVec(x), w = weights ? weights[j] : 1; for (let t = 0; t < v.length; t++) v[t] += u[t] * w; });
  return unitVec(v);
}
// Give each found speaker a remembered name when the voice clearly matches (each name used once).
function matchVoices(cents, bank, threshold) {
  threshold = threshold == null ? 0.6 : threshold;
  const pairs = [];
  cents.forEach((c, i) => { if (!c) return; for (const b of bank) pairs.push([i, b.name, dot(c, unitVec(b.v))]); });
  pairs.sort((a, b) => b[2] - a[2]);
  const out = new Array(cents.length).fill(null), used = new Set();
  for (const [i, name, s] of pairs) {
    if (s < threshold) break;
    if (out[i] || used.has(name)) continue;
    out[i] = { name, score: s }; used.add(name);
  }
  return out;
}
// Add a voice to the bank (merging with the same name).
function rememberVoice(bank, name, vec, weight) {
  const key = String(name).trim();
  if (!key || !vec) return bank;
  const list = bank.map((b) => ({ ...b }));
  const old = list.find((b) => b.name.toLowerCase() === key.toLowerCase());
  const w = weight || 1;
  if (old) {
    const a = unitVec(old.v), v = new Float32Array(a.length), n = old.n || 1;
    for (let t = 0; t < v.length; t++) v[t] = a[t] * n + vec[t] * w;
    old.v = Array.from(unitVec(v), (x) => Math.round(x * 1e4) / 1e4); old.n = n + w; old.name = key;
  } else list.push({ name: key, v: Array.from(unitVec(vec), (x) => Math.round(x * 1e4) / 1e4), n: w });
  return list;
}

// ---- Word (.docx) meeting minutes ----
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function utf8(s) { return new TextEncoder().encode(s); }
// Minimal ZIP writer (stored, no compression) – enough for .docx files.
function makeZip(files) {
  const parts = [], central = [];
  let off = 0;
  const u16 = (v) => [v & 255, (v >>> 8) & 255], u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  for (const [name, content] of files) {
    const nb = utf8(name), data = typeof content === 'string' ? utf8(content) : content, crc = crc32(data);
    const head = [...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nb.length), ...u16(0)];
    parts.push(new Uint8Array(head), nb, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), nb);
    off += head.length + nb.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(off), ...u16(0)]);
  const all = parts.concat(central, [end]);
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
function xmlEsc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); }
function wRun(text, o) {
  o = o || {};
  const pr = (o.b ? '<w:b/>' : '') + (o.color ? `<w:color w:val="${o.color.replace('#', '')}"/>` : '') + (o.sz ? `<w:sz w:val="${o.sz}"/>` : '');
  return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
}
function wPara(runs, style) { return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs}</w:p>`; }
// meta: { title, date, duration, file }
const MINUTES_TEXT = {
  en: { title: 'Meeting minutes', date: 'Date', file: 'Recording', len: 'Length', people: 'Participants', spoke: 'spoke for', actions: 'Decisions and action items', transcript: 'Transcript', moments: 'Key moments', charts: 'Who spoke how much', foot: 'Made with CaptionPress – transcribed on this computer.' },
  vi: { title: 'Biên bản cuộc họp', date: 'Ngày', file: 'File ghi âm', len: 'Thời lượng', people: 'Người tham gia', spoke: 'nói', actions: 'Kết luận và việc cần làm', transcript: 'Nội dung chi tiết', moments: 'Thời điểm quan trọng', charts: 'Thời gian phát biểu', foot: 'Tạo bằng CaptionPress – chép lời ngay trên máy tính này.' },
};
function minutesDocx(cues, names, meta) {
  meta = meta || {};
  const L = MINUTES_TEXT[meta.lang] || MINUTES_TEXT.en;
  const count = cues.reduce((m, c) => Math.max(m, c.spk == null ? -1 : c.spk), -1) + 1;
  const st = speakerStats(cues, count);
  const body = [];
  body.push(wPara(wRun(meta.title || L.title), 'Title'));
  const info = [[L.date, meta.date], [L.file, meta.file], [L.len, meta.duration]].filter((x) => x[1]);
  info.forEach(([k, v]) => body.push(wPara(wRun(k + ': ', { b: true }) + wRun(v))));
  if (count) {
    body.push(wPara(wRun(L.people), 'Heading1'));
    st.forEach((s, i) => { if (s.lines) body.push(wPara(wRun(spkName(names, i), { b: true, color: SPK_COLORS[i % SPK_COLORS.length] }) + wRun(` – ${L.spoke} ${fmtClock(s.time)}`), 'ListBullet')); });
  }
  const imgs = (meta.images || []).filter((im) => im && im.data && im.data.length);
  if (imgs.length) {
    body.push(wPara(wRun(L.charts), 'Heading1'));
    imgs.forEach((im, k) => {
      const cx = 6120000, cy = Math.round(cx * im.h / im.w);
      body.push(`<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${k + 1}" name="Chart ${k + 1}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${k + 1}" name="chart${k + 1}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg${k + 1}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
    });
  }
  const stars = speakerTurns(cues).filter((t) => t.star);
  if (stars.length) {
    body.push(wPara(wRun(L.moments), 'Heading1'));
    for (const t of stars) {
      const who = t.spk >= 0 ? wRun(spkName(names, t.spk) + ': ', { b: true, color: SPK_COLORS[t.spk % SPK_COLORS.length] }) : '';
      body.push(wPara(wRun(`★ [${fmtClock(t.start)}]  `, { color: '#b45309', b: true }) + who + wRun(t.text), 'ListBullet'));
    }
  }
  body.push(wPara(wRun(L.actions), 'Heading1'));
  for (let i = 0; i < 3; i++) body.push(wPara('', 'ListBullet'));
  body.push(wPara(wRun(L.transcript), 'Heading1'));
  for (const t of speakerTurns(cues)) {
    const who = t.spk >= 0 ? wRun(spkName(names, t.spk) + ': ', { b: true, color: SPK_COLORS[t.spk % SPK_COLORS.length] }) : '';
    body.push(wPara(wRun(`${t.star ? '★ ' : ''}[${fmtClock(t.start)}]  `, { color: t.star ? '#b45309' : '#6b7280', sz: 18, b: t.star }) + who + wRun(t.text)));
  }
  body.push(wPara(wRun(L.foot, { color: '#9ca3af', sz: 16 })));
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const NS = W + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:b/><w:color w:val="0F766E"/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="60"/></w:pPr></w:style>
</w:styles>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${imgs.map((_, k) => `<Relationship Id="rIdImg${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/chart${k + 1}.png"/>`).join('')}</Relationships>`;
  return makeZip([['[Content_Types].xml', types], ['_rels/.rels', rels], ['word/document.xml', doc], ['word/styles.xml', styles], ['word/numbering.xml', numbering], ['word/_rels/document.xml.rels', docRels]].concat(imgs.map((im, k) => [`word/media/chart${k + 1}.png`, im.data])));
}

// ---- Pro rules ----
function limitReason(opts, pro) {
  if (pro) return '';
  if (opts.model && MODELS[opts.model] && MODELS[opts.model].pro) return `The ${MODELS[opts.model].name} quality setting is part of CaptionPress Pro.`;
  if (opts.task === 'translate') return 'Translating speech into English subtitles is part of CaptionPress Pro.';
  if (opts.burn) return 'Saving a video with the captions burned in is part of CaptionPress Pro.';
  if (opts.translateTo) return 'Translating subtitles into another language is part of CaptionPress Pro.';
  if (opts.speakers) return 'Meeting notes – finding who is speaking, naming people and saving Word minutes – is part of CaptionPress Pro.';
  if (opts.cut) return 'Saving a shorter video with the pauses cut out is part of CaptionPress Pro.';
  if (opts.voice) return 'AI voice-over – reading your subtitles aloud and saving the video or audio – is part of CaptionPress Pro.';
  return '';
}

if (typeof module !== 'undefined') module.exports = {
  SR, MODELS, LANGS, wordsToCues, snapToSpeech, recWords, groupWords, alignScript, alignTokens, scriptLines, scriptTokens, normWord, fmtTime, fmtShort, fmtClock, parseTime, cleanText, wrapText, splitText, segmentsToCues, tidy,
  filterSegments, chunksToSegments, rms, quietPoint, planWindows, isSilent, toSRT, toVTT, toTXT, toTXTStamped,
  parseSubs, cueAt, removeFillers, findPauses, keepParts, retimeCues, wordTimes, wordAt, popChunks, CAP_PRESETS, STYLE_DEFAULT, capWords, wordFill,
  fixLongWords, snapOnsets, tokTimes, attachWt, validWt, karaokePlan, karaokeVisible, leadDots, KARAOKE, makeProject, readProject, VOICES, SAMPLE_LINE, TR_LANGS, sentenceGroups, distribute, langOfVoice, planVoice, splitCue, mergeCue, shiftCues, replaceAll, rewrapAll, limitReason,
  SPK_COLORS, SPK_COLORS_DARK, speakerPieces, unitVec, agglomerate, cutTree, diarize, spkName, speakerStats, speakerTurns, toTXTSpeakers, toCSVSpeakers, centroid, matchVoices, rememberVoice, crc32, makeZip, minutesDocx, MINUTES_TEXT,
};
// ---------- CaptionPress UI ----------
let file = null, fileUrl = '', cues = [], hist = [], fut = [], active = -1, busy = false;
let style = Object.assign({}, STYLE_DEFAULT);
let opts = { lang: '', model: 'fast', task: 'transcribe' };
try { Object.assign(style, JSON.parse(localStorage.getItem('cp-style') || '{}')); } catch (_) {}
// keep saved / opened settings inside what the controls allow
function cleanStyle(st) {
  for (const [k, v] of Object.entries(STYLE_DEFAULT)) if (typeof st[k] !== typeof v || (typeof v === 'number' && !isFinite(st[k]))) st[k] = v;
  const lim = { size: [3, 12], dx: [-45, 45], dy: [-90, 90], kOff: [-0.5, 0.5] };
  for (const [k, [a, b]] of Object.entries(lim)) st[k] = Math.max(a, Math.min(b, st[k]));
  if (![32, 42, 56].includes(st.chars)) st.chars = 42;
  if (!['none', 'highlight', 'fill', 'karaoke2', 'pop'].includes(st.anim)) st.anim = 'none';
  return st;
}
cleanStyle(style);
try { Object.assign(opts, JSON.parse(localStorage.getItem('cp-opts') || '{}')); } catch (_) {}
const video = $('video');

function toast(msg, ms) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), ms || 3200);
}
const storeKey = () => (file ? `cp:${file.name}:${file.size}` : '');
let saveTimer = 0;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const k = storeKey();
    if (!k) return;
    try { cues.length ? localStorage.setItem(k, JSON.stringify({ cues, names: spkNames, t: Date.now() })) : localStorage.removeItem(k); } catch (_) {}
  }, 400);
}

// ---------- history ----------
function snapshot() { return JSON.stringify(cues); }
function commit(next, prevSnap) {
  hist.push(prevSnap || snapshot());
  if (hist.length > 150) hist.shift();
  fut = [];
  cues = next;
  renderList(); renderCap(); autosave(); updateButtons();
}
function undo() { if (!hist.length) return; fut.push(snapshot()); cues = JSON.parse(hist.pop()); renderList(); renderCap(); autosave(); updateButtons(); }
function redo() { if (!fut.length) return; hist.push(snapshot()); cues = JSON.parse(fut.pop()); renderList(); renderCap(); autosave(); updateButtons(); }

function updateButtons() {
  $('undoBtn').disabled = !hist.length;
  $('redoBtn').disabled = !fut.length;
  $('exportBtn').disabled = !cues.length;
  $('addBtn').disabled = !file;
  $('fillerBtn').disabled = !cues.length;
  $('cueCount').textContent = cues.length ? `(${cues.length})` : '';
  $('emptyList').hidden = cues.length > 0;
  $('cues').hidden = !cues.length;
  $('genBtn').disabled = !file || busy;
}

// ---------- list ----------
function rowWarn(c) {
  const flat = c.text.replace(/\n/g, ' ');
  const d = c.end - c.start;
  if (c.text.split('\n').some((l) => l.length > style.chars + 4)) return 'Long line';
  if (c.text.split('\n').length > 2) return 'More than 2 lines';
  if (d > 0 && flat.length / d > 21) return 'Fast to read';
  return '';
}
function rowHtml(c, i) {
  const w = rowWarn(c);
  const sp = c.spk != null && c.spk >= 0 && spkOn.cached;
  return `<div class="cue${i === active ? ' on' : ''}${sp ? ' has-spk' : ''}${c.star ? ' starred' : ''}" data-i="${i}"${sp ? ` style="--spk:${spkColor(c.spk)}"` : ''}>
    <span class="num">${c.star ? '<b class="star-mark" title="Key moment">★</b>' : ''}${i + 1}</span>
    <div class="meta">
      <input class="t" data-k="start" value="${fmtShort(c.start)}" aria-label="Start time" title="Start time">
      <span class="muted">→</span>
      <input class="t" data-k="end" value="${fmtShort(c.end)}" aria-label="End time" title="End time">
      <span class="dur">${(c.end - c.start).toFixed(1)}s</span>
      ${w ? `<span class="warn" title="${w}">⚠</span>` : ''}
      <span class="acts">
        <button data-a="play" title="Play this line">▶</button>
        <button data-a="star" class="${c.star ? 'is-star' : ''}" title="${c.star ? 'Remove the key-moment mark' : 'Mark as a key moment (M)'}">★</button>
        <button data-a="setStart" title="Set start to the current video time">⇤</button>
        <button data-a="setEnd" title="Set end to the current video time">⇥</button>
        <button data-a="split" title="Split into two lines at the cursor">✂</button>
        <button data-a="merge" title="Join with the next line">⤓</button>
        <button data-a="del" title="Delete this line">✕</button>
      </span>
    </div>
    <div class="txt">${spkOn.cached ? spkSelectHtml(c) : ''}<textarea rows="${Math.max(1, c.text.split('\n').length)}" spellcheck="true" aria-label="Subtitle text ${i + 1}">${esc(c.text)}</textarea></div>
  </div>`;
}
function renderList() {
  const box = $('cues');
  const keep = box.scrollTop;
  spkOn.cached = spkOn();
  box.innerHTML = cues.map(rowHtml).join('');
  fitAreas(box);
  box.scrollTop = keep;
  renderSpeakers();
}
function fitArea(ta) { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 2) + 'px'; }
function fitAreas(box) { if (!box.offsetParent) return; box.querySelectorAll('textarea').forEach(fitArea); }
new ResizeObserver(() => fitAreas($('cues'))).observe($('cues'));
function rowOf(el) { const r = el.closest('.cue'); return r ? Number(r.dataset.i) : -1; }

let editSnap = null;
$('cues').addEventListener('focusin', (e) => {
  if (e.target.matches('textarea, .t')) editSnap = snapshot();
});
$('cues').addEventListener('input', (e) => {
  const i = rowOf(e.target);
  if (i < 0 || !e.target.matches('textarea')) return;
  cues[i].text = e.target.value;
  fitArea(e.target);
  renderCap(); autosave();
});
$('cues').addEventListener('change', (e) => {
  const i = rowOf(e.target);
  if (i < 0) return;
  if (e.target.matches('textarea')) {
    const prev = editSnap; editSnap = snapshot();
    if (!e.target.value.trim()) { const next = cues.slice(); next.splice(i, 1); commit(next, prev); return; }
    if (prev && prev !== snapshot()) { hist.push(prev); fut = []; updateButtons(); }
    const warn = rowWarn(cues[i]);
    const row = e.target.closest('.cue');
    const old = row.querySelector('.warn');
    if (old) old.remove();
    if (warn) row.querySelector('.dur').insertAdjacentHTML('afterend', `<span class="warn" title="${warn}">⚠</span>`);
    return;
  }
  if (e.target.matches('.t')) {
    const v = parseTime(e.target.value);
    if (!isFinite(v)) { e.target.classList.add('bad'); toast('Type a time like 1:23.4'); return; }
    const next = cues.map((c) => ({ ...c }));
    next[i][e.target.dataset.k] = v;
    if (next[i].end <= next[i].start) {
      if (e.target.dataset.k === 'start') next[i].end = v + Math.max(1, cues[i].end - cues[i].start);
      else { e.target.classList.add('bad'); toast('The end must be after the start.'); return; }
    }
    commit(tidy(next), editSnap);
  }
});
$('cues').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-a]');
  if (!b) return;
  const i = rowOf(b), c = cues[i];
  if (!c) return;
  const a = b.dataset.a;
  if (a === 'play') { video.currentTime = c.start + 0.001; video.play(); return; }
  if (a === 'star') { toggleStar(i); return; }
  if (a === 'setStart' || a === 'setEnd') {
    const t = video.currentTime;
    const next = cues.map((x) => ({ ...x }));
    if (a === 'setStart') { next[i].start = t; if (next[i].end <= t) next[i].end = t + 1.5; }
    else { if (t <= next[i].start) { toast('Move the video past the start of this line first.'); return; } next[i].end = t; }
    commit(tidy(next));
    return;
  }
  if (a === 'split') {
    const ta = b.closest('.cue').querySelector('textarea');
    const pos = document.activeElement === ta || splitCaret.i === i ? (splitCaret.i === i ? splitCaret.pos : ta.selectionStart) : null;
    commit(splitCue(cues, i, pos));
    return;
  }
  if (a === 'merge') { if (i >= cues.length - 1) { toast('This is the last line.'); return; } commit(mergeCue(cues, i)); return; }
  if (a === 'del') { const next = cues.slice(); next.splice(i, 1); commit(next); toast('Line deleted. Press Ctrl+Z to bring it back.'); }
});
// remember caret before the split button steals focus
const splitCaret = { i: -1, pos: null };
$('cues').addEventListener('mousedown', (e) => {
  if (!e.target.closest('button[data-a="split"]')) return;
  const row = e.target.closest('.cue');
  const ta = row.querySelector('textarea');
  splitCaret.i = document.activeElement === ta ? Number(row.dataset.i) : -1;
  splitCaret.pos = ta.selectionStart;
});
$('cues').addEventListener('dblclick', (e) => {
  if (e.target.matches('.num')) { const c = cues[rowOf(e.target)]; if (c) video.currentTime = c.start + 0.001; }
});

// ---------- caption overlay & active line ----------
// text size follows the picture height, but narrow (vertical) videos use their width so lines still fit
const capBase = (w, h) => Math.min(h, w * 0.6);
function capCss() {
  const cv = $('capCv');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(($('frame').clientWidth || 640) * dpr), h = Math.round(($('frame').clientHeight || 360) * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  drawCapNow();
}
let capBox = null;
function drawCapNow() {
  const cv = $('capCv'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  capBox = drawCaptions(ctx, video.currentTime || 0, cv.width, cv.height);
  if (previewMark()) drawWatermark(ctx, cv.width, cv.height, capBox);
}
function renderCap() {
  capCss();
  setActive(cueAt(cues, video.currentTime || 0));
}
function setActive(i) {
  if (i === active) return;
  const box = $('cues');
  const old = box.querySelector('.cue.on');
  if (old) old.classList.remove('on');
  active = i;
  const row = box.querySelector(`.cue[data-i="${i}"]`);
  if (!row) return;
  row.classList.add('on');
  if (!video.paused && !box.contains(document.activeElement)) {
    const r = row.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (r.top < b.top || r.bottom > b.bottom) box.scrollTop += r.top - b.top - b.height / 3;
  }
}
function tick() {
  renderCap();
  const d = video.duration || 0;
  $('clock').textContent = `${fmtClock(video.currentTime)} / ${fmtClock(d)}`;
  if (!seeking && d) $('seek').value = Math.round(video.currentTime / d * 1000);
  $('playBtn').textContent = video.paused ? '▶' : '⏸';
  if (!video.paused) requestAnimationFrame(tick);
}
let seeking = false;
video.addEventListener('play', tick);
video.addEventListener('pause', tick);
video.addEventListener('seeked', tick);
video.addEventListener('timeupdate', () => { if (video.paused) tick(); });
video.addEventListener('click', () => { if (Date.now() - capDragEnd < 400) return; video.paused ? video.play() : video.pause(); });
video.addEventListener('loadedmetadata', () => {
  const ar = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
  $('frame').style.aspectRatio = String(ar);
  frameAR = ar; fitFrame();
  // recordings made in the browser do not say how long they are – ask the browser to find out
  if (video.duration === Infinity) {
    const fix = () => { if (isFinite(video.duration)) { video.removeEventListener('durationchange', fix); video.currentTime = 0; updateGenUI(); tick(); if (typeof renderCharts === 'function') renderCharts(); } };
    video.addEventListener('durationchange', fix);
    video.currentTime = 1e7;
  }
  updateGenUI(); tick();
  checkProjectVideo();
});
$('seek').addEventListener('input', () => { seeking = true; if (video.duration) video.currentTime = $('seek').value / 1000 * video.duration; });
$('seek').addEventListener('change', () => { seeking = false; });
$('playBtn').onclick = () => (video.paused ? video.play() : video.pause());
$('back5').onclick = () => { video.currentTime = Math.max(0, video.currentTime - 5); };
$('fwd5').onclick = () => { video.currentTime = Math.min(video.duration || 0, video.currentTime + 5); };
let frameAR = 16 / 9;
function fitFrame() {
  const left = document.querySelector('.left');
  const boxes = [...$('player').querySelectorAll('.style-box')].reduce((n, b) => n + (b.offsetHeight || 44) + 12, 0);
  const avail = left.clientHeight - 32 - 54 - boxes - 12;
  const w = Math.max(200, Math.min(left.clientWidth - 32, Math.max(160, avail) * frameAR));
  $('frame').style.width = w + 'px';
  capCss();
}
new ResizeObserver(fitFrame).observe(document.querySelector('.left'));
$('player').querySelector('.style-box').addEventListener('toggle', fitFrame);

// ---------- open files ----------
function isMedia(f) { return /^(video|audio)\//.test(f.type) || /\.(mp4|m4v|mov|mkv|webm|avi|wmv|mp3|m4a|wav|ogg|oga|flac|aac|opus)$/i.test(f.name); }
function openFile(f) {
  if (!f) return;
  if (/\.(srt|vtt)$/i.test(f.name)) { importSubs(f); return; }
  if (/\.cpproj$/i.test(f.name)) { openProject(f); return; }
  if (!isMedia(f)) { toast('Please choose a video or audio file.'); return; }
  if (busy) cancelGen();
  const carry = !file && cues.length ? cues : null; // lines opened from a subtitle file before any video
  const fromProject = !!(carry && projWant), carryNames = spkNames;
  file = f;
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = URL.createObjectURL(f);
  video.src = fileUrl;
  $('fileName').textContent = f.name;
  $('drop').hidden = true; $('player').hidden = false; fitFrame();
  hist = []; fut = []; active = -1;
  cues = []; spkNames = []; lastAudio = null;
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey()) || 'null');
    if (fromProject) spkNames = carryNames;
    else if (saved && Array.isArray(saved.names)) spkNames = saved.names.map(String);
    if (!fromProject && saved && Array.isArray(saved.cues) && saved.cues.length) { cues = tidy(saved.cues); toast('Your subtitle lines for this file were restored from last time.'); }
  } catch (_) {}
  if (!cues.length && carry) { cues = carry; autosave(); }
  if (!fromProject) projWant = null;
  $('genHint').textContent = '';
  renderList(); renderCap(); updateButtons(); updateGenUI();
}
async function importSubs(f) {
  const text = await f.text();
  const list = parseSubs(text);
  if (!list.length) { toast('No subtitle lines were found in that file.'); return; }
  commit(list);
  toast(`${list.length} lines opened from ${f.name}.`);
}
$('openBtn').onclick = $('dropOpen').onclick = () => $('fileIn').click();
$('fileIn').onchange = (e) => { openFile(e.target.files[0]); e.target.value = ''; };
$('subIn').onchange = (e) => { if (e.target.files[0]) importSubs(e.target.files[0]); e.target.value = ''; };
$('projIn').onchange = (e) => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ''; };

// ---------- project files: lines with word times, caption look, lyrics, which video ----------
let projWant = null; // the video an opened project belongs to (checked when it is opened)
function saveProject() {
  closeMenus();
  const lyrics = $('lyricsIn').value;
  if (!cues.length && !lyrics.trim()) { toast('There is nothing to save yet – make or open subtitle lines first.'); return; }
  const d = video.duration;
  const vid = file ? { name: file.name, size: file.size, duration: isFinite(d) ? round3(d) : 0 } : projWant;
  download(baseName() + '.cpproj', makeProject({ cues, names: spkNames, style, lyrics, video: vid }), 'application/json;charset=utf-8');
  toast('Project saved to your Downloads folder. Open it again with ☰ More → Open project…', 5000);
}
async function openProject(f) {
  closeMenus();
  let p;
  try { p = readProject(await f.text()); } catch (e) { toast(e.message || 'This file is not a CaptionPress project.', 6000); return; }
  if (!p.cues.length && !p.lyrics.trim()) { toast('This project has no subtitle lines.'); return; }
  if (busy) cancelGen();
  // the same rules as opening an .srt file: these are the user's own lines; Pro features stay Pro
  const before = snapshot();
  // who-said-what (Meeting notes) is Pro: a free user gets the lines without the speaker names; the file is unchanged
  const hadSpk = p.cues.some((c) => c.spk != null);
  if (!unlocked() && hadSpk) { p.cues.forEach((c) => delete c.spk); p.names = []; }
  spkNames = p.names;
  style = cleanStyle(Object.assign({}, style, p.style));
  try { localStorage.setItem('cp-style', JSON.stringify(style)); } catch (_) {}
  initStyle();
  $('lyricsIn').value = p.lyrics; lyricsInfo();
  if (p.lyrics.trim()) $('lyricsBox').open = true;
  commit(p.cues, before);
  projWant = p.video && p.video.name ? p.video : null;
  const spkNote = !unlocked() && hadSpk ? ' Who said each line (Meeting notes) is part of Pro and was left out – the file itself is unchanged.' : '';
  if (file) { toast(`Project opened – ${p.cues.length} lines.${spkNote}`, spkNote ? 8000 : 3200); checkProjectVideo(); return; }
  if (projWant) {
    toast(`Project opened – ${p.cues.length} lines. Now open its video “${projWant.name}” with 📂 Open video.${spkNote}`, 9000);
    $('genHint').textContent = `Project opened. Open the video “${projWant.name}” to see the lines on it.`;
  } else toast(`Project opened – ${p.cues.length} lines. Open the video to see them on it.${spkNote}`, 6000);
}
// warn when the opened video is not the one the project was made for
function checkProjectVideo() {
  const want = projWant;
  if (!want || !file || !want.name) return;
  const d = video.duration;
  if (!isFinite(d) && file.name === want.name) return; // wait for the length
  projWant = null;
  const badName = want.name !== file.name, badLen = want.duration > 0 && isFinite(d) && Math.abs(d - want.duration) > 1;
  if (badName || badLen) toast(`⚠ This project was made for “${want.name}”${want.duration ? ` (${fmtClock(want.duration)})` : ''}, but the open video is “${file.name}”${isFinite(d) ? ` (${fmtClock(d)})` : ''}. The timing may not fit – open the right video, or check the lines.`, 10000);
}
$('projSaveBtn').onclick = saveProject;
$('projOpenBtn').onclick = () => { closeMenus(); $('projIn').click(); };
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || !e.relatedTarget) $('drop').classList.remove('over'); }));
document.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) openFile(f); });
if ('launchQueue' in window) window.launchQueue.setConsumer(async (p) => { if (p.files && p.files[0]) openFile(await p.files[0].getFile()); });

// ---------- generate ----------
let worker = null, jobs = {}, jobId = 0, dl = {}, cancelled = false, genBefore = null;
function getWorker() {
  if (worker) return worker;
  worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') { if (m.src === 'mt') trProgress(m.p); else if (m.src === 'spk') spkProgress(m.p); else onLoadProgress(m.p); return; }
    const j = jobs[m.id != null ? m.id : 'load'];
    if (!j) return;
    delete jobs[m.id != null ? m.id : 'load'];
    if (m.type === 'error') j.reject(new Error(m.message)); else j.resolve(m);
  };
  worker.onerror = (e) => { Object.values(jobs).forEach((j) => j.reject(new Error(e.message || 'The speech engine stopped.'))); jobs = {}; };
  return worker;
}
function call(msg, key, transfer) {
  return new Promise((resolve, reject) => { jobs[key] = { resolve, reject }; getWorker().postMessage(msg, transfer || []); });
}
function onLoadProgress(p) {
  if (!p || !p.file) return;
  if (p.status === 'progress' || p.status === 'done') {
    dl[p.file] = { loaded: p.loaded || (dl[p.file] && dl[p.file].total) || 0, total: p.total || (dl[p.file] && dl[p.file].total) || 0 };
    const all = Object.values(dl);
    const loaded = all.reduce((n, x) => n + (x.loaded || 0), 0), total = all.reduce((n, x) => n + (x.total || 0), 0);
    if (total > 2e6) setProg(loaded / total * 100, `Getting the AI ready (first time only) · ${(loaded / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB`);
  }
}
function setProg(pct, text) {
  $('prog').hidden = false;
  $('progBar').style.width = Math.max(0, Math.min(100, pct)) + '%';
  $('progText').textContent = text;
}
async function decodeAudio(f) {
  const buf = await f.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ sampleRate: SR });
  try {
    const ab = await ctx.decodeAudioData(buf);
    const n = ab.length, ch = ab.numberOfChannels;
    if (ch === 1) return ab.getChannelData(0);
    const out = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ch; }
    return out;
  } finally { ctx.close(); }
}
async function generate() {
  if (!file || busy) return;
  const why = limitReason({ model: opts.model, task: opts.task }, unlocked());
  if (why) { openPro(why); return; }
  busy = true; cancelled = false; dl = {};
  $('genBtn').disabled = true; $('genBtn').textContent = '⏳ Working…';
  const before = snapshot(); genBefore = before;
  const t0 = performance.now();
  try {
    setProg(2, 'Reading the sound from your file…');
    let samples;
    try { samples = await decodeAudio(file); lastAudio = { f: file, s: samples }; }
    catch (_) { throw new Error('CaptionPress could not read the sound in this file. Try an MP4, MOV, WEBM, MP3, M4A or WAV file.'); }
    if (cancelled) return;
    const total = samples.length / SR;
    const maxSec = unlocked() ? total : Math.min(total, FREE_MINUTES * 60);
    const windows = planWindows(samples, maxSec);
    setProg(4, 'Getting the AI ready…');
    const ready = await call({ type: 'load', model: MODELS[opts.model].id, big: !!MODELS[opts.model].gpu }, 'load');
    if (cancelled) return;
    let found = [];
    const script = ($('lyricsIn').value || '').trim();
    const heard = []; // recognised words with times, used when the user gave the exact words
    const startList = cues.length && !script ? cues : [];
    let done = 0;
    const tStart = performance.now();
    for (const w of windows) {
      if (cancelled) return;
      if (!isSilent(samples, w)) {
        const slice = samples.slice(Math.round(w.start * SR), Math.round(w.end * SR));
        const id = ++jobId;
        const res = await call({ type: 'run', id, audio: slice, language: opts.lang, task: opts.task, words: true }, id, [slice.buffer]);
        if (cancelled) return;
        let made;
        if (script) {
          if (res.words) heard.push(...recWords(res.chunks, w.start, w.end, samples));
          else for (const sg of filterSegments(chunksToSegments(res.chunks, w.start, w.end))) {
            const ws = cleanText(sg.text).split(' '), d = (sg.end - sg.start) / Math.max(1, ws.length);
            ws.forEach((t, k) => heard.push({ s: sg.start + k * d, e: sg.start + (k + 1) * d, t: ' ' + t }));
          }
        }
        if (res.words) {
          const lines = snapToSpeech(filterSegments(wordsToCues(res.chunks, w.start, w.end, style.chars, samples)), samples);
          made = lines.map((c) => {
            const o = { start: c.start, end: c.end, text: wrapText(c.text, style.chars) };
            const wt = attachWt(o, tokTimes(c.words));
            if (wt) o.wt = wt;
            return o;
          });
        } else {
          made = segmentsToCues(filterSegments(chunksToSegments(res.chunks, w.start, w.end)), style.chars);
        }
        found = tidy(found.concat(made));
        cues = startList.length ? tidy(startList.filter((c) => c.end <= windows[0].start || c.start >= maxSec).concat(found)) : found;
        renderList(); renderCap(); updateButtons();
      }
      done = w.end;
      const spent = (performance.now() - tStart) / 1000;
      const left = done > 0 ? spent / done * (maxSec - done) : 0;
      setProg(5 + 95 * done / maxSec, `Listening… ${fmtClock(done)} of ${fmtClock(maxSec)}${left > 20 ? ` · about ${Math.ceil(left / 60)} min left` : ''}${ready.device === 'wasm' ? ' (slower mode – no graphics acceleration)' : ''}`);
    }
    if (script) {
      cues = alignScript(script, heard, style.chars, maxSec < total ? maxSec : null);
      renderList(); renderCap();
    }
    hist.push(before); fut = []; genBefore = null;
    autosave(); updateButtons();
    const secs = Math.round((performance.now() - t0) / 1000);
    setProg(100, script ? `Done – ${cues.length} lines from your text, timed in ${fmtClock(secs)}. Play it once to check the timing, then save.` : `Done – ${cues.length} lines in ${fmtClock(secs)}. Check the words, then save.`);
    if (maxSec < total) {
      $('genHint').innerHTML = `The free version made subtitles for the first ${FREE_MINUTES} minutes. <a href="#" id="genPro">Get Pro</a> for the whole video.`;
      const a = $('genPro'); if (a) a.onclick = (e) => { e.preventDefault(); openPro(`This video is ${fmtClock(total)} long. Pro makes subtitles for the whole video.`); };
    }
  } catch (err) {
    if (!cancelled) { setProg(0, ''); $('prog').hidden = true; toast(err.message || String(err), 7000); }
  } finally {
    busy = false;
    $('genBtn').textContent = '✨ Create subtitles';
    updateButtons();
  }
}
function cancelGen() {
  if (!busy) { $('prog').hidden = true; return; }
  cancelled = true;
  if (worker) { worker.terminate(); worker = null; }
  Object.values(jobs).forEach((j) => j.reject(new Error('stopped'))); jobs = {};
  busy = false;
  if (genBefore && genBefore !== snapshot()) { hist.push(genBefore); fut = []; }
  genBefore = null;
  $('genBtn').textContent = '✨ Create subtitles';
  setProg(0, 'Stopped. The lines made so far are kept.');
  if (cues.length) autosave();
  updateButtons();
}
$('genBtn').onclick = generate;
$('cancelBtn').onclick = cancelGen;
// lyrics / script
function lyricsInfo() {
  const n = scriptLines($('lyricsIn').value).length;
  $('lyricsInfo').textContent = n ? `${n} line${n === 1 ? '' : 's'} – each becomes one subtitle with your exact words.` : '';
  $('lyricsBox').classList.toggle('has', n > 0);
}
$('lyricsIn').addEventListener('input', lyricsInfo);
$('lyricsOpen').onclick = () => {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.txt,.lrc,.srt,.vtt,text/plain';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    let t = await f.text();
    if (/-->/.test(t)) t = parseSubs(t).map((c) => c.text.replace(/\n/g, ' ')).join('\n'); // SRT/VTT: keep only the words
    t = t.replace(/^\s*\[(\d+:)?\d+[:.]\d+(\.\d+)?\]\s*/gm, ''); // LRC time tags
    $('lyricsIn').value = t.trim(); $('lyricsBox').open = true; lyricsInfo();
  };
  inp.click();
};
$('lyricsClear').onclick = () => { $('lyricsIn').value = ''; lyricsInfo(); };

function updateGenUI() {
  const pro = unlocked();
  $('model').innerHTML = Object.entries(MODELS).map(([k, m]) =>
    `<option value="${k}">${m.name} – downloads ${m.size} once${m.pro && !pro ? ' – PRO' : ''}</option>`).join('');
  $('model').value = opts.model;
  $('task').options[1].textContent = 'English (translate)' + (pro ? '' : ' – PRO');
  $('task').value = opts.task;
  $('lang').value = opts.lang;
  const d = video.duration;
  let hint = `The AI is downloaded once and then works offline. Your video stays on this computer.`;
  if (file && d && d > FREE_MINUTES * 60 && !pro) hint = `Free version: subtitles for the first ${FREE_MINUTES} minutes of each video (this one is ${fmtClock(d)}). ` + hint;
  if (opts.lang !== 'en' && (opts.model === 'fast' || opts.model === 'accurate')) hint = `Tip: ${MODELS[opts.model].name} quality is made for English. For ${opts.lang ? (LANGS.find((l) => l[0] === opts.lang) || ['', 'other languages'])[1] : 'other languages'}, choose “${MODELS.turbo.name.split(' (')[0]}” or “${MODELS.best.name}” – far fewer mistakes. ` + hint;
  if (!busy && (pro || !$('genHint').querySelector('a'))) $('genHint').textContent = hint;
  updateButtons();
}
function renderAll() { updateGenUI(); if (typeof initStyle === 'function' && $('stProNote')) { initStyle(); renderCap(); } }
$('lang').innerHTML = LANGS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
['lang', 'model', 'task'].forEach((id) => $(id).addEventListener('change', (e) => {
  const key = id === 'lang' ? 'lang' : id;
  opts[key] = e.target.value;
  const why = limitReason({ model: opts.model, task: opts.task }, unlocked());
  if (why) { openPro(why); if (id === 'model') opts.model = 'fast'; if (id === 'task') opts.task = 'transcribe'; }
  updateGenUI();
  try { localStorage.setItem('cp-opts', JSON.stringify(opts)); } catch (_) {}
}));

// ---------- style ----------
const ST_IDS = { stSize: 'size', stPos: 'pos', stColor: 'color', stBg: 'bg', stChars: 'chars', stAnim: 'anim', stHl: 'hl', stFont: 'font', stOl: 'ol', stOlHl: 'olHl', stDx: 'dx', stDy: 'dy', stKOff: 'kOff' };
const ST_NUM = ['size', 'chars', 'dx', 'dy', 'kOff'];
function initStyle() {
  for (const [id, k] of Object.entries(ST_IDS)) $(id).value = String(style[k]);
  $('stUpper').checked = !!style.upper;
  $('stLead').checked = style.leadIn !== false;
  const k2 = style.anim === 'karaoke2';
  $('stHlRow').hidden = style.anim === 'none';
  $('stHlLbl').textContent = k2 ? 'Sung colour' : 'Highlight colour';
  $('stColorLbl').textContent = k2 ? 'Unsung colour' : 'Text colour';
  $('stOlRow').hidden = style.bg !== 'shadow';
  $('stOlHlRow').hidden = !k2 || style.bg !== 'shadow';
  $('stLeadRow').hidden = !k2;
  $('stKOffRow').hidden = style.anim === 'none';
  const ko = kOffset();
  $('stKOffVal').textContent = (ko > 0 ? '+' : '') + ko.toFixed(2) + ' s' + (Math.abs(ko - STYLE_DEFAULT.kOff) < 0.001 ? ' (default)' : ko > 0 ? ' later' : ko < 0 ? ' earlier' : '');
  $('stFamily').textContent = safeFamily(style.family) || 'Segoe UI (default)';
  $('stFamily').style.fontFamily = safeFamily(style.family) ? `"${safeFamily(style.family)}", "Segoe UI", sans-serif` : '';
  $('stProNote').hidden = !previewMark();
  document.querySelectorAll('#presets button').forEach((b) => {
    const p = CAP_PRESETS[b.dataset.p];
    b.classList.toggle('on', Object.keys(p).every((k) => k === 'name' || k === 'size' || k === 'chars' || style[k] === p[k]));
  });
}
function setStyle(next) {
  const oldChars = style.chars;
  style = Object.assign({}, style, next);
  try { localStorage.setItem('cp-style', JSON.stringify(style)); } catch (_) {}
  if (style.chars !== oldChars && cues.length) { commit(rewrapAll(cues, style.chars)); toast('Lines re-wrapped. Ctrl+Z to undo.'); }
  initStyle();
  renderCap();
}
[...Object.keys(ST_IDS), 'stUpper', 'stLead'].forEach((id) => $(id).addEventListener('input', () => {
  const next = { upper: $('stUpper').checked, leadIn: $('stLead').checked };
  for (const [i, k] of Object.entries(ST_IDS)) next[k] = ST_NUM.includes(k) ? Number($(i).value) : $(i).value;
  setStyle(next);
}));
$('stCentre').onclick = () => setStyle({ dx: 0, dy: 0 });
// drag the caption on the preview to move it
let capDrag = null, capDragEnd = 0;
function capPoint(e) { const cv = $('capCv'), r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * cv.width / (r.width || 1), y: (e.clientY - r.top) * cv.height / (r.height || 1) }; }
const onCap = (p) => !!capBox && p.x >= capBox.x - 12 && p.x <= capBox.x + capBox.w + 12 && p.y >= capBox.y - 12 && p.y <= capBox.y + capBox.h + 12;
$('frame').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !onCap(capPoint(e))) return;
  capDrag = { x: e.clientX, y: e.clientY, dx: Number(style.dx) || 0, dy: Number(style.dy) || 0, moved: false, id: e.pointerId };
});
$('frame').addEventListener('pointermove', (e) => {
  if (!capDrag) { $('frame').classList.toggle('cap-hover', onCap(capPoint(e))); return; }
  const r = $('frame').getBoundingClientRect(), mx = e.clientX - capDrag.x, my = e.clientY - capDrag.y;
  if (!capDrag.moved && Math.abs(mx) + Math.abs(my) < 4) return;
  if (!capDrag.moved) { capDrag.moved = true; try { $('frame').setPointerCapture(capDrag.id); } catch (_) {} }
  style.dx = Math.max(-45, Math.min(45, Math.round(capDrag.dx + mx / r.width * 100)));
  style.dy = Math.max(-90, Math.min(90, Math.round(capDrag.dy - my / r.height * 100)));
  $('stDx').value = style.dx; $('stDy').value = style.dy;
  drawCapNow();
});
const endCapDrag = () => { if (!capDrag) return; if (capDrag.moved) { capDragEnd = Date.now(); setStyle({ dx: style.dx, dy: style.dy }); } capDrag = null; };
$('frame').addEventListener('pointerup', endCapDrag);
$('frame').addEventListener('pointercancel', endCapDrag);
$('presets').innerHTML = Object.entries(CAP_PRESETS).map(([k, p]) => `<button type="button" class="preset" data-p="${k}">${esc(p.name)}</button>`).join('');
$('presets').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-p]'); if (!b) return;
  const p = Object.assign({}, CAP_PRESETS[b.dataset.p]); delete p.name;
  setStyle(p);
  if (video.paused && cues.length && cueAt(cues, video.currentTime || 0) < 0) video.currentTime = cues[0].start + 0.01;
});

// ---------- fonts on this PC ----------
const COMMON_FONTS = ['Segoe UI', 'Segoe UI Black', 'Segoe UI Semibold', 'Segoe UI Light', 'Segoe Print', 'Segoe Script', 'Arial', 'Arial Black', 'Arial Narrow', 'Bahnschrift',
  'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Franklin Gothic Medium', 'Gabriola', 'Georgia', 'Impact', 'Ink Free',
  'Lucida Sans Unicode', 'Microsoft Sans Serif', 'Palatino Linotype', 'Sitka Text', 'Sylfaen', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
  'Roboto', 'Open Sans', 'Montserrat', 'Noto Sans', 'Be Vietnam Pro', 'DejaVu Sans', 'Liberation Sans'];
let pcFonts = null, commonFound = null;
const fontCtx = document.createElement('canvas').getContext('2d');
const fontW = (font, text) => { fontCtx.font = font; return fontCtx.measureText(text).width; };
// a font is installed when text drawn with it is not the same width as with the fallback fonts
function fontInstalled(name) {
  const f = safeFamily(name), test = 'mmmmmmmmmmlliWW@#&0123 Ẫệỹ';
  return !!f && ['monospace', 'serif', 'sans-serif'].some((b) => fontW(`40px "${f}", ${b}`, test) !== fontW(`40px ${b}`, test));
}
function fontHasVietnamese(name) {
  const f = safeFamily(name), test = 'ẫệỹờựđ';
  return ['monospace', 'serif'].some((b) => fontW(`40px "${f}", ${b}`, test) !== fontW(`40px ${b}`, test));
}
const fontMsg = (t) => { $('fontMsg').textContent = t || ''; };
function renderFonts() {
  const q = $('fontSearch').value.trim().toLowerCase();
  if (!pcFonts && !commonFound) commonFound = COMMON_FONTS.filter(fontInstalled);
  const all = pcFonts || commonFound;
  const list = all.filter((f) => f.toLowerCase().includes(q));
  const box = $('fontList');
  box.textContent = '';
  const add = (fam, label) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'font-item' + (fam === safeFamily(style.family) ? ' on' : ''); b.dataset.f = fam;
    const n = document.createElement('span'); n.className = 'fn'; n.textContent = label || fam;
    const smp = document.createElement('span'); smp.className = 'fs'; smp.textContent = 'Xin chào – Tiếng Việt';
    if (fam) smp.style.fontFamily = `"${fam}", "Segoe UI", sans-serif`;
    b.append(n, smp);
    if (fam && !fontHasVietnamese(fam)) { const w = document.createElement('span'); w.className = 'fw'; w.textContent = '⚠'; w.title = 'This font may not have all Vietnamese letters'; n.append(' ', w); }
    box.append(b);
  };
  if (!q) add('', 'Default (Segoe UI)');
  list.slice(0, 300).forEach((f) => add(safeFamily(f)));
  if (!list.length && q) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'No font with that name in the list – type the full name below and click “Use this font”.'; box.append(p); }
  if (list.length > 300) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = `${list.length} fonts – type a few letters to find yours.`; box.append(p); }
}
async function loadPcFonts() {
  if (!('queryLocalFonts' in window)) { fontMsg('This PC cannot list its fonts here – pick one below or type its name.'); return; }
  try {
    const data = await window.queryLocalFonts();
    const fams = [...new Set(data.map((d) => safeFamily(d.family)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (!fams.length) { fontMsg('No fonts were shared. You can still type a font name below.'); return; }
    pcFonts = fams;
    fontMsg(`${fams.length} fonts found on this PC.`);
    renderFonts();
  } catch (e) {
    fontMsg(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
      ? 'CaptionPress was not allowed to see the fonts. To allow it, click “Use fonts on this PC…” again and choose Allow (or allow “Fonts” in the site/app permissions). You can also type a font name below.'
      : 'The fonts could not be listed. Type a font name below instead.');
  }
}
function chooseFont(fam, checked) {
  fam = safeFamily(fam);
  if (fam && !checked && !fontInstalled(fam)) { fontMsg(`“${fam}” was not found on this PC. Type the name exactly as in Windows Settings → Fonts.`); return; }
  setStyle({ family: fam });
  renderFonts();
  fontMsg(fam ? (fontHasVietnamese(fam) ? `Using “${fam}”.` : `Using “${fam}”. ⚠ It may not have all Vietnamese letters – missing ones are drawn in Segoe UI.`) : 'Using the default font.');
}
$('stFamily').onclick = () => {
  fontMsg('');
  $('fontLocal').hidden = !('queryLocalFonts' in window);
  $('fontSearch').value = ''; $('fontName').value = '';
  renderFonts();
  $('fontDialog').showModal();
  // allowed before: list the PC's fonts right away (this click still counts as the user's action)
  if ('queryLocalFonts' in window && !pcFonts && navigator.permissions) {
    navigator.permissions.query({ name: 'local-fonts' }).then((st) => { if (st.state === 'granted') loadPcFonts(); }).catch(() => {});
  }
};
$('fontLocal').onclick = loadPcFonts;
$('fontSearch').addEventListener('input', renderFonts);
$('fontList').addEventListener('click', (e) => { const b = e.target.closest('.font-item'); if (b) chooseFont(b.dataset.f, true); });
$('fontTry').onclick = () => chooseFont($('fontName').value, false);
$('fontName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); chooseFont($('fontName').value, false); } });
$('fontClose').onclick = () => $('fontDialog').close();

// ---------- list tools ----------
$('undoBtn').onclick = undo;
$('redoBtn').onclick = redo;
$('addBtn').onclick = () => {
  const t = video.currentTime || 0;
  const next = tidy(cues.concat([{ start: t, end: t + 2, text: 'New line' }]));
  commit(next);
  const i = next.findIndex((c) => c.start === Math.round(t * 1000) / 1000 && c.text === 'New line');
  const ta = document.querySelector(`.cue[data-i="${i}"] textarea`);
  if (ta) { ta.focus(); ta.select(); }
};
$('findBtn').onclick = () => { $('findBar').hidden = !$('findBar').hidden; $('shiftBar').hidden = true; if (!$('findBar').hidden) $('findIn').focus(); };
$('shiftBtn').onclick = () => { $('shiftBar').hidden = !$('shiftBar').hidden; $('findBar').hidden = true; };
$('replBtn').onclick = () => {
  const r = replaceAll(cues, $('findIn').value, $('replIn').value, false);
  if (!r.count) { toast('Nothing found.'); return; }
  commit(r.cues); toast(`Replaced ${r.count} time${r.count > 1 ? 's' : ''}.`);
};
$('findIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findNext(); } });
function findNext() {
  const q = $('findIn').value.toLowerCase();
  if (!q) return;
  const start = (findNext.at == null ? -1 : findNext.at) + 1;
  for (let k = 0; k < cues.length; k++) {
    const i = (start + k) % cues.length;
    if (cues[i].text.toLowerCase().includes(q)) {
      findNext.at = i;
      video.currentTime = cues[i].start + 0.001;
      const row = document.querySelector(`.cue[data-i="${i}"]`);
      if (row) row.scrollIntoView({ block: 'center' });
      return;
    }
  }
  toast('Nothing found.');
}
const doShift = (sign) => {
  const v = Number($('shiftIn').value);
  if (!isFinite(v) || !v) return;
  commit(shiftCues(cues, sign * Math.abs(v)));
  toast(`All lines moved ${Math.abs(v)} s ${sign < 0 ? 'earlier' : 'later'}.`);
};
$('shiftEarlier').onclick = () => doShift(-1);
$('shiftLater').onclick = () => doShift(1);

// ---------- export ----------
function baseName() { return file ? file.name.replace(/\.[^.]+$/, '') : 'subtitles'; }
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
$('exportMenu').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-x]');
  if (!b) return;
  $('exportMenu').hidden = true;
  const x = b.dataset.x;
  if (x === 'srt') download(baseName() + '.srt', '﻿' + toSRT(cues), 'application/x-subrip;charset=utf-8');
  if (x === 'vtt') download(baseName() + '.vtt', toVTT(cues), 'text/vtt;charset=utf-8');
  if (x === 'txt') download(baseName() + ' transcript.txt', toTXT(cues));
  if (x === 'txts') download(baseName() + ' transcript.txt', spkOn() ? toTXTSpeakers(cues, Array.from({ length: spkCount() }, (_, i) => spkLabel(i))) : toTXTStamped(cues));
  if (x === 'docx') saveMinutes();
  if (x === 'cut') { if (!file) { toast('Open a video or recording first.'); return; } openCut(); return; }
  if (x === 'burn') {
    const why = limitReason({ burn: true }, unlocked());
    if (why) { openPro(why); return; }
    if (!file) { toast('Open the video first.'); return; }
    openBurn('captions');
  }
  if (x === 'voicevideo' || x === 'voicewav') {
    const why = limitReason({ voice: true }, unlocked());
    if (why) { openPro(why); return; }
    if (!file) { toast('Open the video first.'); return; }
    if (!cues.length) { toast('Make the subtitle lines first – the AI voice reads them aloud.'); return; }
    ensureVoice().then((ok) => {
      if (!ok) return;
      if (x === 'voicewav') { download(baseName() + ' voice-over.wav', encodeWav(voiceTrack), 'audio/wav'); toast('Voice-over saved to your Downloads folder.'); }
      else openBurn('voice');
    });
  }
});

// ---------- caption drawing (the same code for the preview and the saved video) ----------
const safeFamily = (f) => String(f || '').replace(/["'\;{}<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
function capFont(px) {
  const fam = safeFamily(style.family), f = fam ? `"${fam}", ` : '';
  return style.font === 'heavy'
    ? `900 ${px}px ${f}"Segoe UI Black", "Arial Black", "Segoe UI", system-ui, sans-serif`
    : `600 ${px}px ${f}"Segoe UI", system-ui, sans-serif`;
}
// where the caption block goes: Position, moved by the left/right and up/down sliders, always inside the picture
function capPlace(W, H, blockH) {
  let top = style.pos === 'top' ? H * 0.07 : style.pos === 'middle' ? H * 0.62 - blockH / 2 : H * 0.93 - blockH;
  top -= (Number(style.dy) || 0) / 100 * H;
  top = Math.max(H * 0.01, Math.min(H * 0.99 - blockH, top));
  return { top, cx: W * (0.5 + (Number(style.dx) || 0) / 100) };
}
const clampX = (x, w, W) => Math.max(W * 0.01, Math.min(W * 0.99 - w, x));
const kOffset = () => Math.max(-0.5, Math.min(0.5, Number(style.kOff) || 0));
// one word: outline + colour; `frac` of it (from the left) is drawn in the sung colours
function drawWord(ctx, text, x, y, w, frac, c) {
  const pass = (fill, line) => {
    if (c.bg === 'shadow') { ctx.lineJoin = 'round'; ctx.lineWidth = c.lw; ctx.strokeStyle = line; ctx.strokeText(text, x, y); }
    ctx.fillStyle = fill; ctx.fillText(text, x, y);
  };
  if (c.bg === 'none') { ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = c.blur; }
  if (frac >= 1) { pass(c.hl, c.olHl); return; }
  pass(c.fg, c.ol);
  if (frac <= 0) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(x - c.lw * 2, y - c.h, c.lw * 2 + w * frac, c.h * 2); ctx.clip();
  pass(c.hl, c.olHl);
  ctx.restore();
}
function capColors(px, karaoke) {
  const ol = style.ol || '#000000';
  return { fg: style.color, hl: style.hl, ol, olHl: karaoke ? (style.olHl || '#ffffff') : ol, bg: style.bg, lw: Math.max(2, px * (style.font === 'heavy' ? 0.2 : 0.16)), blur: px * 0.12, h: px * 1.2 };
}
// Draws the caption(s) for time t. Returns the area used (for dragging it on the preview).
function drawCaptions(ctx, t, W, H) {
  if (style.anim === 'karaoke2') return drawKaraoke(ctx, cues, t, W, H);
  const i = cueAt(cues, t);
  return i >= 0 ? drawCaption(ctx, cues[i], t, W, H) : null;
}
function drawCaption(ctx, cue, t, W, H) {
  if (!cue || !cue.text) return null;
  const px = Math.round(capBase(W, H) * style.size / 100);
  const anim = style.anim || 'none';
  let words = wordTimes(cue);
  if (!words.length) return null;
  if (style.upper) words.forEach((o) => (o.w = o.w.toLocaleUpperCase()));
  const tw = t - kOffset(); // "Karaoke timing": the highlight a little later or earlier than the word times
  const cur = anim === 'none' ? -1 : wordAt(words, tw);
  const fills = anim === 'fill' ? wordFill(words, tw) : null;
  let show = words.map((_, i) => i), popScale = 1;
  if (anim === 'pop') {
    const groups = popChunks(words, 3);
    const g = groups.find((x) => x.includes(Math.max(0, cur))) || groups[0];
    show = g;
    const age = tw - words[g[0]].s;
    popScale = age >= 0 && age < 0.12 ? 0.82 + 0.18 * (age / 0.12) : 1;
  }
  ctx.save();
  ctx.font = capFont(px);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const space = ctx.measureText(' ').width;
  const maxW = W * 0.92;
  // lay the words out in lines
  const lines = [];
  let line = null, lastLine = -1;
  show.forEach((i) => {
    const o = words[i], w = ctx.measureText(o.w).width;
    const gap = line && line.items.length && (anim === 'pop' || o.sp) ? space : 0;
    const newLine = !line || (anim !== 'pop' && o.line !== lastLine) || line.w + gap + w > maxW;
    if (newLine) { line = { items: [], w: 0 }; lines.push(line); }
    const g2 = line.items.length ? gap : 0;
    line.items.push({ i, x: line.w + g2, w });
    line.w += g2 + w;
    lastLine = o.line;
  });
  const lh = px * 1.35, blockH = lh * lines.length;
  const { top, cx } = capPlace(W, H, blockH);
  const oy = top + blockH / 2;
  if (popScale !== 1) { ctx.translate(cx, oy); ctx.scale(popScale, popScale); ctx.translate(-cx, -oy); }
  const col = capColors(px, false);
  let minX = W, maxX = 0;
  lines.forEach((ln, k) => {
    const y = top + lh * k + lh / 2, x0 = clampX(cx - ln.w / 2, ln.w, W);
    minX = Math.min(minX, x0); maxX = Math.max(maxX, x0 + ln.w);
    if (style.bg === 'box') {
      ctx.fillStyle = 'rgba(0,0,0,.72)';
      const pad = px * 0.35;
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x0 - pad, y - lh / 2, ln.w + pad * 2, lh, px * 0.15); ctx.fill(); }
      else ctx.fillRect(x0 - pad, y - lh / 2, ln.w + pad * 2, lh);
    }
    ln.items.forEach((it) => {
      const o = words[it.i];
      const frac = anim === 'fill' ? fills[it.i] : it.i === cur ? 1 : 0;
      const big = frac >= 1 && (anim === 'highlight' || anim === 'pop') ? 1.08 : 1;
      const wx = x0 + it.x + it.w / 2;
      ctx.save();
      ctx.translate(wx, y); if (big !== 1) ctx.scale(big, big);
      drawWord(ctx, o.w, -it.w / 2, 0, it.w, frac, col);
      ctx.restore();
    });
  });
  ctx.restore();
  return { x: minX - px * 0.4, y: top, w: maxX - minX + px * 0.8, h: blockH };
}
// "Karaoke – 2 lines": see karaokePlan()
let kCache = { list: null, lead: null, plan: null };
function kPlanFor(list) {
  const lead = style.leadIn !== false;
  if (kCache.list !== list || kCache.lead !== lead || kCache.n !== list.length) kCache = { list, lead, n: list.length, plan: karaokePlan(list, { leadIn: lead }) };
  return kCache.plan;
}
function drawKaraoke(ctx, list, t, W, H) {
  const plan = kPlanFor(list);
  const vis = karaokeVisible(plan, t);
  if (!vis.length) return null;
  const px = Math.round(capBase(W, H) * style.size / 100);
  const lh = px * 1.5, blockH = lh * 2;
  const { top, cx } = capPlace(W, H, blockH);
  const region = W * 0.84, tw = t - kOffset();
  let box = null;
  ctx.save();
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const v of vis) {
    const cue = list[v.i];
    const words = wordTimes(cue);
    if (!words.length) continue;
    if (style.upper) words.forEach((o) => (o.w = o.w.toLocaleUpperCase()));
    let rpx = px;
    const measure = () => {
      ctx.font = capFont(rpx);
      const sp = ctx.measureText(' ').width;
      let x = 0;
      return words.map((o, k) => {
        const w = ctx.measureText(o.w).width, gap = k && (o.sp || (o.line !== words[k - 1].line && !CJK.test(o.w))) ? sp : 0;
        const it = { x: x + gap, w }; x += gap + w; return it;
      });
    };
    let items = measure();
    const width = () => items[items.length - 1].x + items[items.length - 1].w;
    if (width() > W * 0.94) { rpx = Math.max(8, Math.floor(rpx * W * 0.94 / width())); items = measure(); }
    const rw = width();
    const x0 = clampX(v.row === 0 ? cx - region / 2 : cx + region / 2 - rw, rw, W);
    const y = top + lh * (v.row + 0.5);
    const col = capColors(rpx, true);
    if (style.bg === 'box') {
      ctx.fillStyle = 'rgba(0,0,0,.72)';
      const pad = rpx * 0.35;
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x0 - pad, y - lh / 2, rw + pad * 2, lh, rpx * 0.15); ctx.fill(); }
      else ctx.fillRect(x0 - pad, y - lh / 2, rw + pad * 2, lh);
    }
    const fills = wordFill(words, tw);
    words.forEach((o, k) => { ctx.save(); drawWord(ctx, o.w, x0 + items[k].x, y, items[k].w, fills[k], col); ctx.restore(); });
    // lead-in: 4 dots above the start of the line, one goes away per beat, the last one exactly when the line starts
    const n = leadDots(plan[v.i].lead, tw);
    if (n) {
      const r = Math.max(3, rpx * 0.17);
      ctx.lineWidth = Math.max(1.5, r * 0.4); ctx.strokeStyle = col.olHl; ctx.fillStyle = style.hl;
      for (let k = 0; k < n; k++) { ctx.beginPath(); ctx.arc(x0 + r * 1.2 + k * r * 3, y - rpx * 0.85 - r, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    }
    const b = { x: x0 - rpx * 0.4, y: y - lh / 2, w: rw + rpx * 0.8, h: lh };
    box = box ? { x: Math.min(box.x, b.x), y: Math.min(box.y, b.y), w: Math.max(box.x + box.w, b.x + b.w) - Math.min(box.x, b.x), h: Math.max(box.y + box.h, b.y + b.h) - Math.min(box.y, b.y) } : b;
  }
  ctx.restore();
  return box;
}
// Free users may try the two-line karaoke in the preview, with this mark on top (screen only).
const previewMark = () => style.anim === 'karaoke2' && !unlocked();
function drawWatermark(ctx, W, H, box) {
  const text = 'PREVIEW ★ CaptionPress Pro';
  const px = Math.max(12, Math.round(Math.min(W, H * 1.7) * 0.05));
  ctx.save();
  ctx.font = `800 ${px}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const put = (x, y, rot, a) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.globalAlpha = a;
    ctx.lineWidth = px * 0.14; ctx.strokeStyle = '#000'; ctx.strokeText(text, 0, 0);
    ctx.fillStyle = '#fff'; ctx.fillText(text, 0, 0);
    ctx.restore();
  };
  put(W / 2, H * 0.4, -0.16, 0.6);
  put(box ? box.x + box.w / 2 : W / 2, box ? box.y + box.h / 2 : H * 0.85, 0, 0.42);
  ctx.restore();
}
// ---------- burn-in ----------
function pickMime() {
  const list = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
let burn = null;
function openBurn(mode) {
  $('burnBar').style.width = '0';
  $('burnCaps').checked = true;
  $('burnVoice').disabled = !voiceTrack;
  $('burnVoice').checked = mode === 'voice' && !!voiceTrack;
  $('burnVoiceRow').hidden = !voiceTrack;
  $('burnText').textContent = `Length: ${fmtClock(video.duration || 0)}. The video is saved as ${pickMime().startsWith('video/mp4') ? 'MP4' : 'WEBM'}.`;
  $('burnStart').disabled = false;
  $('burnClose').textContent = 'Cancel';
  $('burnDialog').showModal();
}
async function startBurn() {
  if (!unlocked()) { $('burnDialog').close(); openPro(limitReason({ burn: true }, false)); return; }
  const mime = pickMime();
  if (!mime) { $('burnText').textContent = 'Recording video is not supported on this computer.'; return; }
  video.pause();
  const showCaps = $('burnCaps').checked;
  const useVoice = $('burnVoice').checked && !!voiceTrack;
  if (!showCaps && !useVoice) { $('burnText').textContent = 'Tick captions, voice-over or both.'; return; }
  $('burnStart').disabled = true;
  const v = document.createElement('video');
  v.src = fileUrl; v.playsInline = true; v.preload = 'auto';
  await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error('The video could not be opened.')); });
  const hasPic = v.videoWidth > 0;
  let W = hasPic ? v.videoWidth : 1280, H = hasPic ? v.videoHeight : 720;
  if (W > 1920) { H = Math.round(H * 1920 / W); W = 1920; }
  W -= W % 2; H -= H % 2;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const ac = new AudioContext();
  try { await ac.resume(); } catch (_) {}
  const src = ac.createMediaElementSource(v);
  const dest = ac.createMediaStreamDestination();
  const gain = ac.createGain();
  gain.gain.value = useVoice ? vc.orig / 100 : 1;
  src.connect(gain); gain.connect(dest);
  let vs = null;
  if (useVoice) { vs = ac.createBufferSource(); vs.buffer = voiceTrack; vs.connect(dest); }
  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.min(12e6, Math.max(2.5e6, W * H * 4)) });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  burn = { v, rec, ac, stop: false };
  const draw = () => {
    if (hasPic) ctx.drawImage(v, 0, 0, W, H); else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
    if (showCaps) drawCaptions(ctx, v.currentTime, W, H);
    const d = v.duration || 1;
    $('burnBar').style.width = (v.currentTime / d * 100) + '%';
    $('burnText').textContent = `Recording… ${fmtClock(v.currentTime)} of ${fmtClock(d)}. Keep this window open.`;
  };
  let timer = 0;
  const loop = () => { if (!burn) return; draw(); if (!v.ended && !burn.stop) { if (hasPic && v.requestVideoFrameCallback) v.requestVideoFrameCallback(loop); } };
  const done = new Promise((resolve) => { rec.onstop = resolve; });
  draw();
  rec.start(1000);
  try { await v.play(); } catch (e) { rec.stop(); $('burnText').textContent = 'The video could not be played: ' + e.message; return; }
  if (vs) vs.start(ac.currentTime, v.currentTime);
  if (hasPic && v.requestVideoFrameCallback) v.requestVideoFrameCallback(loop); else timer = setInterval(draw, 1000 / 30);
  await new Promise((r) => { v.onended = r; burn.end = r; });
  draw();
  clearInterval(timer);
  if (rec.state !== 'inactive') rec.stop();
  await done;
  ac.close();
  const stopped = burn.stop;
  burn = null;
  if (stopped) return;
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  const outName = `${baseName()} with ${useVoice && showCaps ? 'voice-over and captions' : useVoice ? 'voice-over' : 'captions'}.${ext}`;
  download(outName, new Blob(parts, { type: mime.split(';')[0] }));
  $('burnBar').style.width = '100%';
  $('burnText').textContent = `Saved “${outName}” to your Downloads folder.`;
  $('burnClose').textContent = 'Close';
}
$('burnStart').onclick = () => startBurn().catch((e) => { $('burnText').textContent = e.message; });
$('burnClose').onclick = () => {
  if (burn) { burn.stop = true; burn.v.pause(); if (burn.end) burn.end(); }
  $('burnDialog').close();
};


// ---------- filler words & pauses ----------
$('fillerBtn').onclick = () => {
  const r = removeFillers(cues);
  if (!r.count) { toast('No um, uh or other filler words were found.'); return; }
  commit(r.cues);
  toast(`Removed ${r.count} filler word${r.count > 1 ? 's' : ''}. Ctrl+Z to undo.`);
};
let cutPlan = null, cutJob = null;
async function openCut() {
  $('cutInfo').textContent = ''; $('cutText').textContent = 'Listening for pauses…'; $('cutBar').style.width = '0';
  $('cutStart').disabled = true; $('cutSubs').hidden = true; $('cutClose').textContent = 'Cancel';
  $('cutCapsRow').hidden = !cues.length;
  $('cutDialog').showModal();
  await planCut();
}
async function planCut() {
  try {
    const samples = lastAudio && lastAudio.f === file ? lastAudio.s : await decodeAudio(file);
    lastAudio = { f: file, s: samples };
    const dur = samples.length / SR;
    const cuts = findPauses(samples, { minGap: Number($('cutGap').value) });
    const saved = cuts.reduce((n, c) => n + c.end - c.start, 0);
    cutPlan = { cuts, keep: keepParts(video.duration && isFinite(video.duration) ? video.duration : dur, cuts), dur, saved };
    if (!cutPlan.keep.length) { $('cutInfo').textContent = 'This file is silent from start to end – there is nothing to keep.'; $('cutText').textContent = ''; $('cutStart').disabled = true; return; }
    $('cutInfo').textContent = cuts.length ?`${cuts.length} pause${cuts.length > 1 ? 's' : ''} found – ${fmtClock(saved)} shorter. The new video is ${fmtClock(dur - saved)} instead of ${fmtClock(dur)}.` : 'No long pauses were found. Try a shorter pause length.';
    $('cutText').textContent = cuts.length ? 'Saving plays the video once with the pauses skipped, so it takes about as long as the new video.' : '';
    $('cutStart').disabled = !cuts.length;
  } catch (e) { $('cutText').textContent = 'The sound could not be read: ' + e.message; }
}
async function startCut() {
  if (!cutPlan || !cutPlan.cuts.length) return;
  const why = limitReason({ cut: true }, unlocked());
  if (why) { $('cutDialog').close(); openPro(why); return; }
  const mime = pickMime();
  if (!mime) { $('cutText').textContent = 'Recording video is not supported on this computer.'; return; }
  video.pause();
  $('cutStart').disabled = true; $('cutGap').disabled = true;
  const showCaps = $('cutCaps').checked && cues.length > 0;
  const v = document.createElement('video');
  v.src = fileUrl; v.playsInline = true; v.preload = 'auto';
  await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error('The video could not be opened.')); });
  const hasPic = v.videoWidth > 0;
  let W = hasPic ? v.videoWidth : 1280, H = hasPic ? v.videoHeight : 720;
  if (W > 1920) { H = Math.round(H * 1920 / W); W = 1920; }
  W -= W % 2; H -= H % 2;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const ac = new AudioContext(); try { await ac.resume(); } catch (_) {}
  const src = ac.createMediaElementSource(v), dest = ac.createMediaStreamDestination();
  src.connect(dest);
  const audioOnly = !hasPic && !showCaps;
  const amime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const tracks = audioOnly ? dest.stream.getAudioTracks() : [...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()];
  const rec = new MediaRecorder(new MediaStream(tracks), audioOnly ? (amime ? { mimeType: amime } : undefined) : { mimeType: mime, videoBitsPerSecond: Math.min(12e6, Math.max(2.5e6, W * H * 4)) });
  const parts = []; rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  cutJob = { v, rec, ac, stop: false };
  const total = cutPlan.keep.reduce((n, k) => n + k.end - k.start, 0); let doneT = 0;
  const draw = () => {
    if (hasPic) ctx.drawImage(v, 0, 0, W, H); else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
    if (showCaps) drawCaptions(ctx, v.currentTime, W, H);
  };
  const done = new Promise((r) => { rec.onstop = r; });
  let started = false;
  for (const k of cutPlan.keep) {
    if (cutJob.stop) break;
    v.currentTime = k.start;
    await new Promise((r) => { v.onseeked = r; });
    draw();
    if (!started) { rec.start(1000); started = true; } else rec.resume();
    await v.play();
    await new Promise((r) => {
      const step = () => {
        if (cutJob.stop || v.ended || v.currentTime >= k.end - 0.02) { r(); return; }
        draw();
        $('cutBar').style.width = Math.min(100, (doneT + v.currentTime - k.start) / total * 100) + '%';
        $('cutText').textContent = `Saving… ${fmtClock(doneT + v.currentTime - k.start)} of ${fmtClock(total)}. Keep this window open.`;
        setTimeout(step, 30); // a timer, not the frame callback: that one stops at the end of the video
      };
      step();
    });
    v.pause(); draw();
    if (rec.state === 'recording') rec.pause();
    doneT += k.end - k.start;
  }
  if (rec.state !== 'inactive') rec.stop();
  await done; ac.close();
  const stopped = cutJob.stop; cutJob = null; $('cutGap').disabled = false;
  if (stopped) return;
  const type = (audioOnly ? (amime || 'audio/webm') : mime).split(';')[0];
  const ext = type === 'video/mp4' ? 'mp4' : type === 'audio/mp4' ? 'm4a' : 'webm';
  const name = `${baseName()} – pauses cut.${ext}`;
  download(name, new Blob(parts, { type }));
  $('cutBar').style.width = '100%';
  $('cutText').textContent = `Saved “${name}” to your Downloads folder.` + (cues.length ? ' Want subtitles for the new video? Click “Move subtitle times to match”, then save the SRT.' : '');
  $('cutSubs').hidden = !cues.length; $('cutClose').textContent = 'Close';
}
$('cutGap').onchange = planCut;
$('cutMenuBtn').onclick = () => { closeMenus(); if (!file) { toast('Open a video or recording first.'); return; } openCut(); };
$('cutStart').onclick = () => startCut().catch((e) => { $('cutText').textContent = e.message; $('cutGap').disabled = false; });
$('cutSubs').onclick = () => { if (!cutPlan) return; commit(retimeCues(cues, cutPlan.cuts)); $('cutSubs').hidden = true; toast('Subtitle times now match the shorter video. Ctrl+Z to undo.', 6000); };
$('cutClose').onclick = () => { if (cutJob) { cutJob.stop = true; cutJob.v.pause(); } $('cutDialog').close(); };

// ---------- menus & keys ----------
function closeMenus() { $('menu').hidden = true; $('exportMenu').hidden = true; }
$('moreBtn').onclick = (e) => { e.stopPropagation(); const h = $('menu').hidden; closeMenus(); $('menu').hidden = !h; };
$('exportBtn').onclick = (e) => { e.stopPropagation(); const h = $('exportMenu').hidden; closeMenus(); $('exportMenu').hidden = !h; };
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
$('importBtn').onclick = () => { closeMenus(); $('subIn').click(); };
$('clearBtn').onclick = () => { closeMenus(); if (!cues.length) return; commit([]); toast('All lines removed. Press Ctrl+Z to bring them back.'); };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenus();
  const typing = e.target.matches('input, textarea, select');
  if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); if (file) video.paused ? video.play() : video.pause(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'h') { e.preventDefault(); $('findBtn').click(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); $('fileIn').click(); return; }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
  if (typing) return;
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }
  else if (e.code === 'Space' && file) { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (e.key === 'ArrowLeft' && file) video.currentTime = Math.max(0, video.currentTime - 2);
  else if (e.key === 'ArrowRight' && file) video.currentTime += 2;
  else if (!e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'm' && file) markNow();
});
window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); const k = storeKey(); if (k && cues.length) try { localStorage.setItem(k, JSON.stringify({ cues, names: spkNames, t: Date.now() })); } catch (_) {} });

// ---------- Pro ----------
$('proBtn').onclick = () => { if (!isPro) openPro(); };
$('buyBtn').onclick = buyPro;
$('restoreBtn').onclick = async () => { proMessage((await checkPro()) ? 'Pro is unlocked. ★' : 'No Pro purchase was found on this Microsoft account.'); };
$('closePro').onclick = () => $('proDialog').close();

// ---------- AI voice-over (Pro; "Try this voice" is free) ----------
let vc = { voice: '', speed: 1, orig: 20 };
try { Object.assign(vc, JSON.parse(localStorage.getItem('cp-voice') || '{}')); } catch (_) {}
let ttsW = null, ttsJobs = {}, ttsId = 0, ttsProg = null;
const clipCache = new Map();
let voiceTrack = null, voiceSig = '', voiceBusy = false, voiceCancel = false;
let vAc = null, vSrc = null;

function saveVc() { try { localStorage.setItem('cp-voice', JSON.stringify(vc)); } catch (_) {} }
function vcStatus(t) { $('vcStatus').textContent = t || ''; }
function vcBar(p) { $('vcProg').hidden = p == null; $('vcBar').style.width = (p || 0) + '%'; }

function getTTS() {
  if (ttsW) return ttsW;
  ttsW = new Worker('tts-worker.js');
  ttsW.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') { if (ttsProg) ttsProg(m.loaded, m.total); return; }
    const j = ttsJobs[m.id];
    if (!j) return;
    delete ttsJobs[m.id];
    if (m.type === 'error') j.reject(new Error(m.message)); else j.resolve({ data: m.data, sampleRate: m.sampleRate });
  };
  ttsW.onerror = (e) => { Object.values(ttsJobs).forEach((j) => j.reject(new Error(e.message || 'The voice engine stopped.'))); ttsJobs = {}; ttsW = null; };
  return ttsW;
}
function speakText(text, voice, speed) {
  const t = cleanText(String(text).replace(/\n/g, ' '));
  const key = voice + '|' + speed + '|' + t;
  if (clipCache.has(key)) return Promise.resolve(clipCache.get(key));
  const id = ++ttsId;
  return new Promise((resolve, reject) => {
    ttsJobs[id] = { resolve: (r) => { clipCache.set(key, r); resolve(r); }, reject };
    getTTS().postMessage({ type: 'speak', id, text: t, voice, speed });
  });
}
const showDownload = (loaded, total) => {
  if (total > 1e6) { vcBar(loaded / total * 100); vcStatus(`Getting the voice ready (first time only) · ${(loaded / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB`); }
};

function defaultVoiceLang() {
  if (opts.task === 'translate') return 'en';
  if (opts.lang && VOICES[opts.lang]) return opts.lang;
  return 'en';
}
function fillVoices() {
  const names = Object.fromEntries(LANGS);
  const want = vc.voice && Object.values(VOICES).some((l) => l.some((v) => v[0] === vc.voice)) ? vc.voice : VOICES[defaultVoiceLang()][0][0];
  $('vcVoice').innerHTML = Object.entries(VOICES).map(([lang, list]) =>
    `<optgroup label="${esc(names[lang] || lang)}">${list.map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('')}</optgroup>`).join('');
  $('vcVoice').value = want; vc.voice = want;
  $('vcSpeed').value = String(vc.speed);
  $('vcOrig').value = vc.orig;
  $('vcOrigVal').textContent = vc.orig ? vc.orig + '%' : 'off';
}

function toBuffer(ctx, clip) {
  const b = ctx.createBuffer(1, clip.data.length, clip.sampleRate);
  b.copyToChannel(clip.data, 0);
  return b;
}
async function tryVoice() {
  if (voiceBusy) return;
  const i = cueAt(cues, video.currentTime || 0);
  const text = (cues[i] || cues[0] || {}).text || SAMPLE_LINE[langOfVoice(vc.voice)] || SAMPLE_LINE.en;
  voiceBusy = true; $('vcTry').disabled = true;
  ttsProg = showDownload;
  vcStatus('Preparing the voice…');
  try {
    const clip = await speakText(text, vc.voice, vc.speed);
    vcBar(null);
    vAc = vAc || new AudioContext();
    await vAc.resume();
    const s = vAc.createBufferSource();
    s.buffer = toBuffer(vAc, clip);
    s.connect(vAc.destination);
    s.start();
    vcStatus('▶ “' + text.replace(/\n/g, ' ').slice(0, 80) + '”');
  } catch (e) { vcBar(null); vcStatus('The voice could not be loaded: ' + e.message + '. Check the internet connection for the first download.'); }
  finally { voiceBusy = false; $('vcTry').disabled = false; ttsProg = null; }
}

const voiceKey = () => JSON.stringify([vc.voice, vc.speed, cues.map((c) => [c.start, c.text])]);
async function makeVoice() {
  const why = limitReason({ voice: true }, unlocked());
  if (why) { openPro(why); return false; }
  if (!cues.length) { vcStatus('Make or open the subtitle lines first – the voice reads them aloud.'); return false; }
  if (voiceBusy) return false;
  voiceBusy = true; voiceCancel = false;
  $('vcMake').disabled = true; $('vcTry').disabled = true;
  ttsProg = showDownload;
  const list = cues.map((c) => ({ ...c }));
  const clips = [];
  try {
    for (let i = 0; i < list.length; i++) {
      if (voiceCancel) return false;
      clips.push(await speakText(list[i].text, vc.voice, vc.speed));
      vcBar((i + 1) / list.length * 100);
      vcStatus(`Recording the voice… line ${i + 1} of ${list.length}`);
    }
    const total = Math.max(video.duration || 0, list[list.length - 1].end + 2);
    const SRATE = 44100;
    const off = new OfflineAudioContext(1, Math.ceil(total * SRATE), SRATE);
    const plan = planVoice(list, clips.map((c) => ({ length: c.data.length, sampleRate: c.sampleRate })), total);
    plan.forEach((p, i) => {
      if (!p) return;
      const s = off.createBufferSource();
      s.buffer = toBuffer(off, clips[i]);
      s.playbackRate.value = p.rate;
      s.connect(off.destination);
      s.start(p.start);
    });
    voiceTrack = await off.startRendering();
    voiceSig = JSON.stringify([vc.voice, vc.speed, list.map((c) => [c.start, c.text])]);
    vcBar(null);
    $('vcOn').disabled = false; $('vcOn').checked = true;
    applyOrigVolume();
    vcStatus(`Voice-over ready – ${list.length} lines. Press play to hear it, or save it from 💾 Save subtitles.`);
    return true;
  } catch (e) {
    vcBar(null); vcStatus('The voice-over could not be made: ' + e.message);
    return false;
  } finally {
    voiceBusy = false; ttsProg = null;
    $('vcMake').disabled = false; $('vcTry').disabled = false;
  }
}
async function ensureVoice() {
  if (voiceTrack && voiceSig === voiceKey()) return true;
  $('voiceBox').open = true;
  return makeVoice();
}

// play the voice track in step with the video
function stopVoicePlay() { if (vSrc) { try { vSrc.stop(); } catch (_) {} vSrc = null; } }
function startVoicePlay() {
  stopVoicePlay();
  if (!$('vcOn').checked || !voiceTrack || video.paused) return;
  vAc = vAc || new AudioContext();
  vAc.resume();
  vSrc = vAc.createBufferSource();
  vSrc.buffer = voiceTrack;
  vSrc.connect(vAc.destination);
  vSrc.start(0, Math.min(voiceTrack.duration, Math.max(0, video.currentTime)));
  if (voiceSig !== voiceKey()) vcStatus('Lines changed since the voice-over was made – click Create voice-over to update it.');
}
function applyOrigVolume() { video.volume = $('vcOn').checked && voiceTrack ? vc.orig / 100 : 1; }
video.addEventListener('play', startVoicePlay);
video.addEventListener('pause', stopVoicePlay);
video.addEventListener('seeking', stopVoicePlay);
video.addEventListener('seeked', startVoicePlay);
video.addEventListener('emptied', () => { stopVoicePlay(); voiceTrack = null; voiceSig = ''; $('vcOn').checked = false; $('vcOn').disabled = true; applyOrigVolume(); vcStatus(''); });

function encodeWav(buf) {
  const data = buf.getChannelData(0), sr = buf.sampleRate;
  const dv = new DataView(new ArrayBuffer(44 + data.length * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + data.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, data.length * 2, true);
  for (let i = 0, o = 44; i < data.length; i++, o += 2) { const s = Math.max(-1, Math.min(1, data[i])); dv.setInt16(o, s < 0 ? s * 32768 : s * 32767, true); }
  return new Blob([dv.buffer], { type: 'audio/wav' });
}

$('vcVoice').addEventListener('change', () => { vc.voice = $('vcVoice').value; saveVc(); });
$('vcSpeed').addEventListener('change', () => { vc.speed = Number($('vcSpeed').value); saveVc(); });
$('vcOrig').addEventListener('input', () => { vc.orig = Number($('vcOrig').value); $('vcOrigVal').textContent = vc.orig ? vc.orig + '%' : 'off'; applyOrigVolume(); saveVc(); });
$('vcOn').addEventListener('change', () => { applyOrigVolume(); if ($('vcOn').checked) startVoicePlay(); else stopVoicePlay(); });
$('vcTry').onclick = tryVoice;
$('vcMake').onclick = () => makeVoice();
$('voiceBox').addEventListener('toggle', () => { if (typeof fitFrame === 'function') fitFrame(); });
fillVoices();
// ---------- Translate subtitles (Pro) ----------
let trBusy = false, trDl = {};
function trStatus(t) { $('trStatus').textContent = t || ''; }
function trBarSet(p) { $('trProg').hidden = p == null; $('trBar').style.width = (p || 0) + '%'; }
function trProgress(p) {
  if (!p || !p.file || !(p.status === 'progress' || p.status === 'done')) return;
  trDl[p.file] = { loaded: p.loaded || (trDl[p.file] && trDl[p.file].total) || 0, total: p.total || (trDl[p.file] && trDl[p.file].total) || 0 };
  const all = Object.values(trDl);
  const loaded = all.reduce((n, x) => n + (x.loaded || 0), 0), total = all.reduce((n, x) => n + (x.total || 0), 0);
  if (total > 2e6) { trBarSet(loaded / total * 100); trStatus(`Getting the translator ready (first time only) · ${(loaded / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB`); }
}
async function translateLines() {
  const why = limitReason({ translateTo: true }, unlocked());
  if (why) { openPro(why); return; }
  if (!cues.length) { trStatus('Make or open the subtitle lines first.'); return; }
  if (trBusy || busy) return;
  const target = TR_LANGS.find((l) => l[0] === $('trLang').value) || TR_LANGS[0];
  trBusy = true; trDl = {};
  $('trBtn').disabled = true;
  const before = snapshot();
  const list = cues.map((c) => ({ ...c }));
  const groups = sentenceGroups(list);
  try {
    trStatus('Preparing the translator…');
    const BATCH = 6;
    for (let g = 0; g < groups.length; g += BATCH) {
      const part = groups.slice(g, g + BATCH);
      const id = ++jobId;
      const res = await call({ type: 'translate', id, model: target[2], texts: part.map((x) => x.text) }, id);
      part.forEach((grp, k) => {
        const n = grp.to - grp.from + 1;
        const weights = list.slice(grp.from, grp.to + 1).map((c) => c.text.length);
        const pieces = distribute(res.out[k] || grp.text, weights);
        for (let i = 0; i < n; i++) { list[grp.from + i].text = wrapText(pieces[i] || '', style.chars); delete list[grp.from + i].wt; }
      });
      const done = Math.min(groups.length, g + BATCH);
      trBarSet(done / groups.length * 100);
      trStatus(`Translating into ${target[1]}… ${done} of ${groups.length} sentences`);
      cues = list.map((c) => ({ ...c }));
      renderList(); renderCap();
    }
    hist.push(before); fut = [];
    autosave(); updateButtons();
    trBarSet(null);
    trStatus(`Done – ${list.length} lines are now in ${target[1]}. Check them, then save. Ctrl+Z brings the English back.`);
    if (VOICES[target[0]]) {
      vc.voice = VOICES[target[0]][0][0]; saveVc(); fillVoices();
      trStatus($('trStatus').textContent + ` The AI voice is set to ${target[1]}.`);
    }
  } catch (e) {
    if (snapshot() !== before) { hist.push(before); fut = []; }
    trBarSet(null); trStatus('The translation stopped: ' + e.message);
  } finally {
    trBusy = false; $('trBtn').disabled = false; updateButtons();
  }
}
$('trLang').innerHTML = TR_LANGS.map(([code, name]) => `<option value="${code}">${name}</option>`).join('');
try { $('trLang').value = localStorage.getItem('cp-trlang') || 'vi'; } catch (_) { $('trLang').value = 'vi'; }
$('trLang').addEventListener('change', () => { try { localStorage.setItem('cp-trlang', $('trLang').value); } catch (_) {} });
$('trBtn').onclick = translateLines;
// ---------- Who is speaking – meeting notes (Pro) ----------
let spkNames = [], spkBusy = false, spkDl = {}, lastAudio = null;
const spkDefault = (i) => (opts.lang === 'vi' ? `Người ${i + 1}` : `Person ${i + 1}`);
const spkLabel = (i) => (spkNames[i] && spkNames[i].trim()) || spkDefault(i);
const darkQ = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : { matches: false };
const spkColor = (i) => (darkQ.matches ? SPK_COLORS_DARK : SPK_COLORS)[i % SPK_COLORS.length];
const spkColorPrint = (i) => SPK_COLORS[i % SPK_COLORS.length];
let spkEmb = new Map(); // line start -> voice fingerprint (this session)
const embKey = (c) => c.start.toFixed(2);
let voiceBank = [];
try { voiceBank = JSON.parse(localStorage.getItem('cp-voicebank') || '[]'); } catch (_) { voiceBank = []; }
function saveBank() { try { localStorage.setItem('cp-voicebank', JSON.stringify(voiceBank)); } catch (_) {} renderBank(); }
function spkCount() { return Math.max(spkNames.length, cues.reduce((m, c) => Math.max(m, c.spk == null ? -1 : c.spk), -1) + 1); }
function spkOn() { return cues.some((c) => c.spk != null && c.spk >= 0); }
function spkStatus(t) { $('spkStatus').textContent = t || ''; }
function spkBar(p) { $('spkProg').hidden = p == null; $('spkBarIn').style.width = (p || 0) + '%'; }
function spkProgress(p) {
  if (!p || !p.file || !(p.status === 'progress' || p.status === 'done')) return;
  spkDl[p.file] = { loaded: p.loaded || (spkDl[p.file] && spkDl[p.file].total) || 0, total: p.total || (spkDl[p.file] && spkDl[p.file].total) || 0 };
  const all = Object.values(spkDl);
  const loaded = all.reduce((n, x) => n + (x.loaded || 0), 0), total = all.reduce((n, x) => n + (x.total || 0), 0);
  if (total > 2e6) spkStatus(`Getting the voice finder ready (first time only) · ${(loaded / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB`);
}
function saveNames() { autosave(); }

function spkSelectHtml(c) {
  const n = spkCount();
  const v = c.spk == null ? -1 : c.spk;
  let o = `<option value="-1"${v < 0 ? ' selected' : ''}>– who? –</option>`;
  for (let i = 0; i < n; i++) o += `<option value="${i}"${v === i ? ' selected' : ''}>${esc(spkLabel(i))}</option>`;
  o += '<option value="new">＋ New person…</option>';
  return `<select class="spk" aria-label="Speaker" title="Who is speaking" style="--spk:${v >= 0 ? spkColor(v) : 'transparent'}">${o}</select>`;
}

function renderSpeakers() {
  renderStars(); renderCharts();
  const n = spkCount();
  const box = $('spkList');
  if (!n) { box.innerHTML = ''; box.hidden = true; $('spkTools').hidden = true; return; }
  const st = speakerStats(cues, n);
  box.hidden = false; $('spkTools').hidden = false;
  box.innerHTML = st.map((s, i) => `<div class="spk-row" data-s="${i}">
      <span class="dot" style="background:${spkColor(i)}"></span>
      <input type="text" class="spk-name" value="${esc(spkNames[i] || '')}" placeholder="${esc(spkDefault(i))}" aria-label="Name of ${esc(spkDefault(i))}">
      <span class="muted spk-info">${s.lines} lines · ${fmtClock(s.time)}</span>
      <button class="ghost small" data-sa="hear" title="Hear this person's first line" ${s.first < 0 ? 'disabled' : ''}>▶</button>
      <select class="spk-merge" aria-label="Same person as" title="Is this the same person as someone else? Join them.">
        <option value="">Same as…</option>
        ${st.map((_, j) => (j === i ? '' : `<option value="${j}">${esc(spkLabel(j))}</option>`)).join('')}
      </select>
    </div>`).join('');
}

function setNames(next) { spkNames = next; renderSpeakers(); renderList(); autosave(); }

// Join speaker `from` into `into` and renumber the rest.
function mergeSpeaker(from, into) {
  const map = (s) => (s == null || s < 0 ? s : s === from ? into : s);
  let next = cues.map((c) => (c.spk == null ? c : { ...c, spk: map(c.spk) }));
  const names = spkNames.slice();
  if (!names[into] && names[from]) names[into] = names[from];
  names.splice(from, 1);
  next = next.map((c) => (c.spk == null || c.spk < from ? c : { ...c, spk: c.spk - 1 }));
  spkNames = names;
  commit(next);
  renderSpeakers();
}

async function audioSamples() {
  if (lastAudio && lastAudio.f === file) return lastAudio.s;
  const s = await decodeAudio(file);
  lastAudio = { f: file, s };
  return s;
}

async function findSpeakers() {
  const why = limitReason({ speakers: true }, unlocked());
  if (why) { openPro(why); return; }
  if (!file) { spkStatus('Open the meeting video or audio first.'); return; }
  if (!cues.length) { spkStatus('First press Create subtitles – then CaptionPress finds who said each line.'); return; }
  if (spkBusy || busy) return;
  spkBusy = true; spkDl = {};
  $('spkBtn').disabled = true;
  const before = snapshot();
  try {
    spkStatus('Reading the sound…'); spkBar(1);
    const samples = await audioSamples();
    const pieces = speakerPieces(cues);
    const embs = new Array(cues.length).fill(null);
    const todo = pieces.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
    const BATCH = 24;
    const t0 = performance.now();
    let dev = '';
    for (let k = 0; k < todo.length; k += BATCH) {
      const part = todo.slice(k, k + BATCH);
      const audios = part.map((i) => samples.slice(Math.max(0, Math.round(pieces[i].start * SR)), Math.round(pieces[i].end * SR)));
      const id = ++jobId;
      const res = await call({ type: 'embed', id, audios }, id, audios.map((a) => a.buffer));
      dev = res.device;
      part.forEach((i, j) => (embs[i] = res.out[j]));
      const done = Math.min(todo.length, k + BATCH);
      const spent = (performance.now() - t0) / 1000, left = spent / done * (todo.length - done);
      spkBar(5 + 90 * done / todo.length);
      spkStatus(`Listening to the voices… ${done} of ${todo.length} lines${left > 20 ? ` · about ${Math.ceil(left / 60)} min left` : ''}`);
    }
    spkStatus('Grouping the voices…');
    await new Promise((r) => setTimeout(r, 30));
    const k = Number($('spkCountSel').value) || 0;
    const labels = diarize(embs, cues.map((c) => c.end - c.start), { k });
    const n = Math.max(...labels) + 1;
    spkEmb = new Map();
    cues.forEach((c, i) => { if (embs[i]) spkEmb.set(embKey(c), embs[i]); });
    // recognise people whose voices were remembered before
    const cents = Array.from({ length: n }, (_, g) => {
      const idx = labels.map((l, i) => (l === g && embs[i] ? i : -1)).filter((i) => i >= 0);
      return centroid(idx.map((i) => embs[i]), idx.map((i) => cues[i].end - cues[i].start));
    });
    const known = matchVoices(cents, voiceBank, 0.6);
    spkNames = Array.from({ length: n }, (_, g) => (known[g] ? known[g].name : ''));
    const next = cues.map((c, i) => ({ ...c, spk: labels[i] }));
    commit(next, before);
    renderSpeakers();
    spkBar(null);
    const rec = known.filter(Boolean).map((x) => x.name);
    spkStatus(`Found ${n} ${n === 1 ? 'person' : 'people'}.${rec.length ? ` Recognised: ${rec.join(', ')}.` : ''} Type the other names, press ▶ to hear who is who, and fix any line with the name box next to it. Then Save → Meeting minutes (.docx).`);
  } catch (e) {
    spkBar(null); spkStatus('Finding speakers stopped: ' + e.message);
  } finally {
    spkBusy = false; $('spkBtn').disabled = false; updateButtons();
  }
}

function minutesMeta() {
  const d = new Date(file && file.lastModified ? file.lastModified : Date.now());
  const pad = (x) => String(x).padStart(2, '0');
  const lang = opts.lang === 'vi' ? 'vi' : 'en';
  return {
    lang,
    date: lang === 'vi' ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    file: file ? file.name : '',
    duration: isFinite(video.duration) ? fmtClock(video.duration) : '',
    title: (MINUTES_TEXT[lang] || MINUTES_TEXT.en).title + (file ? ' – ' + baseName() : ''),
  };
}
async function saveMinutes() {
  const why = limitReason({ speakers: true }, unlocked());
  if (why) { openPro(why); return; }
  if (!cues.length) { toast('Make the subtitle lines first.'); return; }
  const names = Array.from({ length: spkCount() }, (_, i) => spkLabel(i));
  const meta = minutesMeta();
  if (spkOn()) { try { meta.images = [await chartPng(meta.lang)]; } catch (_) { meta.images = []; } }
  const data = minutesDocx(cues, names, meta);
  download(baseName() + (opts.lang === 'vi' ? ' - bien ban hop.docx' : ' minutes.docx'), new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
  const learnt = spkOn() ? rememberVoices(true) : 0;
  toast(spkOn() ? `Meeting minutes saved to your Downloads folder.${learnt ? ' Named voices are remembered for next time.' : ''}` : 'Minutes saved. Tip: use “Find speakers” first to add who said what.', 5000);
}

// ---- remembered voices ----
function rememberVoices(quiet) {
  let n = 0;
  for (let i = 0; i < spkCount(); i++) {
    const name = (spkNames[i] || '').trim();
    if (!name) continue;
    const own = cues.filter((c) => c.spk === i && spkEmb.has(embKey(c)));
    if (!own.length) continue;
    const v = centroid(own.map((c) => spkEmb.get(embKey(c))), own.map((c) => c.end - c.start));
    voiceBank = rememberVoice(voiceBank, name, v, Math.min(60, own.reduce((t, c) => t + c.end - c.start, 0)));
    n++;
  }
  if (n) saveBank();
  if (!quiet) toast(n ? `${n} ${n === 1 ? 'voice' : 'voices'} remembered. Next time CaptionPress fills in these names by itself.` : 'Type a name for a person first (after Find speakers in this session).', 5000);
  return n;
}
function renderBank() {
  const box = $('vbList');
  if (!box) return;
  box.innerHTML = voiceBank.length
    ? 'Remembered voices: ' + voiceBank.map((b, i) => `<span class="vb-chip">${esc(b.name)}<button data-vb="${i}" title="Forget this voice" aria-label="Forget ${esc(b.name)}">✕</button></span>`).join(' ')
    : 'No remembered voices yet. Name the people, then press “Remember voices” – next time CaptionPress recognises them.';
}

// ---- key moments ----
function renderStars() {
  const box = $('starList');
  const list = cues.map((c, i) => [c, i]).filter(([c]) => c.star);
  $('starHead').textContent = `★ Key moments (${list.length})`;
  box.innerHTML = list.length
    ? list.map(([c, i]) => `<button class="star-item" data-i="${i}"><span class="muted">${fmtClock(c.start)}</span> ${c.spk != null && c.spk >= 0 ? `<b style="color:${spkColor(c.spk)}">●</b> ${esc(spkLabel(c.spk))}: ` : ''}${esc(c.text.replace(/\n/g, ' ').slice(0, 90))}</button>`).join('')
    : '<p class="hint">Press ★ on a line, or ★ Mark (key M) while listening, to collect the important moments. They go to the top of the Word minutes.</p>';
}

// ---- charts: talk time + who spoke when ----
function talkSegments() {
  const segs = [];
  for (const c of cues) {
    if (c.spk == null || c.spk < 0) continue;
    const last = segs[segs.length - 1];
    if (last && last.spk === c.spk && c.start - last.end < 1.5) last.end = c.end;
    else segs.push({ spk: c.spk, start: c.start, end: c.end });
  }
  return segs;
}
function chartData() {
  const n = spkCount();
  const st = speakerStats(cues, n);
  const total = st.reduce((t, s) => t + s.time, 0) || 1;
  const order = st.map((s, i) => ({ i, time: s.time, pct: s.time / total * 100, lines: s.lines })).filter((x) => x.lines).sort((a, b) => b.time - a.time);
  const end = Math.max(isFinite(video.duration) ? video.duration : 0, cues.length ? cues[cues.length - 1].end : 0) || 1;
  return { order, segs: talkSegments(), end, stars: cues.filter((c) => c.star).map((c) => c.start) };
}
function niceTicks(end) {
  const steps = [30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = steps.find((s) => end / s <= 6) || 3600;
  const t = []; for (let x = 0; x <= end + 0.01; x += step) t.push(x);
  return t;
}
function renderCharts() {
  const box = $('spkChart');
  if (!spkOn()) { box.hidden = true; box.innerHTML = ''; return; }
  const d = chartData();
  box.hidden = false;
  const bars = d.order.map((x) => `<div class="tt-row" data-tip="${esc(spkLabel(x.i))} · ${fmtClock(x.time)} · ${Math.round(x.pct)}% of the talking · ${x.lines} lines">
      <span class="tt-name">${esc(spkLabel(x.i))}</span>
      <span class="tt-track"><i style="width:${Math.max(1.5, x.pct)}%;background:${spkColor(x.i)}"></i></span>
      <span class="tt-val">${fmtClock(x.time)} · ${Math.round(x.pct)}%</span></div>`).join('');
  const lanes = d.order.map((x) => `<div class="tl-lane"><span class="tl-name">${esc(spkLabel(x.i))}</span><span class="tl-track">${
    d.segs.filter((g) => g.spk === x.i).map((g) => `<i data-t="${g.start}" style="left:${g.start / d.end * 100}%;width:max(2px, calc(${(g.end - g.start) / d.end * 100}% - 2px));background:${spkColor(x.i)}" data-tip="${esc(spkLabel(x.i))} · ${fmtClock(g.start)}–${fmtClock(g.end)}"></i>`).join('')}</span></div>`).join('');
  const starLane = d.stars.length ? `<div class="tl-lane tl-stars"><span class="tl-name">★</span><span class="tl-track">${d.stars.map((t) => `<b data-t="${t}" style="left:${t / d.end * 100}%" data-tip="Key moment · ${fmtClock(t)}">★</b>`).join('')}</span></div>` : '';
  const ticks = niceTicks(d.end).map((t) => `<span style="left:${t / d.end * 100}%">${fmtClock(t)}</span>`).join('');
  box.innerHTML = `<h3>Talk time</h3><div class="tt">${bars}</div>
    <h3>Who spoke when <span class="muted">– click to jump there</span></h3>
    <div class="tl">${starLane}${lanes}<div class="tl-axis"><span class="tl-name"></span><span class="tl-ticks">${ticks}</span></div><div class="tl-now" id="tlNow"></div></div>`;
  moveNow();
}
function moveNow() {
  const el = $('tlNow'), tr = document.querySelector('#spkChart .tl-track');
  if (!el || !tr) return;
  const d = Math.max(isFinite(video.duration) ? video.duration : 0, cues.length ? cues[cues.length - 1].end : 0) || 1;
  const box = el.parentElement.getBoundingClientRect(), r = tr.getBoundingClientRect();
  el.style.left = (r.left - box.left + r.width * Math.min(1, video.currentTime / d)) + 'px';
}
video.addEventListener('timeupdate', moveNow);
$('spkChart').addEventListener('click', (e) => {
  const t = e.target.closest('[data-t]');
  if (t) { video.currentTime = Number(t.dataset.t) + 0.001; return; }
  const tr = e.target.closest('.tl-track');
  if (tr) { const r = tr.getBoundingClientRect(); video.currentTime = (e.clientX - r.left) / r.width * chartData().end; }
});
// one tooltip for all charts
const vizTip = document.createElement('div'); vizTip.className = 'viz-tip'; vizTip.hidden = true; document.body.appendChild(vizTip);
$('spkChart').addEventListener('mousemove', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) { vizTip.hidden = true; return; }
  vizTip.textContent = t.dataset.tip; vizTip.hidden = false;
  const w = vizTip.offsetWidth;
  vizTip.style.left = Math.min(window.innerWidth - w - 8, e.clientX + 12) + 'px';
  vizTip.style.top = (e.clientY + 14) + 'px';
});
$('spkChart').addEventListener('mouseleave', () => (vizTip.hidden = true));

// The same charts drawn on a canvas for the Word file (light colours, 2x for sharp print).
function chartPng(lang) {
  const L = MINUTES_TEXT[lang] || MINUTES_TEXT.en;
  const d = chartData();
  const S = 2, W = 1000, rowH = 44, nameW = 220, valW = 170, pad = 16;
  const lanes = d.order.length + (d.stars.length ? 1 : 0);
  const H = pad + 34 + d.order.length * rowH + 30 + 34 + lanes * 34 + 36 + pad;
  const cv = document.createElement('canvas'); cv.width = W * S; cv.height = H * S;
  const g = cv.getContext('2d'); g.scale(S, S);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  const font = (w, px) => `${w} ${px}px "Segoe UI", Calibri, Arial, sans-serif`;
  const fit = (t, max) => { let s = t; while (g.measureText(s).width > max && s.length > 1) s = s.slice(0, -1); return s === t ? t : s.slice(0, -1) + '…'; };
  const rr = (x, y, w, h, r) => { r = Math.min(r, w / 2, h / 2); g.beginPath(); g.moveTo(x, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x, y + h); g.closePath(); g.fill(); };
  let y = pad;
  g.fillStyle = '#0b0b0b'; g.font = font(700, 22); g.textBaseline = 'middle';
  g.fillText(lang === 'vi' ? 'Thời gian nói của mỗi người' : 'Talk time', pad, y + 13); y += 34;
  const trackX = pad + nameW, trackW = W - pad * 2 - nameW - valW;
  for (const x of d.order) {
    g.font = font(600, 19); g.fillStyle = '#0b0b0b'; g.fillText(fit(spkLabel(x.i), nameW - 12), pad, y + rowH / 2);
    g.fillStyle = '#f0efec'; g.fillRect(trackX, y + 9, trackW, rowH - 18);
    g.fillStyle = spkColorPrint(x.i); rr(trackX, y + 9, Math.max(3, trackW * x.pct / 100), rowH - 18, 4);
    g.font = font(400, 18); g.fillStyle = '#52514e'; g.fillText(`${fmtClock(x.time)} · ${Math.round(x.pct)}%`, trackX + trackW + 12, y + rowH / 2);
    y += rowH;
  }
  y += 30;
  g.fillStyle = '#0b0b0b'; g.font = font(700, 22); g.fillText(lang === 'vi' ? 'Ai nói lúc nào' : 'Who spoke when', pad, y + 13); y += 34;
  const laneH = 34;
  const lane = (label, draw) => {
    g.font = font(600, 18); g.fillStyle = '#0b0b0b'; g.fillText(fit(label, nameW - 12), pad, y + laneH / 2);
    g.fillStyle = '#f6f5f2'; g.fillRect(trackX, y + 5, trackW, laneH - 10);
    draw(); y += laneH;
  };
  if (d.stars.length) lane('★', () => { g.fillStyle = '#b45309'; g.font = font(700, 18); d.stars.forEach((t) => g.fillText('★', trackX + trackW * t / d.end - 7, y + laneH / 2)); });
  for (const x of d.order) lane(spkLabel(x.i), () => {
    g.fillStyle = spkColorPrint(x.i);
    d.segs.filter((s) => s.spk === x.i).forEach((s) => g.fillRect(trackX + trackW * s.start / d.end, y + 5, Math.max(2, trackW * (s.end - s.start) / d.end - 1), laneH - 10));
  });
  g.font = font(400, 16); g.fillStyle = '#52514e'; g.textAlign = 'center';
  niceTicks(d.end).forEach((t) => { const x = trackX + trackW * t / d.end; g.fillRect(x, y, 1, 4); g.fillText(fmtClock(t), Math.min(W - pad - 24, Math.max(trackX + 18, x)), y + 20); });
  return new Promise((res, rej) => cv.toBlob(async (b) => { if (!b) return rej(new Error('chart')); res({ data: new Uint8Array(await b.arrayBuffer()), w: W, h: H }); }, 'image/png'));
}

// ---- events ----
$('spkBtn').onclick = findSpeakers;
$('spkDocx').onclick = saveMinutes;
$('vbBtn').onclick = () => { const why = limitReason({ speakers: true }, unlocked()); if (why) { openPro(why); return; } rememberVoices(false); };
$('vbList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-vb]');
  if (!b) return;
  const i = Number(b.dataset.vb);
  voiceBank = voiceBank.filter((_, k) => k !== i); saveBank();
});
$('starList').addEventListener('click', (e) => {
  const b = e.target.closest('.star-item');
  if (b) { const c = cues[Number(b.dataset.i)]; if (c) { video.currentTime = c.start + 0.001; setActive(Number(b.dataset.i)); } }
});
function toggleStar(i) {
  if (i < 0 || !cues[i]) return;
  const next = cues.map((c) => ({ ...c }));
  if (next[i].star) delete next[i].star; else next[i].star = true;
  commit(next);
  toast(next[i].star ? `★ Marked ${fmtClock(next[i].start)} as a key moment.` : 'Mark removed.');
}
function markNow() {
  if (!cues.length) { toast('Make the subtitle lines first – then mark the important moments.'); return; }
  let i = cueAt(cues, video.currentTime);
  if (i < 0) { i = 0; for (let k = 0; k < cues.length; k++) if (cues[k].start <= video.currentTime) i = k; }
  toggleStar(i);
}
$('markBtn').onclick = markNow;
darkQ.addEventListener && darkQ.addEventListener('change', () => renderList());
renderBank();
$('spkAdd').onclick = () => {
  const why = limitReason({ speakers: true }, unlocked());
  if (why) { openPro(why); return; }
  const n = spkCount();
  const names = spkNames.slice(); while (names.length < n + 1) names.push('');
  setNames(names);
};
$('spkList').addEventListener('input', (e) => {
  if (!e.target.matches('.spk-name')) return;
  const i = Number(e.target.closest('.spk-row').dataset.s);
  const names = spkNames.slice(); while (names.length <= i) names.push('');
  names[i] = e.target.value;
  spkNames = names;
  document.querySelectorAll('#cues select.spk').forEach((sel) => { const o = sel.querySelector(`option[value="${i}"]`); if (o) o.textContent = spkLabel(i); });
  autosave();
});
$('spkList').addEventListener('change', (e) => {
  if (e.target.matches('.spk-name')) {
    const i = Number(e.target.closest('.spk-row').dataset.s);
    document.querySelectorAll(`#spkList .spk-merge option[value="${i}"]`).forEach((o) => (o.textContent = spkLabel(i)));
    renderCharts(); renderStars();
    return;
  }
  if (!e.target.matches('.spk-merge') || e.target.value === '') return;
  const from = Number(e.target.closest('.spk-row').dataset.s), into = Number(e.target.value);
  mergeSpeaker(Math.max(from, into), Math.min(from, into));
  toast('Joined. Press Ctrl+Z to undo.');
});
$('spkList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-sa="hear"]');
  if (!b) return;
  const i = Number(b.closest('.spk-row').dataset.s);
  // the longest of this person's first few lines is the best sample
  const own = cues.map((c, k) => [c, k]).filter(([c]) => c.spk === i).slice(0, 8).sort((a, b2) => (b2[0].end - b2[0].start) - (a[0].end - a[0].start));
  if (!own.length) return;
  const c = own[0][0];
  video.currentTime = c.start + 0.001; video.play();
  clearTimeout(spkHear); spkHear = setTimeout(() => { if (video.currentTime >= c.end - 0.1) video.pause(); }, (c.end - c.start) * 1000 + 150);
});
let spkHear = 0;
$('cues').addEventListener('change', (e) => {
  if (!e.target.matches('select.spk')) return;
  const i = rowOf(e.target);
  if (i < 0) return;
  const why = limitReason({ speakers: true }, unlocked());
  if (why) { openPro(why); renderList(); return; }
  let v = e.target.value;
  if (v === 'new') {
    v = spkCount();
    const names = spkNames.slice(); while (names.length <= v) names.push('');
    spkNames = names;
  }
  const next = cues.map((c) => ({ ...c }));
  next[i].spk = Number(v);
  if (next[i].spk < 0) delete next[i].spk;
  commit(next);
  renderSpeakers();
});
$('lang').addEventListener('change', () => { renderSpeakers(); renderList(); });
// ---------- Record a meeting ----------
// Records the microphone (and, if wanted, the sound of a Zoom / Teams / Meet call playing on this computer).
// Pieces are stored in IndexedDB every few seconds, so a closed window or a crash never loses the meeting.
const REC_DB = 'captionpress-rec';
let rec = null; // { mr, ctx, streams, sid, chunks, t0, paused, pausedMs, pauseAt, timer, wake, mime }

function recDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(REC_DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('sessions', { keyPath: 'sid' });
      const ch = db.createObjectStore('chunks', { autoIncrement: true });
      ch.createIndex('sid', 'sid');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function recTx(stores, mode, fn) {
  const db = await recDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(tx)).then((v) => (out = v));
    tx.oncomplete = () => { db.close(); res(out); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
const idbAll = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
async function recSaveChunk(sid, blob) { try { await recTx(['chunks'], 'readwrite', (tx) => { tx.objectStore('chunks').add({ sid, blob }); }); } catch (_) {} }
async function recSessions() { try { return await recTx(['sessions'], 'readonly', (tx) => idbAll(tx.objectStore('sessions').getAll())); } catch (_) { return []; } }
async function recChunks(sid) { return recTx(['chunks'], 'readonly', (tx) => idbAll(tx.objectStore('chunks').index('sid').getAll(sid))); }
async function recForget(sid) {
  try {
    await recTx(['sessions', 'chunks'], 'readwrite', async (tx) => {
      tx.objectStore('sessions').delete(sid);
      const idx = tx.objectStore('chunks').index('sid');
      const keys = await idbAll(idx.getAllKeys(sid));
      keys.forEach((k) => tx.objectStore('chunks').delete(k));
    });
  } catch (_) {}
}

function recName(t) {
  const d = new Date(t), p = (x) => String(x).padStart(2, '0');
  return `Meeting ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
}
function recElapsed() {
  if (!rec) return 0;
  const now = rec.paused ? rec.pauseAt : performance.now();
  return (now - rec.t0 - rec.pausedMs) / 1000;
}
function recUi() {
  const on = !!rec;
  $('recSetup').hidden = on;
  $('recLive').hidden = !on;
  $('recStart').hidden = on;
  $('recPause').hidden = !on;
  $('recStop').hidden = !on;
  $('recCancel').textContent = on ? 'Discard' : 'Cancel';
  if (on) $('recPause').textContent = rec.paused ? '▶ Continue' : '⏸ Pause';
  $('recBadge').hidden = !on;
}
function openRecorder() {
  closeMenus();
  if (busy) { toast('Wait until the subtitles are finished.'); return; }
  $('recMsg').textContent = '';
  recUi();
  fillMics();
  $('recDialog').showModal();
}
async function fillMics() {
  try {
    const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const keep = $('recMic').value;
    $('recMic').innerHTML = '<option value="">Default microphone</option>' + list.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Microphone ' + (i + 1))}</option>`).join('');
    if (keep) $('recMic').value = keep;
  } catch (_) {}
}

async function startRec() {
  const withPc = $('recPc').checked;
  $('recMsg').textContent = '';
  const streams = [];
  try {
    const dev = $('recMic').value;
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: dev ? { exact: dev } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    streams.push(mic);
    fillMics();
  } catch (e) {
    $('recMsg').textContent = 'CaptionPress could not use the microphone. Allow microphone access for CaptionPress in Windows Settings → Privacy & security → Microphone, then try again.';
    return;
  }
  if (withPc) {
    try {
      const scr = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false }, systemAudio: 'include' });
      scr.getVideoTracks().forEach((t) => t.stop());
      if (!scr.getAudioTracks().length) {
        $('recMsg').textContent = 'No computer sound was shared. Recording the microphone only. To include the call, choose “Entire screen” and switch on “Share system audio”.';
      } else streams.push(scr);
    } catch (_) {
      $('recMsg').textContent = 'Sharing the computer sound was cancelled. Recording the microphone only.';
    }
  }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = ctx.createMediaStreamDestination();
  const an = ctx.createAnalyser(); an.fftSize = 1024;
  streams.forEach((s) => { const src = ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks())); src.connect(dest); src.connect(an); });
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  const mr = new MediaRecorder(dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
  const sid = 'r' + Date.now();
  rec = { mr, ctx, an, streams, sid, chunks: [], t0: performance.now(), paused: false, pausedMs: 0, pauseAt: 0, mime: mr.mimeType || mime || 'audio/webm', started: Date.now() };
  try { await recTx(['sessions'], 'readwrite', (tx) => { tx.objectStore('sessions').put({ sid, started: rec.started, mime: rec.mime, pc: streams.length > 1 }); }); } catch (_) {}
  mr.ondataavailable = (e) => { if (e.data && e.data.size) { rec && rec.chunks.push(e.data); recSaveChunk(sid, e.data); } };
  mr.start(5000);
  streams.forEach((s) => s.getAudioTracks().forEach((t) => t.addEventListener('ended', () => { if (rec && s !== streams[0]) $('recMsg').textContent = 'The computer sound stopped being shared. The microphone is still recording.'; })));
  try { rec.wake = await navigator.wakeLock.request('screen'); } catch (_) {}
  const buf = new Uint8Array(an.fftSize);
  rec.timer = setInterval(() => {
    if (!rec) return;
    $('recTime').textContent = fmtClock(recElapsed());
    an.getByteTimeDomainData(buf);
    let peak = 0; for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
    $('recLevel').style.width = Math.min(100, peak / 128 * 140) + '%';
    $('recSrc').textContent = streams.length > 1 ? '🎙 Microphone + 🔊 computer sound' : '🎙 Microphone';
  }, 120);
  recUi();
}
function pauseRec() {
  if (!rec) return;
  if (rec.paused) { rec.mr.resume(); rec.pausedMs += performance.now() - rec.pauseAt; rec.paused = false; }
  else { rec.mr.pause(); rec.pauseAt = performance.now(); rec.paused = true; }
  recUi();
}
function stopTracks(r) {
  clearInterval(r.timer);
  r.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  try { r.ctx.close(); } catch (_) {}
  try { r.wake && r.wake.release(); } catch (_) {}
}
async function stopRec(discard) {
  const r = rec;
  if (!r) { $('recDialog').close(); return; }
  if (discard && !confirmDiscard()) return;
  await new Promise((res) => { r.mr.onstop = res; try { r.mr.state !== 'inactive' ? r.mr.stop() : res(); } catch (_) { res(); } });
  stopTracks(r);
  rec = null;
  recUi();
  $('recDialog').close();
  if (discard) { recForget(r.sid); toast('Recording discarded.'); return; }
  await useRecording(r.chunks, r.mime, r.started, r.sid);
}
let discardArmed = 0;
function confirmDiscard() {
  if (Date.now() - discardArmed < 4000) return true;
  discardArmed = Date.now();
  $('recMsg').textContent = 'Press Discard again to throw this recording away.';
  return false;
}
async function useRecording(chunks, mime, started, sid) {
  if (!chunks.length) { toast('Nothing was recorded.'); recForget(sid); return; }
  const ext = /ogg/.test(mime) ? 'ogg' : /mp4/.test(mime) ? 'm4a' : 'webm';
  const f = new File(chunks, `${recName(started)}.${ext}`, { type: mime.split(';')[0], lastModified: started });
  download(f.name, f);
  openFile(f);
  await recForget(sid);
  toast('Recording saved to your Downloads folder and opened. Press ✨ Create subtitles to write it down.', 7000);
}

async function checkUnfinished() {
  const list = await recSessions();
  if (!list.length || rec) return;
  const s = list.sort((a, b) => b.started - a.started)[0];
  let chunks = [];
  try { chunks = (await recChunks(s.sid)).map((c) => c.blob); } catch (_) {}
  if (!chunks.length) { recForget(s.sid); return; }
  const box = $('recFound');
  box.hidden = false;
  box.querySelector('span').textContent = `An unfinished recording from ${new Date(s.started).toLocaleString()} was kept safe.`;
  box.querySelector('[data-r="open"]').onclick = () => { box.hidden = true; useRecording(chunks, s.mime, s.started, s.sid); };
  box.querySelector('[data-r="del"]').onclick = () => { box.hidden = true; recForget(s.sid); toast('Deleted.'); };
}

$('recBtn').onclick = $('dropRec').onclick = openRecorder;
$('recStart').onclick = startRec;
$('recPause').onclick = pauseRec;
$('recStop').onclick = () => stopRec(false);
$('recCancel').onclick = () => stopRec(true);
$('recBadge').onclick = () => { if (!$('recDialog').open) $('recDialog').showModal(); };
$('recDialog').addEventListener('cancel', (e) => { if (rec) { e.preventDefault(); $('recDialog').close(); toast('Still recording – press ● REC at the top to see it.'); } });
$('recHide').onclick = () => { $('recDialog').close(); if (rec) toast('Still recording – press ● REC at the top to see it or stop.'); };
window.addEventListener('beforeunload', (e) => { if (rec) { e.preventDefault(); e.returnValue = ''; } });
if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) { $('recPcRow').hidden = true; }
checkUnfinished();
// ---------- start ----------
initStyle();
setPro(isPro);
updateGenUI();
renderList();
checkPro().then(() => setPro(isPro));
if ('serviceWorker' in navigator) {
  // New versions: the service worker installs the update in the background; switch to it right away when nothing is open,
  // otherwise offer a restart so an update never needs two app restarts to show up.
  const hadSW = !!navigator.serviceWorker.controller;
  let swReloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadSW || swReloading) return;
    if (!file && !busy && !rec && !cues.length) { swReloading = true; location.reload(); return; }
    const b = document.createElement('div');
    b.className = 'toast update-bar';
    b.innerHTML = '✨ A new version of CaptionPress is ready. <button class="primary small">Restart now</button>';
    b.querySelector('button').onclick = () => { swReloading = true; location.reload(); };
    document.body.appendChild(b);
  });
  navigator.serviceWorker.register('sw.js').then((r) => { r.update().catch(() => {}); }).catch(() => {});
}
