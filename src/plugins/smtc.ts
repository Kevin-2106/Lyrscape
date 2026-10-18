import type { Plugin } from '../kernel/host';
import type { Store } from '../kernel/store';
import type { AppState, LyricDocument, MediaSessionInfo, PlaybackSnapshot, Timeline } from '../sdk/types';
import { desktop, native, onEvent } from '../platform';
import { debugJournal } from './debug';
import { fetchCandidate, normalize, searchLyrics, type LyricCandidate, type LyricProvider, type TrackQuery } from './lyrics-online';
import { normalizeConfig } from './management';
import { SMTC_ADAPTER, smtcFields } from './manifests';
import { parseLyrics } from './parsers';

// Windows System Media Transport Controls as a playback source: the native side
// polls the media session (src-tauri/src/smtc.rs) and emits `smtc-state`; this
// plugin turns it into track + playback, and finds lyrics online for the track
// (lyrics-online.ts). Lookups only run while SMTC is the selected source. Like
// the AMLL adapter, the overlay runs a background instance that takes over
// while the control window is closed.

export interface SmtcAdapter {
  snapshot(): PlaybackSnapshot & Pick<AppState, 'media'>;
  /** undefined follows Windows' current session. */
  selectSession(source?: string): Promise<void>;
  /** Searches again, ignoring the cache. */
  research(): Promise<void>;
  /** Shows the lyrics of one of the listed candidates and remembers the choice for this track. */
  choose(key: string): Promise<void>;
}

interface NativeState {
  available: boolean; source: string; sessions: string[];
  title: string; artist: string; album: string; albumArtist: string;
  durationMs?: number | null; positionMs: number; updatedAtEpochMs?: number | null;
  playing: boolean; status: string; rate: number; error?: string | null;
}
interface CacheEntry { at: number; text?: string; synced?: boolean; result?: LyricCandidate; candidates: LyricCandidate[]; pinned?: boolean }

const emptyLyrics: LyricDocument = { timingMode: 'none', lines: [] };
const CACHE_KEY = 'lyrscape.lyrics-cache.v1', CACHE_SIZE = 60, MISS_TTL = 6 * 3600_000, DEBOUNCE_MS = 700;

function readCache(): Record<string, CacheEntry> {
  try { const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
function writeCache(key: string, entry: CacheEntry) {
  try {
    const cache = readCache();
    cache[key] = entry;
    const keys = Object.keys(cache).sort((a, b) => cache[b].at - cache[a].at);
    for (const old of keys.slice(CACHE_SIZE)) delete cache[old];
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch { /* a full or unavailable storage only loses the cache */ }
}

/** Moves every time in the document by `offset` ms (positive shows lyrics later). */
export function shiftLyrics(doc: LyricDocument, offset: number): LyricDocument {
  if (!offset || doc.timingMode === 'none') return doc;
  const at = (ms: number | undefined) => ms === undefined ? undefined : Math.max(0, ms + offset);
  return { ...doc, lines: doc.lines.map(line => ({ ...line, startMs: at(line.startMs), endMs: at(line.endMs),
    words: line.words?.map(word => ({ ...word, startMs: at(word.startMs)!, endMs: at(word.endMs)! })) })) };
}

export function smtcPlugin(store: Store<AppState>, background = false): Plugin {
  return {
    id: SMTC_ADAPTER, requires: ['timeline@1'],
    async activate(ctx) {
      const time = ctx.service<Timeline>('timeline@1');
      let active = true, ownsControl = !background, polling = false;
      ctx.own(() => { active = false; });
      const blank = (title = '没有正在播放的媒体'): PlaybackSnapshot => ({
        lyrics: emptyLyrics, track: { title, artists: [] },
        playback: { positionMs: 0, playing: false, observedAtMonoMs: performance.now(), rate: 1 },
      });
      let session = blank(desktop ? '正在读取系统媒体' : 'SMTC 需要 Windows 桌面版');
      let media: MediaSessionInfo = { available: false, source: '', sessions: [], status: 'closed', lookup: { state: 'idle', candidates: [] } };
      let last: NativeState | undefined, trackKey = '', lookedUp = '', token = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let baseLyrics: LyricDocument = emptyLyrics, appliedOffset = 0;
      const config = () => normalizeConfig(smtcFields, store.get().plugins.configs[SMTC_ADAPTER]);
      const selected = () => store.get().adapterId === 'smtc';
      const apply = () => { if (ownsControl) store.update(s => s.adapterId === 'smtc' ? { ...s, ...session, media } : s); };
      const log = (kind: string, summary: string, detail?: unknown) => { if (ownsControl) debugJournal.record('smtc', kind, summary, detail); };

      const setLyrics = (doc: LyricDocument) => {
        baseLyrics = doc; appliedOffset = Number(config().offset);
        session = { ...session, lyrics: shiftLyrics(doc, appliedOffset) };
      };
      const toDocument = (text: string, synced: boolean, candidate: LyricCandidate) => {
        const doc = parseLyrics(text, synced ? `${candidate.provider}.lrc` : `${candidate.provider}.txt`);
        return synced ? doc : { ...doc, timingMode: 'none' as const };
      };
      const query = (): TrackQuery | undefined => last && last.title ? { title: last.title, artist: last.artist || last.albumArtist, album: last.album || undefined, durationMs: last.durationMs ?? undefined } : undefined;
      const providers = () => String(config().providers).split(',') as LyricProvider[];
      const cacheKey = (q: TrackQuery) => [normalize(q.title, true), normalize(q.artist, true), q.durationMs ? Math.round(q.durationMs / 2000) : '', providers().join('+'), config().translation ? 't' : ''].join('|');
      const http = (url: string) => native<string>('lyrics_http_get', { url });

      async function lookup(force = false) {
        clearTimeout(timer); timer = undefined;
        const q = query();
        if (!q || !ownsControl || !selected() || !desktop) return;
        const key = trackKey, mine = ++token, ck = cacheKey(q);
        lookedUp = key;
        const cached = readCache()[ck];
        if (!force && cached && (cached.text || Date.now() - cached.at < MISS_TTL)) {
          if (cached.text && cached.result) setLyrics(toDocument(cached.text, Boolean(cached.synced), cached.result));
          media = { ...media, lookup: { state: cached.text ? 'found' : 'none', result: cached.result, candidates: cached.candidates ?? [], cached: true, message: cached.text ? undefined : '没有找到匹配的歌词（缓存）' } };
          log('cache', `${cached.text ? '命中缓存' : '缓存：无结果'} ${q.title} — ${q.artist}`, { query: q, result: cached.result });
          apply(); return;
        }
        media = { ...media, lookup: { state: 'searching', candidates: [] } }; apply();
        log('search', `搜索 ${q.title} — ${q.artist}${q.durationMs ? ` (${Math.round(q.durationMs / 1000)} s)` : ''}`, { query: q, providers: providers() });
        try {
          const outcome = await searchLyrics(q, { providers: providers(), translation: Boolean(config().translation), http, log: (message, detail) => log('candidates', message, detail) });
          if (mine !== token || key !== trackKey || !active) return;
          if (outcome.result) {
            const { candidate, text, synced } = outcome.result;
            setLyrics(toDocument(text, synced, candidate));
            media = { ...media, lookup: { state: 'found', result: candidate, candidates: outcome.candidates, message: synced ? undefined : '只有不带时间的歌词' } };
            writeCache(ck, { at: Date.now(), text, synced, result: candidate, candidates: outcome.candidates });
            log('found', `${candidate.key} · ${candidate.title} — ${candidate.artists.join(' / ')} · 匹配度 ${candidate.score}${synced ? '' : ' · 无时间'}`, { candidate, errors: outcome.errors, text });
          } else {
            const failed = outcome.errors.length && !outcome.candidates.length;
            media = { ...media, lookup: { state: failed ? 'error' : 'none', candidates: outcome.candidates, message: failed ? outcome.errors.join('；') : '没有找到匹配的歌词' } };
            if (!failed) writeCache(ck, { at: Date.now(), candidates: outcome.candidates });
            log(failed ? 'error' : 'none', failed ? `搜索失败：${outcome.errors.join('；')}` : `没有匹配：${q.title}`, outcome);
          }
        } catch (cause) {
          if (mine !== token) return;
          const message = cause instanceof Error ? cause.message : String(cause);
          media = { ...media, lookup: { state: 'error', candidates: [], message } };
          log('error', `搜索失败：${message}`);
        }
        apply();
      }
      const scheduleLookup = () => {
        if (lookedUp === trackKey || !ownsControl || !selected()) return;
        clearTimeout(timer);
        // Players publish title, then duration a moment later; wait for both.
        timer = setTimeout(() => void lookup(), DEBOUNCE_MS);
      };
      ctx.own(() => clearTimeout(timer));

      const receive = (raw: NativeState) => {
        if (!active) return;
        const previous = last; last = raw;
        media = { ...media, available: raw.available, source: raw.source, sessions: raw.sessions ?? [], status: raw.status || 'closed', error: raw.error ?? undefined };
        const key = raw.available && raw.title ? [raw.source, raw.title, raw.artist, raw.album].join('\u0000') : '';
        if (previous?.title !== raw.title || previous?.source !== raw.source || previous?.playing !== raw.playing || previous?.error !== raw.error) {
          log(raw.error ? 'error' : raw.status || 'state', raw.error ? `读取失败：${raw.error}` : raw.available ? `${raw.status} · ${raw.title || '（无标题）'}${raw.artist ? ` — ${raw.artist}` : ''} · ${raw.source}` : '没有媒体会话', raw);
        }
        if (!key) {
          token++; trackKey = ''; lookedUp = ''; baseLyrics = emptyLyrics;
          session = blank(raw.available ? '没有曲目信息' : '没有正在播放的媒体');
          media = { ...media, lookup: { state: 'idle', candidates: [] } };
          apply(); return;
        }
        const now = performance.now();
        const changedTrack = key !== trackKey;
        if (changedTrack) {
          token++; trackKey = key; lookedUp = ''; baseLyrics = emptyLyrics;
          session = { ...session, lyrics: emptyLyrics };
          media = { ...media, lookup: { state: 'idle', candidates: [] } };
        }
        const rate = raw.rate > 0 ? raw.rate : 1;
        const sampled = changedTrack || !previous || previous.positionMs !== raw.positionMs || previous.updatedAtEpochMs !== raw.updatedAtEpochMs;
        let playback: AppState['playback'];
        if (sampled) {
          // The timeline was sampled at LastUpdatedTime; the shared timeline extrapolates from there.
          const age = raw.updatedAtEpochMs ? Math.min(Math.max(0, Date.now() - raw.updatedAtEpochMs), 24 * 3600_000) : 0;
          playback = { positionMs: raw.positionMs, playing: raw.playing, rate, observedAtMonoMs: now - age };
        } else {
          // Play / pause without a new timeline sample: continue from where the extrapolation is now.
          const position = time.position({ ...store.get(), ...session, adapterId: 'smtc' }, now);
          playback = { positionMs: position, playing: raw.playing, rate, observedAtMonoMs: now };
        }
        session = { ...session, playback, track: { title: raw.title, artists: raw.artist ? [raw.artist] : raw.albumArtist ? [raw.albumArtist] : [], durationMs: raw.durationMs ?? undefined } };
        apply();
        scheduleLookup();
      };

      const sync = async () => {
        if (!desktop || !active) return;
        const want = ownsControl && selected();
        if (want === polling) return;
        polling = want;
        if (want) { const state = await native<NativeState | null>('smtc_start'); if (state) receive(state); scheduleLookup(); }
        else if (!background) await native('smtc_stop');
      };
      let lastOffset = Number(config().offset), lastAdapter = store.get().adapterId;
      ctx.own(store.subscribe(state => {
        if (state.adapterId !== lastAdapter) { lastAdapter = state.adapterId; void sync().catch(console.error); if (state.adapterId === 'smtc') scheduleLookup(); }
        const offset = Number(normalizeConfig(smtcFields, state.plugins.configs[SMTC_ADAPTER]).offset);
        if (offset !== lastOffset && baseLyrics.lines.length) { lastOffset = offset; setLyrics(baseLyrics); apply(); }
        else lastOffset = offset;
      }));

      if (desktop) {
        ctx.own(await onEvent<NativeState>('smtc-state', receive));
        if (background) ctx.own(await onEvent<boolean>('control-presence', present => {
          ownsControl = !present; polling = false;
          if (ownsControl) { void sync().catch(console.error); apply(); }
        }));
        if (background) ownsControl = !(await native<{ controlActive: boolean }>('session_restore')).controlActive;
        const latest = await native<NativeState | null>('smtc_snapshot');
        if (latest) receive(latest);
        await sync();
      }
      ctx.own(() => { if (desktop && !background && polling) return native('smtc_stop').catch(console.error); });

      const adapter: SmtcAdapter = {
        snapshot: () => ({ ...session, media }),
        async selectSession(source) {
          media = { ...media, selected: source };
          await native('smtc_select', { source: source ?? null });
          log('select', source ? `读取会话 ${source}` : '跟随系统当前会话');
          apply();
        },
        research: () => lookup(true),
        async choose(key) {
          const q = query();
          const candidate = media.lookup.candidates.find(c => c.key === key);
          if (!q || !candidate) throw Error('候选歌词已失效，请重新搜索');
          const mine = ++token, current = trackKey;
          media = { ...media, lookup: { ...media.lookup, state: 'searching' } }; apply();
          try {
            const result = await fetchCandidate(candidate, { http, translation: Boolean(config().translation) });
            if (mine !== token || current !== trackKey) return;
            if (!result) { media = { ...media, lookup: { ...media.lookup, state: 'found', message: `${candidate.title} 没有歌词` } }; apply(); return; }
            setLyrics(toDocument(result.text, result.synced, result.candidate));
            media = { ...media, lookup: { ...media.lookup, state: 'found', result: result.candidate, message: result.synced ? undefined : '只有不带时间的歌词', cached: false } };
            writeCache(cacheKey(q), { at: Date.now(), text: result.text, synced: result.synced, result: result.candidate, candidates: media.lookup.candidates, pinned: true });
            log('chosen', `手动选择 ${candidate.key} · ${candidate.title}`, result.candidate);
          } catch (cause) {
            media = { ...media, lookup: { ...media.lookup, state: 'error', message: cause instanceof Error ? cause.message : String(cause) } };
          }
          apply();
        },
      };
      ctx.provide('adapter.smtc@1', adapter);
    },
  };
}
