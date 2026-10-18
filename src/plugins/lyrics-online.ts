// Online lyric search for a track known only by its metadata (SMTC title,
// artist, album, duration). Providers: LRCLIB (open, synced LRC) and NetEase
// Cloud Music (wide CJK coverage, separate translation lyrics). Candidates from
// all enabled providers are scored on title, artist and duration; the best one
// with lyrics wins. HTTP is injected so this module stays pure and testable.

import type { OnlineLyricCandidate } from '../sdk/types';

export type LyricProvider = OnlineLyricCandidate['provider'];
export interface TrackQuery { title: string; artist: string; album?: string; durationMs?: number }
export type LyricCandidate = OnlineLyricCandidate;
export interface LyricResult { candidate: LyricCandidate; text: string; synced: boolean }
export interface SearchOutcome { result?: LyricResult; candidates: LyricCandidate[]; errors: string[] }
export type HttpGet = (url: string) => Promise<string>;

const LRCLIB = 'https://lrclib.net/api', NETEASE = 'https://music.163.com/api';
const enc = encodeURIComponent;

// ---------- Matching ----------

/** Lowercase, width-folded, without brackets' contents, punctuation and spaces. */
export function normalize(text: string, keepBrackets = false): string {
  let value = text.normalize('NFKC').toLowerCase();
  if (!keepBrackets) value = value.replace(/[(（[【「『<].*?[)）\]】」』>]/g, ' ').replace(/\s[-–—]\s.*$/, ' ').replace(/\b(feat|ft)\.?\s.*$/, ' ');
  return value.replace(/[\s\p{P}\p{S}]+/gu, '');
}
const bigrams = (text: string) => { const out = new Map<string, number>(); for (let i = 0; i < text.length - 1; i++) { const g = text.slice(i, i + 2); out.set(g, (out.get(g) ?? 0) + 1); } return out; };
/** 0..1 similarity of two normalized strings (equal 1, containment 0.85, else bigram Dice). */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85 * Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.15;
  if (a.length < 2 || b.length < 2) return 0;
  const x = bigrams(a), y = bigrams(b);
  let shared = 0;
  for (const [g, n] of x) shared += Math.min(n, y.get(g) ?? 0);
  return (2 * shared) / (a.length - 1 + b.length - 1);
}
const splitArtists = (text: string) => text.split(/\s*(?:,|，|、|\/|&|;|；|\bfeat\.?|\bft\.?|\bx\b|×)\s*/i).map(s => normalize(s, true)).filter(Boolean);

/** Scores a candidate against the query; 0 rejects it outright (very different duration or title). */
export function score(query: TrackQuery, candidate: Omit<LyricCandidate, 'score' | 'key'>): number {
  const title = Math.max(similarity(normalize(query.title), normalize(candidate.title)), similarity(normalize(query.title, true), normalize(candidate.title, true)));
  if (title < 0.45) return 0;
  const wanted = splitArtists(query.artist), got = candidate.artists.flatMap(splitArtists);
  const artist = !wanted.length ? 0.5 : !got.length ? 0.3 : Math.max(...wanted.map(w => Math.max(...got.map(g => similarity(w, g)))));
  let total = title * 0.6 + artist * 0.3, weight = 0.9;
  if (query.durationMs && candidate.durationMs) {
    const diff = Math.abs(query.durationMs - candidate.durationMs) / 1000;
    if (diff > 15) return 0;
    total += 0.25 * (diff <= 2 ? 1 : diff <= 5 ? 0.75 : diff <= 10 ? 0.35 : 0); weight += 0.25;
  }
  return Math.round((total / weight + (candidate.synced ? 0.05 : 0)) * 1000) / 1000;
}

// ---------- LRC helpers ----------

const STAMP = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
const CREDIT = /^\s*(作词|作曲|编曲|制作人|制作|混音|母带|和声|伴唱|吉他|贝斯|鼓|键盘|弦乐|录音|监制|出品|发行|企划|OP|SP|Lyrics?|Lyricist|Composer|Arranger|Producer|Mix(?:ing)?|Master(?:ing)?)\s*[:：]/i;
const formatStamp = (ms: number) => `[${String(Math.floor(ms / 60000)).padStart(2, '0')}:${(ms % 60000 / 1000).toFixed(2).padStart(5, '0')}]`;
/** Time-stamped lines of an LRC text as (ms, text), in order; metadata tags are skipped. */
export function lrcLines(text: string): { ms: number; text: string }[] {
  const out: { ms: number; text: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(STAMP)];
    if (!stamps.length) continue;
    const body = raw.slice(stamps[stamps.length - 1].index! + stamps[stamps.length - 1][0].length);
    for (const stamp of stamps) out.push({ ms: Math.round((Number(stamp[1]) * 60 + Number(stamp[2].replace(':', '.'))) * 1000), text: body.trim() });
  }
  return out.sort((a, b) => a.ms - b.ms);
}
const isSynced = (text: string) => lrcLines(text).some(line => line.ms > 0 && line.text);

/**
 * NetEase lyric + translation → one bilingual LRC: each translated line follows
 * its original with the identical timestamp (read back by the LRC parser as a
 * translation). Credit lines (作词 / 作曲 …) are dropped.
 */
export function mergeTranslation(original: string, translation = ''): string {
  const lines = lrcLines(original).filter(line => !CREDIT.test(line.text));
  const translated = lrcLines(translation).filter(line => line.text && !CREDIT.test(line.text));
  const out: string[] = [];
  let j = 0;
  for (const line of lines) {
    out.push(`${formatStamp(line.ms)}${line.text}`);
    while (j < translated.length && translated[j].ms < line.ms - 30) j++;
    const match = translated[j];
    if (line.text && match && Math.abs(match.ms - line.ms) <= 30 && match.text !== line.text) { out.push(`${formatStamp(line.ms)}${match.text}`); j++; }
  }
  return out.join('\n');
}

// ---------- Providers ----------

interface LrclibRecord { id: number; trackName: string; artistName: string; albumName?: string; duration?: number; instrumental?: boolean; plainLyrics?: string | null; syncedLyrics?: string | null }
const lrclibCandidate = (r: LrclibRecord) => ({ provider: 'lrclib' as const, id: String(r.id), title: r.trackName, artists: [r.artistName], album: r.albumName,
  durationMs: r.duration ? Math.round(r.duration * 1000) : undefined, synced: Boolean(r.syncedLyrics), text: r.syncedLyrics || r.plainLyrics || '' });

async function lrclib(query: TrackQuery, http: HttpGet) {
  const records = new Map<number, LrclibRecord>();
  const add = (list: unknown) => { for (const r of Array.isArray(list) ? list : list ? [list] : []) if (r && typeof r === 'object' && typeof (r as LrclibRecord).id === 'number') records.set((r as LrclibRecord).id, r as LrclibRecord); };
  if (query.artist && query.durationMs) {
    await http(`${LRCLIB}/get?track_name=${enc(query.title)}&artist_name=${enc(query.artist)}${query.album ? `&album_name=${enc(query.album)}` : ''}&duration=${Math.round(query.durationMs / 1000)}`)
      .then(body => add(JSON.parse(body))).catch(() => { /* 404 when there is no exact match */ });
  }
  if (!records.size) add(JSON.parse(await http(`${LRCLIB}/search?track_name=${enc(query.title)}${query.artist ? `&artist_name=${enc(query.artist)}` : ''}`)));
  if (!records.size) add(JSON.parse(await http(`${LRCLIB}/search?q=${enc(`${query.title} ${query.artist}`.trim())}`)));
  return [...records.values()].filter(r => !r.instrumental).map(lrclibCandidate);
}

interface NeteaseSong { id: number; name: string; artists?: { name: string }[]; album?: { name: string }; duration?: number }
async function netease(query: TrackQuery, http: HttpGet) {
  const body = JSON.parse(await http(`${NETEASE}/search/get/web?s=${enc(`${query.title} ${query.artist}`.trim())}&type=1&limit=10`));
  const songs: NeteaseSong[] = Array.isArray(body?.result?.songs) ? body.result.songs : [];
  return songs.map(song => ({ provider: 'netease' as const, id: String(song.id), title: song.name, artists: (song.artists ?? []).map(a => a.name), album: song.album?.name,
    durationMs: song.duration, synced: undefined as boolean | undefined, text: undefined as string | undefined }));
}
async function neteaseLyrics(id: string, http: HttpGet, translation: boolean): Promise<string> {
  const body = JSON.parse(await http(`${NETEASE}/song/lyric?id=${enc(id)}&lv=1&tv=${translation ? 1 : 0}`));
  if (body?.nolyric || body?.uncollected) return '';
  return mergeTranslation(String(body?.lrc?.lyric ?? ''), translation ? String(body?.tlyric?.lyric ?? '') : '');
}

export interface SearchOptions { providers: LyricProvider[]; translation: boolean; http: HttpGet; minScore?: number; log?: (message: string, detail?: unknown) => void }
type Found = Omit<LyricCandidate, 'score' | 'key'> & { id: string; text?: string };
const keyOf = (c: { provider: LyricProvider; id: string }) => `${c.provider}:${c.id}`;

/** Searches every provider, ranks candidates and fetches lyrics for the best ones until one has text. */
export async function searchLyrics(query: TrackQuery, options: SearchOptions): Promise<SearchOutcome> {
  const errors: string[] = [];
  const found: Found[] = [];
  await Promise.all(options.providers.map(async provider => {
    try { found.push(...await (provider === 'lrclib' ? lrclib : netease)(query, options.http)); }
    catch (error) { errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`); }
  }));
  // The first provider is the preferred one: a small bonus lets it win near-ties.
  const prefer = (c: Found) => options.providers.length > 1 && c.provider === options.providers[0] ? 0.04 : 0;
  // `rank` orders (with the bonuses); the shown `score` stays within 0..1.
  const ranked = found.map(c => { const s = score(query, c); return { ...c, key: keyOf(c), rank: s && s + prefer(c), score: Math.min(1, s) }; }).filter(c => c.rank > 0)
    .sort((a, b) => b.rank - a.rank || options.providers.indexOf(a.provider) - options.providers.indexOf(b.provider));
  const candidates: LyricCandidate[] = ranked.slice(0, 12).map(({ text: _text, id: _id, rank: _rank, ...c }) => c);
  options.log?.(`${found.length} 个结果，${ranked.length} 个匹配`, { query, candidates });
  // The best match with time-synced lyrics wins; plain text only when no good match has timing.
  let plain: LyricResult | undefined;
  for (const candidate of ranked.filter(c => c.rank >= (options.minScore ?? 0.6)).slice(0, 5)) {
    if (plain && candidate.synced === false) continue;
    const result = await fetchCandidate(candidate, options).catch(error => { errors.push(`${candidate.key}: ${error instanceof Error ? error.message : String(error)}`); return undefined; });
    if (result?.synced) return { result: strip(result), candidates, errors };
    plain ??= result;
  }
  return { result: plain && strip(plain), candidates, errors };
}

const strip = (result: LyricResult): LyricResult => {
  const { text: _text, id: _id, rank: _rank, ...candidate } = result.candidate as LyricCandidate & { text?: string; id?: string; rank?: number };
  return { ...result, candidate };
};

/** Lyrics of one candidate (used for the best match and for a manual pick). */
export async function fetchCandidate(candidate: LyricCandidate & { id?: string; text?: string }, options: Pick<SearchOptions, 'http' | 'translation'>): Promise<LyricResult | undefined> {
  const id = candidate.id ?? candidate.key.slice(candidate.key.indexOf(':') + 1);
  let text = candidate.text;
  if (text === undefined) {
    text = candidate.provider === 'netease' ? await neteaseLyrics(id, options.http, options.translation)
      : lrclibCandidate(JSON.parse(await options.http(`${LRCLIB}/get/${enc(id)}`)) as LrclibRecord).text;
  }
  if (!text.trim()) return undefined;
  const synced = isSynced(text);
  return { candidate: { ...candidate, synced }, text, synced };
}
