import type { LyricDocument, LyricLine } from '../../sdk/types';

export const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeOutCubic = (t: number) => 1 - (1 - clamp01(t)) ** 3;
export const easeInCubic = (t: number) => clamp01(t) ** 3;
export const easeInOutSine = (t: number) => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * clamp01(t)));
/** Overshooting settle; exact at both ends so holds stay perfectly still. */
export const easeOutBack = (t: number, k = 1.9) => {
  const x = clamp01(t) - 1;
  return 1 + (k + 1) * x * x * x + k * x * x;
};

/** Stable 32-bit hash; all "random" PV motion is seeded so seek and pause replay exactly. */
export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const graphemeSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;
const wordSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter('ja', { granularity: 'word' }) : undefined;

export function graphemes(text: string): string[] {
  if (!graphemeSegmenter) return Array.from(text);
  return Array.from(graphemeSegmenter.segment(text), item => item.segment);
}
/** Grapheme indices where a new word starts (index 0 excluded). */
export function wordStarts(text: string): Set<number> {
  const starts = new Set<number>();
  if (!wordSegmenter) return starts;
  let index = 0;
  for (const item of wordSegmenter.segment(text)) {
    if (index > 0) starts.add(index);
    index += graphemes(item.segment).length;
  }
  return starts;
}

export const isHan = (glyph: string) => /\p{Script=Han}/u.test(glyph);
export const isKana = (glyph: string) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(glyph);
export const isSpace = (glyph: string) => /^\s+$/u.test(glyph);
/** Glyphs that close a phrase; a break after them reads naturally. */
const closing = /^[\s、。，．,.!！?？…‥）)」』】〉》”’~〜ー・:：;；]$/u;
const opening = /^[（(「『【〈《“‘]$/u;
const smallKana = /^[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]$/u;
const hiragana = (glyph: string) => /\p{Script=Hiragana}/u.test(glyph);
/**
 * Approximates Japanese phrase (bunsetsu) boundaries: a content word (kanji /
 * katakana) after hiragana starts a phrase; hiragana after kanji is okurigana or
 * a particle and must stay attached (夜明けの鐘が｜鳴るまで, not 鐘｜が).
 */
function breakPenalty(before: string, at: string, wordStart: boolean): number {
  if (closing.test(before)) return 0;
  if (isSpace(at)) return 0.02;
  if (hiragana(before) && (isHan(at) || /\p{Script=Katakana}/u.test(at))) return 0.05;
  if (isHan(before) && hiragana(at)) return 0.9;
  return wordStart ? 0.25 : 0.5;
}

/**
 * Splits glyphs into `rows` balanced visual rows. Breaks prefer phrase punctuation,
 * then spaces, then word boundaries, then any grapheme, nearest to equal width.
 */
export function breakRows(glyphs: string[], rows: number, advance: (index: number) => number, starts = new Set<number>()): number[] {
  if (rows <= 1 || glyphs.length < 2) return [];
  const prefix = [0];
  for (let i = 0; i < glyphs.length; i++) prefix.push(prefix[i] + advance(i));
  const total = prefix[glyphs.length];
  const breaks: number[] = [];
  let from = 1;
  for (let r = 1; r < rows; r++) {
    const target = total * r / rows;
    let best = -1, bestScore = Infinity;
    for (let i = from; i < glyphs.length - (rows - r - 1); i++) {
      const before = glyphs[i - 1], at = glyphs[i];
      if (opening.test(before) || closing.test(at) && !isSpace(at) || smallKana.test(at)) continue;
      const penalty = breakPenalty(before, at, starts.has(i));
      const score = Math.abs(prefix[i] - target) / Math.max(1, total) + penalty;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) break;
    breaks.push(best); from = best + 1;
  }
  return breaks;
}
export function splitAt<T>(items: T[], breaks: number[]): T[][] {
  const result: T[][] = [];
  let from = 0;
  for (const index of [...breaks, items.length]) { result.push(items.slice(from, index)); from = index; }
  return result;
}

/**
 * A source boundary is a visual transition cue, never an invented word time.
 * Returns undefined when the line has no known end. A result at or before the
 * start means the line never shows: zero-length lines (credits such as 作词 timed
 * 0 → 0) and lines superseded by a later foreground line with the same start,
 * matching activeLine, which also picks the last of simultaneous lines.
 */
export function lineBoundary(lines: LyricLine[], index: number): number | undefined {
  const current = lines[index];
  if (!current || current.startMs === undefined) return undefined;
  if (current.endMs !== undefined && current.endMs <= current.startMs) return current.startMs;
  let end = current.endMs;
  for (let i = index + 1; i < lines.length; i++) {
    const next = lines[i];
    if (next.isBackground || next.startMs === undefined || next.startMs < current.startMs) continue;
    end = end === undefined ? next.startMs : Math.min(end, next.startMs); break;
  }
  return end;
}

const normalized = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const repeatCache = new WeakMap<LyricDocument, Map<string, number>>();
/** Chorus lines repeat; PVs give them the large hero treatment and keep verses as captions. */
export function repeatCount(doc: LyricDocument, text: string): number {
  let counts = repeatCache.get(doc);
  if (!counts) {
    counts = new Map();
    for (const line of doc.lines) {
      if (line.isBackground) continue;
      const key = normalized(line.text);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    repeatCache.set(doc, counts);
  }
  return counts.get(normalized(text)) ?? 0;
}

/** Edit-distance similarity, so a chorus repeat with one changed word still matches. */
function similar(a: string[], b: string[]): boolean {
  if (a.join('') === b.join('')) return true;
  const longest = Math.max(a.length, b.length);
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > longest * 0.4) return false;
  // Cheap bound first: edit similarity cannot exceed the shared-glyph ratio.
  const pool = new Map<string, number>();
  for (const glyph of a) pool.set(glyph, (pool.get(glyph) ?? 0) + 1);
  let shared = 0;
  for (const glyph of b) { const left = pool.get(glyph); if (left) { shared++; pool.set(glyph, left - 1); } }
  if (shared / longest < 0.6) return false;
  const limit = Math.floor(longest * 0.4);
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      next.push(Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
      best = Math.min(best, next[j]);
    }
    if (best > limit) return false;
    row = next;
  }
  return row[b.length] <= limit;
}

const SECTION_LINES = 400;
const sectionCache = new WeakMap<LyricDocument, Set<number> | null>();
/**
 * Chorus detection by block rather than by line: finds runs of at least two
 * consecutive foreground lines that recur elsewhere in the song (fuzzily, at most
 * one non-matching line inside a run), marks every occurrence of the run, then
 * fills single one-off lines sandwiched between chorus lines. Returns indices into
 * `doc.lines`, or null when the song has no repeated block (callers fall back to
 * the per-line rule).
 */
export function chorusLines(doc: LyricDocument): Set<number> | null {
  if (sectionCache.has(doc)) return sectionCache.get(doc)!;
  const index: number[] = [], keys: string[][] = [];
  doc.lines.forEach((line, i) => {
    const key = normalized(line.text);
    if (line.isBackground || !key) return;
    index.push(i); keys.push(graphemes(key).slice(0, 32));
  });
  const n = Math.min(index.length, SECTION_LINES);
  const memo = new Map<number, boolean>();
  const same = (p: number, q: number) => {
    const id = p * n + q;
    let value = memo.get(id);
    if (value === undefined) { value = similar(keys[p], keys[q]); memo.set(id, value); }
    return value;
  };
  const marked = new Array<boolean>(n).fill(false);
  let found = false;
  for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
    // Only start at the head of a diagonal run; continuations were covered already.
    if (!same(p, q) || p > 0 && same(p - 1, q - 1)) continue;
    let length = 1, matched = 1;
    for (let k = 1; p + k < q && q + k < n; k++) {
      if (same(p + k, q + k)) { matched++; length = k + 1; continue; }
      // Tolerate one changed line if the run resumes right after it.
      if (p + k + 1 < q && q + k + 1 < n && same(p + k + 1, q + k + 1)) continue;
      break;
    }
    if (matched < 2) continue;
    found = true;
    for (let k = 0; k < length; k++) { marked[p + k] = true; marked[q + k] = true; }
  }
  if (!found) { sectionCache.set(doc, null); return null; }
  const result = new Set<number>();
  for (let p = 0; p < n; p++) {
    if (marked[p] || p > 0 && p < n - 1 && marked[p - 1] && marked[p + 1]) result.add(index[p]);
  }
  sectionCache.set(doc, result);
  return result;
}
