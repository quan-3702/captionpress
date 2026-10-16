const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FREE_MINUTES = 10;
const STORE_BILLING = 'https://store.microsoft.com/billing';
const PRO_SKU = 'captionpress_pro';
const PRO_IDS = [PRO_SKU];
let STORE_URL = 'https://apps.microsoft.com/detail/9P8M0CKNNJPM';
let proAvailable = false; // Pro limits apply only when the Store actually sells the add-on
let proSku = PRO_SKU;
let isPro = false;
try { isPro = localStorage.getItem('captionpress-pro') === '1'; } catch (_) {}
const unlocked = () => isPro || !proAvailable;

async function billing() {
  if (!('getDigitalGoodsService' in window)) return null;
  try { return await window.getDigitalGoodsService(STORE_BILLING); } catch (_) { return null; }
}
function setPro(v) {
  isPro = v;
  try { localStorage.setItem('captionpress-pro', v ? '1' : '0'); } catch (_) {}
  const b = $('proBtn');
  b.textContent = v ? '★ Pro' : '★ Get Pro';
  b.classList.toggle('is-pro', v);
  b.hidden = !proAvailable && !v;
  document.body.classList.toggle('unlocked', unlocked());
  if (typeof renderAll === 'function') renderAll();
}
async function checkPro() {
  const svc = await billing();
  if (!svc) return false;
  try {
    const details = await svc.getDetails(PRO_IDS).catch(() => []);
    proAvailable = details.length > 0;
    if (details[0]) { proSku = details[0].itemId; if (!PRO_IDS.includes(proSku)) PRO_IDS.push(proSku); }
    const list = await svc.listPurchases();
    const owned = list.some((p) => PRO_IDS.includes(p.itemId));
    setPro(owned);
    return owned;
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
    try {
      const [d] = await svc.getDetails([proSku]);
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
  if (await checkPro()) { proMessage('Thank you! Pro is unlocked. ★'); setTimeout(() => $('proDialog').close(), 1500); }
}
function needsPro(reason) {
  if (unlocked()) return false;
  openPro(reason);
  return true;
}

// ---------- CaptionPress core: pure functions (no DOM) ----------
const SR = 16000; // Whisper sample rate

const MODELS = {
  fast: { id: 'onnx-community/whisper-tiny', name: 'Fast', size: '≈ 80 MB', pro: false },
  accurate: { id: 'onnx-community/whisper-base', name: 'Accurate', size: '≈ 150 MB', pro: true },
  best: { id: 'onnx-community/whisper-small', name: 'Best', size: '≈ 500 MB', pro: true },
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

// Sort, remove empties, make sure every cue has a sensible length and none overlap.
function tidy(cues) {
  const list = cues
    .filter((c) => c && isFinite(c.start) && isFinite(c.end) && cleanText(c.text))
    .map((c) => ({ start: Math.max(0, c.start), end: Math.max(0, c.end), text: String(c.text).trim() }))
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
    out.push({ start: s.start, end: s.end, text: t });
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
function toSRT(cues) {
  return cues.map((c, i) => `${i + 1}\n${fmtTime(c.start, ',')} --> ${fmtTime(c.end, ',')}\n${c.text}\n`).join('\n');
}
function toVTT(cues) {
  return 'WEBVTT\n\n' + cues.map((c) => `${fmtTime(c.start, '.')} --> ${fmtTime(c.end, '.')}\n${c.text}\n`).join('\n');
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
  const t = c.start + (c.end - c.start) * (a.length / (a.length + b.length));
  const out = cues.slice();
  out.splice(i, 1, { start: c.start, end: round3(t), text: wrapText(a) }, { start: round3(t), end: c.end, text: wrapText(b) });
  return out;
}
function mergeCue(cues, i) {
  if (i < 0 || i >= cues.length - 1) return cues;
  const a = cues[i], b = cues[i + 1];
  const out = cues.slice();
  out.splice(i, 2, { start: a.start, end: b.end, text: wrapText(a.text.replace(/\n/g, ' ') + ' ' + b.text.replace(/\n/g, ' ')) });
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

// ---- Pro rules ----
function limitReason(opts, pro) {
  if (pro) return '';
  if (opts.model && MODELS[opts.model] && MODELS[opts.model].pro) return `The ${MODELS[opts.model].name} quality setting is part of CaptionPress Pro.`;
  if (opts.task === 'translate') return 'Translating speech into English subtitles is part of CaptionPress Pro.';
  if (opts.burn) return 'Saving a video with the captions burned in is part of CaptionPress Pro.';
  if (opts.voice) return 'AI voice-over – reading your subtitles aloud and saving the video or audio – is part of CaptionPress Pro.';
  return '';
}

if (typeof module !== 'undefined') module.exports = {
  SR, MODELS, LANGS, fmtTime, fmtShort, fmtClock, parseTime, cleanText, wrapText, splitText, segmentsToCues, tidy,
  filterSegments, chunksToSegments, rms, quietPoint, planWindows, isSilent, toSRT, toVTT, toTXT, toTXTStamped,
  parseSubs, cueAt, VOICES, SAMPLE_LINE, langOfVoice, planVoice, splitCue, mergeCue, shiftCues, replaceAll, rewrapAll, limitReason,
};
// ---------- CaptionPress UI ----------
let file = null, fileUrl = '', cues = [], hist = [], fut = [], active = -1, busy = false;
let style = { size: 5, pos: 'bottom', color: '#ffffff', bg: 'box', chars: 42 };
let opts = { lang: '', model: 'fast', task: 'transcribe' };
try { Object.assign(style, JSON.parse(localStorage.getItem('cp-style') || '{}')); } catch (_) {}
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
    try { cues.length ? localStorage.setItem(k, JSON.stringify({ cues, t: Date.now() })) : localStorage.removeItem(k); } catch (_) {}
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
  return `<div class="cue${i === active ? ' on' : ''}" data-i="${i}">
    <span class="num">${i + 1}</span>
    <div class="meta">
      <input class="t" data-k="start" value="${fmtShort(c.start)}" aria-label="Start time" title="Start time">
      <span class="muted">→</span>
      <input class="t" data-k="end" value="${fmtShort(c.end)}" aria-label="End time" title="End time">
      <span class="dur">${(c.end - c.start).toFixed(1)}s</span>
      ${w ? `<span class="warn" title="${w}">⚠</span>` : ''}
      <span class="acts">
        <button data-a="play" title="Play this line">▶</button>
        <button data-a="setStart" title="Set start to the current video time">⇤</button>
        <button data-a="setEnd" title="Set end to the current video time">⇥</button>
        <button data-a="split" title="Split into two lines at the cursor">✂</button>
        <button data-a="merge" title="Join with the next line">⤓</button>
        <button data-a="del" title="Delete this line">✕</button>
      </span>
    </div>
    <textarea rows="${Math.max(1, c.text.split('\n').length)}" spellcheck="true" aria-label="Subtitle text ${i + 1}">${esc(c.text)}</textarea>
  </div>`;
}
function renderList() {
  const box = $('cues');
  const keep = box.scrollTop;
  box.innerHTML = cues.map(rowHtml).join('');
  box.scrollTop = keep;
}
function rowOf(el) { const r = el.closest('.cue'); return r ? Number(r.dataset.i) : -1; }

let editSnap = null;
$('cues').addEventListener('focusin', (e) => {
  if (e.target.matches('textarea, .t')) editSnap = snapshot();
});
$('cues').addEventListener('input', (e) => {
  const i = rowOf(e.target);
  if (i < 0 || !e.target.matches('textarea')) return;
  cues[i].text = e.target.value;
  e.target.rows = Math.max(1, e.target.value.split('\n').length);
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
  const span = $('cap').querySelector('span');
  const h = $('frame').clientHeight || 360, w = $('frame').clientWidth || 640;
  $('cap').style.fontSize = (capBase(w, h) * style.size / 100) + 'px';
  $('cap').classList.toggle('top', style.pos === 'top');
  if (!span) return;
  span.style.color = style.color;
  span.style.background = style.bg === 'box' ? 'rgba(0,0,0,.72)' : 'transparent';
  span.style.textShadow = style.bg === 'shadow'
    ? '0 0 .12em #000, 0 0 .12em #000, .06em .06em 0 #000, -.06em -.06em 0 #000, .06em -.06em 0 #000, -.06em .06em 0 #000'
    : (style.bg === 'none' ? '0 1px 3px rgba(0,0,0,.6)' : 'none');
}
function renderCap() {
  const i = cueAt(cues, video.currentTime || 0);
  const c = cues[i];
  $('cap').innerHTML = c ? `<span>${esc(c.text)}</span>` : '';
  capCss();
  setActive(i);
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
video.addEventListener('click', () => (video.paused ? video.play() : video.pause()));
video.addEventListener('loadedmetadata', () => {
  const ar = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
  $('frame').style.aspectRatio = String(ar);
  frameAR = ar; fitFrame();
  updateGenUI(); tick();
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
  if (!isMedia(f)) { toast('Please choose a video or audio file.'); return; }
  if (busy) cancelGen();
  file = f;
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = URL.createObjectURL(f);
  video.src = fileUrl;
  $('fileName').textContent = f.name;
  $('drop').hidden = true; $('player').hidden = false; fitFrame();
  hist = []; fut = []; active = -1;
  cues = [];
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey()) || 'null');
    if (saved && Array.isArray(saved.cues) && saved.cues.length) { cues = tidy(saved.cues); toast('Your subtitle lines for this file were restored from last time.'); }
  } catch (_) {}
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
    if (m.type === 'progress') { onLoadProgress(m.p); return; }
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
    try { samples = await decodeAudio(file); }
    catch (_) { throw new Error('CaptionPress could not read the sound in this file. Try an MP4, MOV, WEBM, MP3, M4A or WAV file.'); }
    if (cancelled) return;
    const total = samples.length / SR;
    const maxSec = unlocked() ? total : Math.min(total, FREE_MINUTES * 60);
    const windows = planWindows(samples, maxSec);
    setProg(4, 'Getting the AI ready…');
    const ready = await call({ type: 'load', model: MODELS[opts.model].id }, 'load');
    if (cancelled) return;
    let found = [];
    const startList = cues.length ? cues : [];
    let done = 0;
    const tStart = performance.now();
    for (const w of windows) {
      if (cancelled) return;
      if (!isSilent(samples, w)) {
        const slice = samples.slice(Math.round(w.start * SR), Math.round(w.end * SR));
        const id = ++jobId;
        const res = await call({ type: 'run', id, audio: slice, language: opts.lang, task: opts.task }, id, [slice.buffer]);
        if (cancelled) return;
        const segs = filterSegments(chunksToSegments(res.chunks, w.start, w.end));
        found = tidy(found.concat(segmentsToCues(segs, style.chars)));
        cues = startList.length ? tidy(startList.filter((c) => c.end <= windows[0].start || c.start >= maxSec).concat(found)) : found;
        renderList(); renderCap(); updateButtons();
      }
      done = w.end;
      const spent = (performance.now() - tStart) / 1000;
      const left = done > 0 ? spent / done * (maxSec - done) : 0;
      setProg(5 + 95 * done / maxSec, `Listening… ${fmtClock(done)} of ${fmtClock(maxSec)}${left > 20 ? ` · about ${Math.ceil(left / 60)} min left` : ''}${ready.device === 'wasm' ? ' (slower mode – no graphics acceleration)' : ''}`);
    }
    hist.push(before); fut = []; genBefore = null;
    autosave(); updateButtons();
    const secs = Math.round((performance.now() - t0) / 1000);
    setProg(100, `Done – ${cues.length} lines in ${fmtClock(secs)}. Check the words, then save.`);
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
  if (!busy && !$('genHint').querySelector('a')) $('genHint').textContent = hint;
  updateButtons();
}
function renderAll() { updateGenUI(); }
$('lang').innerHTML = LANGS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
['lang', 'model', 'task'].forEach((id) => $(id).addEventListener('change', (e) => {
  const key = id === 'lang' ? 'lang' : id;
  opts[key] = e.target.value;
  const why = limitReason({ model: opts.model, task: opts.task }, unlocked());
  if (why) { openPro(why); if (id === 'model') opts.model = 'fast'; if (id === 'task') opts.task = 'transcribe'; updateGenUI(); }
  try { localStorage.setItem('cp-opts', JSON.stringify(opts)); } catch (_) {}
}));

// ---------- style ----------
function initStyle() {
  $('stSize').value = style.size; $('stPos').value = style.pos; $('stColor').value = style.color; $('stBg').value = style.bg; $('stChars').value = String(style.chars);
}
['stSize', 'stPos', 'stColor', 'stBg', 'stChars'].forEach((id) => $(id).addEventListener('input', () => {
  const oldChars = style.chars;
  style = { size: Number($('stSize').value), pos: $('stPos').value, color: $('stColor').value, bg: $('stBg').value, chars: Number($('stChars').value) };
  try { localStorage.setItem('cp-style', JSON.stringify(style)); } catch (_) {}
  if (style.chars !== oldChars && cues.length) { commit(rewrapAll(cues, style.chars)); toast('Lines re-wrapped. Ctrl+Z to undo.'); }
  renderCap();
}));

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
  if (x === 'txts') download(baseName() + ' transcript.txt', toTXTStamped(cues));
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

// ---------- burn-in ----------
function drawCaption(ctx, text, W, H) {
  if (!text) return;
  const px = Math.round(capBase(W, H) * style.size / 100);
  ctx.font = `600 ${px}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = text.split('\n');
  const lh = px * 1.35;
  const blockH = lh * lines.length;
  const top = style.pos === 'top' ? H * 0.07 : H * 0.93 - blockH;
  lines.forEach((ln, k) => {
    const y = top + lh * k + lh / 2;
    const w = ctx.measureText(ln).width;
    if (style.bg === 'box') {
      ctx.fillStyle = 'rgba(0,0,0,.72)';
      ctx.fillRect(W / 2 - w / 2 - px * 0.35, y - lh / 2, w + px * 0.7, lh);
    }
    if (style.bg === 'shadow') {
      ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, px * 0.16); ctx.strokeStyle = '#000';
      ctx.strokeText(ln, W / 2, y);
    }
    if (style.bg === 'none') { ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = px * 0.12; }
    ctx.fillStyle = style.color;
    ctx.fillText(ln, W / 2, y);
    ctx.shadowBlur = 0;
  });
}
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
    const i = cueAt(cues, v.currentTime);
    if (i >= 0 && showCaps) drawCaption(ctx, cues[i].text, W, H);
    const d = v.duration || 1;
    $('burnBar').style.width = (v.currentTime / d * 100) + '%';
    $('burnText').textContent = `Recording… ${fmtClock(v.currentTime)} of ${fmtClock(d)}. Keep this window open.`;
  };
  let timer = 0;
  const loop = () => { draw(); if (!v.ended && !burn.stop) { if (hasPic && v.requestVideoFrameCallback) v.requestVideoFrameCallback(loop); } };
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
  if (typing) return;
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }
  else if (e.code === 'Space' && file) { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (e.key === 'ArrowLeft' && file) video.currentTime = Math.max(0, video.currentTime - 2);
  else if (e.key === 'ArrowRight' && file) video.currentTime += 2;
});
window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); const k = storeKey(); if (k && cues.length) try { localStorage.setItem(k, JSON.stringify({ cues, t: Date.now() })); } catch (_) {} });

// ---------- Pro ----------
$('proBtn').onclick = () => { if (!isPro) openPro(); };
$('buyBtn').onclick = buyPro;
$('restoreBtn').onclick = async () => { proMessage((await checkPro()) ? 'Pro is unlocked. ★' : 'No Pro purchase was found on this Microsoft account.'); };
$('closePro').onclick = () => $('proDialog').close();

// ---------- start ----------
initStyle();
setPro(isPro);
updateGenUI();
renderList();
checkPro().then(() => setPro(isPro));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
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
