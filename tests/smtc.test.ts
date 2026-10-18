import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  calls: [] as { command: string; args?: Record<string, unknown> }[],
  http: (_url: string): Promise<string> => Promise.reject(Error('no http')),
}));
vi.mock('../src/platform', () => ({
  desktop: true,
  onEvent: async (name: string, handler: (payload: unknown) => void) => { bridge.handlers.set(name, handler); return () => bridge.handlers.delete(name); },
  native: async (command: string, args?: Record<string, unknown>) => {
    bridge.calls.push({ command, args });
    if (command === 'lyrics_http_get') return bridge.http(String(args?.url));
    if (command === 'session_restore') return { controlActive: true };
    return null;
  },
}));

import { PluginHost } from '../src/kernel/host';
import { Store } from '../src/kernel/store';
import { normalizePreferences } from '../src/plugins/management';
import { shiftLyrics, smtcPlugin, type SmtcAdapter } from '../src/plugins/smtc';
import { normalizeSettings } from '../src/plugins/theme';
import { timeline, timelinePlugin } from '../src/plugins/timeline';
import type { AppState } from '../src/sdk/types';

const state = (adapterId: AppState['adapterId'] = 'smtc'): AppState => ({
  settings: normalizeSettings(undefined), plugins: normalizePreferences(undefined),
  track: { title: '', artists: [] }, lyrics: { timingMode: 'none', lines: [] },
  playback: { positionMs: 0, playing: false, rate: 1, observedAtMonoMs: 0 },
  connection: { status: 'stopped', clients: 0, port: 11444 }, adapterId,
  overlay: { visible: false, clickthrough: false, alwaysOnTop: true }, isDesktop: true,
});
const media = (patch: Record<string, unknown> = {}) => ({
  available: true, source: 'Spotify.exe', sessions: ['Spotify.exe'], title: 'Heavenly Me', artist: 'AIYUE', album: 'A', albumArtist: '',
  durationMs: 191000, positionMs: 30000, updatedAtEpochMs: Date.now() - 1000, playing: true, status: 'playing', rate: 1, error: null, ...patch,
});
const emit = (payload: unknown) => bridge.handlers.get('smtc-state')!(payload);

describe('SMTC adapter', () => {
  let host: PluginHost, store: Store<AppState>;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const memory = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k), clear: () => memory.clear() });
    bridge.handlers.clear(); bridge.calls.length = 0;
    bridge.http = async url => {
      if (url.includes('/api/get?')) return JSON.stringify({ id: 7, trackName: 'Heavenly Me', artistName: 'AIYUE', duration: 191, syncedLyrics: '[00:31.00]first\n[00:35.00]second', plainLyrics: 'first\nsecond' });
      throw Error(`unexpected ${url}`);
    };
    store = new Store(state()); host = new PluginHost();
    await host.start([timelinePlugin, smtcPlugin(store)]);
  });
  afterEach(() => { host.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('starts polling when selected and extrapolates from the sample time', () => {
    expect(bridge.calls.map(c => c.command)).toContain('smtc_start');
    emit(media());
    const s = store.get();
    expect(s.track).toEqual({ title: 'Heavenly Me', artists: ['AIYUE'], durationMs: 191000 });
    expect(s.media?.source).toBe('Spotify.exe');
    // Sampled a second ago: the timeline is already about a second ahead.
    expect(timeline.position(s)).toBeGreaterThan(30900);
    expect(timeline.position(s)).toBeLessThan(31200);
  });

  it('pausing without a new timeline sample keeps the extrapolated position', () => {
    const sample = media();
    emit(sample);
    const before = timeline.position(store.get());
    emit({ ...sample, playing: false, status: 'paused' });
    const after = store.get().playback;
    expect(after.playing).toBe(false);
    expect(after.positionMs).toBeGreaterThanOrEqual(before);
    expect(after.positionMs).toBeLessThan(before + 200);
  });

  it('looks up lyrics after the debounce, caches them and applies the offset', async () => {
    emit(media());
    expect(store.get().media?.lookup.state).toBe('idle');
    await vi.advanceTimersByTimeAsync(800);
    const s = store.get();
    expect(s.media?.lookup.state).toBe('found');
    expect(s.media?.lookup.result?.key).toBe('lrclib:7');
    expect(s.lyrics.lines.map(l => [l.text, l.startMs])).toEqual([['first', 31000], ['second', 35000]]);
    const requests = () => bridge.calls.filter(c => c.command === 'lyrics_http_get').length;
    expect(requests()).toBe(2); // LRCLIB exact match + NetEase search (both providers by default)

    store.update(x => ({ ...x, plugins: { ...x.plugins, configs: { ...x.plugins.configs, 'official.adapter.smtc': { offset: 500 } } } }));
    expect(store.get().lyrics.lines[0].startMs).toBe(31500);

    // Another track and back: the second lookup of the first track comes from the cache.
    emit(media({ title: 'Other', durationMs: 100000 }));
    expect(store.get().lyrics.lines).toEqual([]);
    emit(media());
    await vi.advanceTimersByTimeAsync(800);
    expect(store.get().media?.lookup.cached).toBe(true);
    expect(requests()).toBe(2); // 'Other' was skipped within the debounce and never searched
    expect(store.get().lyrics.lines[0].startMs).toBe(31500);
  });

  it('does not search while another source is selected', async () => {
    store.update(s => ({ ...s, adapterId: 'demo' }));
    expect(bridge.calls.map(c => c.command)).toContain('smtc_stop');
    emit(media());
    await vi.advanceTimersByTimeAsync(800);
    expect(bridge.calls.some(c => c.command === 'lyrics_http_get')).toBe(false);
    expect(store.get().track.title).toBe('');
    expect(host.service<SmtcAdapter>('adapter.smtc@1').snapshot().track.title).toBe('Heavenly Me');
  });

  it('reports no session', () => {
    emit({ ...media(), available: false, title: '', sessions: [] });
    expect(store.get().track.title).toBe('没有正在播放的媒体');
    expect(store.get().media?.available).toBe(false);
  });
});

describe('shiftLyrics', () => {
  it('moves line and word times, never below zero, and leaves untimed text alone', () => {
    const doc = { timingMode: 'word' as const, lines: [{ id: 'a', text: 'ab', startMs: 100, endMs: 900, words: [{ text: 'a', startMs: 100, endMs: 500 }] }] };
    expect(shiftLyrics(doc, -200).lines[0]).toMatchObject({ startMs: 0, endMs: 700, words: [{ startMs: 0, endMs: 300 }] });
    const plain = { timingMode: 'none' as const, lines: [{ id: 'a', text: 'x' }] };
    expect(shiftLyrics(plain, 500)).toBe(plain);
  });
});
