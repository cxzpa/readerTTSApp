// Text loading and splitting: turns a .txt file into paragraphs and
// short, speakable chunks (usually one sentence each).

/** Decode a .txt file, guessing the encoding (UTF-8, UTF-16 or Windows-1252). */
export function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start));
  } catch {
    // Old Spanish .txt files are often Latin-1 / Windows-1252.
    return new TextDecoder('windows-1252').decode(bytes.subarray(start));
  }
}

/** Very small language guess, used only to pick a default voice. */
export function detectLang(text) {
  const sample = text.slice(0, 20000).toLowerCase();
  const count = (words) => words.reduce((n, w) => n + (sample.match(new RegExp(`\\b${w}\\b`, 'g'))?.length || 0), 0);
  const es = count(['el', 'la', 'que', 'de', 'y', 'los', 'las', 'una', 'por', 'con', 'para', 'pero', 'como', 'más']);
  const en = count(['the', 'and', 'that', 'of', 'to', 'is', 'was', 'with', 'for', 'but', 'his', 'her', 'you', 'not']);
  const pt = count(['não', 'uma', 'com', 'os', 'as', 'você', 'ele', 'ela', 'mas', 'muito']);
  const fr = count(['le', 'les', 'et', 'est', 'une', 'dans', 'pas', 'pour', 'qui', 'mais']);
  const best = Object.entries({ es, en, pt, fr }).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : 'es';
}

const DIALOG_START = /^[—–\-―«"“'‘]/;
const SENTENCE_END = /[.!?…:;»”"')\]]$/;

/** Split raw text into paragraphs, re-joining lines that were hard-wrapped. */
export function splitParagraphs(raw) {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f­﻿]/g, '');
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());

  // A file is hard-wrapped when its lines share a typical width AND most of
  // them end mid-sentence. Files with one paragraph per line end lines with
  // punctuation instead, so they are left alone.
  const nonEmpty = lines.filter(Boolean);
  const lengths = nonEmpty.map((l) => l.length).sort((a, b) => a - b);
  const wrap = lengths.length ? lengths[Math.floor(lengths.length * 0.9)] : 0;
  const midSentence = nonEmpty.filter((l) => !SENTENCE_END.test(l)).length / (nonEmpty.length || 1);
  const hardWrapped = wrap > 30 && wrap <= 150 && midSentence > 0.5;

  const paragraphs = [];
  let current = '';
  let prevLen = 0;
  for (const line of lines) {
    if (!line) {
      if (current) paragraphs.push(current);
      current = '';
      prevLen = 0;
      continue;
    }
    const continues =
      current &&
      hardWrapped &&
      prevLen >= wrap * 0.7 &&
      !DIALOG_START.test(line) &&
      // A line that ends a sentence well short of the margin ends the paragraph.
      !(SENTENCE_END.test(current) && prevLen < wrap * 0.85);
    if (continues) {
      current = current.endsWith('-') && /[a-záéíóúñü]$/i.test(current.slice(0, -1))
        ? current.slice(0, -1) + line // word split by hyphen at line end
        : `${current} ${line}`;
    } else {
      if (current) paragraphs.push(current);
      current = line;
    }
    prevLen = line.length;
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

const MAX_CHUNK = 260;

function splitSentences(paragraph, lang) {
  let parts;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter(lang, { granularity: 'sentence' });
    parts = Array.from(seg.segment(paragraph), (s) => s.segment);
  } else {
    parts = paragraph.match(/[^.!?…]*[.!?…]+["'»”’)\]]*\s*|[^.!?…]+$/g) || [paragraph];
    if (parts.join('') !== paragraph) parts = [paragraph]; // never lose text
  }
  // Merge fragments that are too short to speak on their own ("—", "1.", etc.).
  const merged = [];
  for (const p of parts) {
    if (merged.length && (p.trim().length < 4 || merged[merged.length - 1].trim().length < 4)) {
      merged[merged.length - 1] += p;
    } else merged.push(p);
  }
  return merged.flatMap(splitLong);
}

/**
 * Split a very long sentence so TTS engines handle it well: at a comma or
 * semicolon near the middle, else at a space, else (no spaces at all) every
 * MAX_CHUNK characters.
 *
 * Works on index ranges with an explicit stack (no recursion, so a huge
 * paragraph can't overflow the call stack), and finds punctuation cuts with
 * a binary search over positions found once, so it stays fast on very long
 * text. It produces the same pieces as the original recursive version.
 */
function splitLong(sentence) {
  const len = sentence.length;
  if (len <= MAX_CHUNK) return [sentence];

  // Every possible punctuation cut, as the index right after "<punct><space>".
  const cuts = [];
  const re = /[;:,—)]\s/g;
  let m;
  while ((m = re.exec(sentence))) cuts.push(m.index + 2);

  const out = [];
  const stack = [[0, len]];
  while (stack.length) {
    const [start, end] = stack.pop();
    const size = end - start;
    if (size <= MAX_CHUNK) {
      out.push(sentence.slice(start, end));
      continue;
    }
    let cut = punctuationCut(cuts, start, end);
    if (cut < 0) {
      // Never pick a trailing space: cutting after it would leave the text unchanged.
      // Last space within the allowed window (searching only that window keeps it fast).
      let space = start + Math.min(MAX_CHUNK, size - 2);
      while (space >= start + 40 && sentence.charCodeAt(space) !== 32) space--;
      cut = space >= start + 40 ? space + 1 : start + MAX_CHUNK;
      // Don't cut an emoji (or other surrogate pair) in half.
      if (cut === start + MAX_CHUNK && isLowSurrogate(sentence.charCodeAt(cut))) cut--;
    }
    // Safety net: both parts must be non-empty.
    if (cut <= start || cut >= end) cut = start + Math.min(MAX_CHUNK, size - 1);
    stack.push([cut, end], [start, cut]); // left part is processed first
  }
  return out;
}

/** The punctuation cut closest to the middle, at least 40 chars from each end (-1 if none). */
function punctuationCut(cuts, start, end) {
  const lo = start + 40; // exclusive bounds
  const hi = end - 40;
  const mid = start + (end - start) / 2;
  // First cut position greater than mid.
  let a = 0;
  let b = cuts.length;
  while (a < b) {
    const c = (a + b) >> 1;
    if (cuts[c] <= mid) a = c + 1;
    else b = c;
  }
  const left = a - 1 >= 0 && cuts[a - 1] > lo && cuts[a - 1] < hi ? cuts[a - 1] : -1;
  const right = a < cuts.length && cuts[a] > lo && cuts[a] < hi ? cuts[a] : -1;
  if (left < 0) return right;
  if (right < 0) return left;
  return mid - left <= right - mid ? left : right; // ties go to the earlier one, as before
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Parse a book into paragraphs and chunks.
 * Each chunk keeps its exact text so the reader can show and highlight it.
 * @returns {{ paragraphs: number[][], chunks: {p:number, text:string}[] }}
 */
export function parseBook(raw, lang = 'es') {
  const paras = splitParagraphs(raw);
  const chunks = [];
  const paragraphs = [];
  paras.forEach((para, p) => {
    const ids = [];
    for (const s of splitSentences(para, lang)) {
      if (!s.trim()) {
        if (chunks.length && chunks[chunks.length - 1].p === p) chunks[chunks.length - 1].text += s;
        continue;
      }
      ids.push(chunks.length);
      chunks.push({ p, text: s });
    }
    if (ids.length) paragraphs.push(ids);
  });
  // Re-number paragraphs so empty ones don't leave gaps.
  paragraphs.forEach((ids, p) => ids.forEach((i) => (chunks[i].p = p)));
  return { paragraphs, chunks };
}

/** Text that is actually sent to the voice (no decorative symbols). */
export function speakable(text) {
  return text
    .replace(/[*_#=~|<>[\]{}]+/g, ' ')
    .replace(/[-—–_.·•]{3,}/g, (m) => (/^\.+$/.test(m) ? '...' : ' ')) // separator lines
    .replace(/\.{4,}/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Short title from a file name. */
export function titleFromFileName(name) {
  const t = name.replace(/\.txt$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t[0].toLocaleUpperCase() + t.slice(1) : 'Sin título';
}
