import { describe, expect, it } from 'vitest';
import { parseLyrics } from '../src/plugins/parsers';
import { mergeTranslation, normalize, score, searchLyrics, similarity } from '../src/plugins/lyrics-online';

const lrclibRecord = (id: number, trackName: string, artistName: string, duration: number, synced = true) => ({
  id, trackName, artistName, albumName: 'Album', duration, instrumental: false,
  plainLyrics: 'line one\nline two', syncedLyrics: synced ? '[00:01.00]line one\n[00:03.00]line two' : null,
});

describe('online lyric matching', () => {
  it('normalizes titles: width, brackets, feat and punctuation', () => {
    expect(normalize('夜に駆ける (TV Size)')).toBe('夜に駆ける');
    expect(normalize('Ｈｅａｖｅｎｌｙ Ｍｅ')).toBe('heavenlyme');
    expect(normalize('Song - Remastered 2011')).toBe('song');
    expect(normalize('Song feat. Someone')).toBe('song');
    expect(similarity('heavenlyme', 'heavenlyme')).toBe(1);
    expect(similarity('abc', 'xyz')).toBe(0);
  });

  it('scores title, artist and duration; rejects far durations and other titles', () => {
    const query = { title: '夜に駆ける', artist: 'YOASOBI', durationMs: 261000 };
    const exact = score(query, { provider: 'netease', title: '夜に駆ける', artists: ['YOASOBI'], durationMs: 261013 });
    const live = score(query, { provider: 'netease', title: '夜に駆ける (Live)', artists: ['YOASOBI'], durationMs: 268000 });
    const cover = score(query, { provider: 'netease', title: '夜に駆ける', artists: ['Someone Else'], durationMs: 262000 });
    expect(exact).toBeGreaterThan(0.95);
    expect(live).toBeLessThan(exact);
    expect(cover).toBeLessThan(exact);
    expect(score(query, { provider: 'lrclib', title: '夜に駆ける', artists: ['YOASOBI'], durationMs: 300000 })).toBe(0);
    expect(score(query, { provider: 'lrclib', title: 'アイドル', artists: ['YOASOBI'], durationMs: 261000 })).toBe(0);
    // Multi-artist strings from SMTC match any credited artist.
    expect(score({ title: 'Song', artist: 'A, B' }, { provider: 'lrclib', title: 'Song', artists: ['B'] })).toBeGreaterThan(0.9);
  });

  it('merges NetEase translation as same-timestamp lines that parse as translations, dropping credits', () => {
    const lrc = '[00:00.000] 作词 : Ayase\n[00:01.430]沈むように\n[00:08.831]二人だけの\n[00:12.000]';
    const trans = '[by:someone]\n[00:01.43]像是要沉没一样\n[00:08.83]只属于两人的';
    const merged = mergeTranslation(lrc, trans);
    expect(merged).toBe('[00:01.43]沈むように\n[00:01.43]像是要沉没一样\n[00:08.83]二人だけの\n[00:08.83]只属于两人的\n[00:12.00]');
    const doc = parseLyrics(merged, 'x.lrc');
    expect(doc.lines.map(l => [l.text, l.translation])).toEqual([['沈むように', '像是要沉没一样'], ['二人だけの', '只属于两人的'], ['', undefined]]);
  });

  it('searches providers, picks the best synced match and keeps the ranked list', async () => {
    const calls: string[] = [];
    const http = async (url: string) => {
      calls.push(url);
      if (url.includes('lrclib.net/api/get?')) throw Error('404');
      if (url.includes('lrclib.net/api/search')) return JSON.stringify([lrclibRecord(1, 'Other', 'X', 200), lrclibRecord(2, 'Heavenly Me', 'AIYUE', 191.3)]);
      if (url.includes('/search/get/web')) return JSON.stringify({ result: { songs: [{ id: 9, name: 'Heavenly Me', artists: [{ name: 'AIYUE' }], duration: 191000 }] } });
      if (url.includes('/song/lyric?id=9')) return JSON.stringify({ lrc: { lyric: '[00:01.00]網易\n' }, tlyric: { lyric: '' } });
      throw Error(`unexpected ${url}`);
    };
    const outcome = await searchLyrics({ title: 'Heavenly Me', artist: 'AIYUE', durationMs: 191000 }, { providers: ['lrclib', 'netease'], translation: true, http });
    expect(outcome.result?.candidate.key).toBe('lrclib:2');
    expect(outcome.result?.synced).toBe(true);
    expect(outcome.candidates.map(c => c.key)).toEqual(['lrclib:2', 'netease:9']);
    expect(outcome.errors).toEqual([]);
    expect(calls.some(url => url.includes('/song/lyric'))).toBe(false); // LRCLIB already carried the text
  });

  it('falls through to the next candidate without lyrics and reports provider errors', async () => {
    const http = async (url: string) => {
      if (url.includes('lrclib.net')) throw Error('offline');
      if (url.includes('/search/get/web')) return JSON.stringify({ result: { songs: [
        { id: 1, name: 'Song', artists: [{ name: 'A' }], duration: 200000 }, { id: 2, name: 'Song', artists: [{ name: 'A' }], duration: 201000 }] } });
      if (url.includes('id=1')) return JSON.stringify({ nolyric: true });
      if (url.includes('id=2')) return JSON.stringify({ lrc: { lyric: '[00:01.00]hello' } });
      throw Error(url);
    };
    const outcome = await searchLyrics({ title: 'Song', artist: 'A', durationMs: 200000 }, { providers: ['lrclib', 'netease'], translation: false, http });
    expect(outcome.result?.candidate.key).toBe('netease:2');
    expect(outcome.errors[0]).toContain('lrclib: offline');
  });

  it('prefers a synced match over a better-ranked plain-text one, and keeps scores within 1', async () => {
    const http = async (url: string) => {
      if (url.includes('lrclib.net/api/get?')) return JSON.stringify(lrclibRecord(5, 'Song', 'A', 200, false));
      if (url.includes('/search/get/web')) return JSON.stringify({ result: { songs: [{ id: 3, name: 'Song', artists: [{ name: 'A' }], duration: 201000 }] } });
      if (url.includes('/song/lyric?id=3')) return JSON.stringify({ lrc: { lyric: '[00:01.00]timed' } });
      throw Error(url);
    };
    const outcome = await searchLyrics({ title: 'Song', artist: 'A', durationMs: 200000 }, { providers: ['lrclib', 'netease'], translation: false, http });
    expect(outcome.candidates[0].key).toBe('lrclib:5');
    expect(outcome.result?.candidate.key).toBe('netease:3');
    expect(outcome.result?.synced).toBe(true);
    expect(outcome.result?.candidate).not.toHaveProperty('text');
    expect(Math.max(...outcome.candidates.map(c => c.score))).toBeLessThanOrEqual(1);

    const plainOnly = await searchLyrics({ title: 'Song', artist: 'A', durationMs: 200000 }, { providers: ['lrclib'], translation: false, http });
    expect(plainOnly.result?.synced).toBe(false);
    expect(plainOnly.result?.text).toBe('line one\nline two');
  });

  it('returns no result when nothing matches well enough', async () => {
    const http = async () => JSON.stringify([lrclibRecord(1, 'Completely Different', 'Z', 100)]);
    const outcome = await searchLyrics({ title: 'Song', artist: 'A' }, { providers: ['lrclib'], translation: false, http });
    expect(outcome.result).toBeUndefined();
    expect(outcome.candidates).toEqual([]);
  });
});
