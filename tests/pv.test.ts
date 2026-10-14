// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { AppState, Renderer } from '../src/sdk/types';
import { PluginHost } from '../src/kernel/host';
import { normalizePreferences } from '../src/plugins/management';
import { normalizeSettings } from '../src/plugins/theme';
import { pvProfiles } from '../src/plugins/pv-presets';
import { breakRows, chorusLines, graphemes, lineBoundary, repeatCount, splitAt, wordStarts } from '../src/plugins/pv/core';
import { elegyChunks } from '../src/plugins/pv/elegy';
import { pvPlugins } from '../src/plugins/pv';

afterEach(() => vi.unstubAllGlobals());

it('uses source boundaries as transition cues', () => {
  const lines = [{ id: 'a', text: 'a', startMs: 0, endMs: 1000 },
    { id: 'background', text: 'echo', startMs: 500, isBackground: true },
    { id: 'b', text: 'b', startMs: 800 }];
  expect(lineBoundary(lines, 0)).toBe(800);
  expect(lineBoundary(lines, 2)).toBeUndefined();
  // Malformed sources: zero-length credit lines and two lines sharing a start time never stay on screen together.
  const malformed = [{ id: 'c1', text: '作词', startMs: 0, endMs: 0 }, { id: 'c2', text: '作曲', startMs: 0, endMs: 0 },
    { id: 'x', text: 'dup', startMs: 0, endMs: 2000 }, { id: 'y', text: 'first', startMs: 0, endMs: 2000 }, { id: 'z', text: 'next', startMs: 2000 }];
  expect(lineBoundary(malformed, 0)).toBe(0);
  expect(lineBoundary(malformed, 1)).toBe(0);
  expect(lineBoundary(malformed, 2)).toBe(0);
  expect(lineBoundary(malformed, 3)).toBe(2000);
});

it('keeps grapheme clusters and breaks Japanese rows between phrases', () => {
  expect(graphemes('A 👨‍👩‍👧‍👦中')).toEqual(['A', ' ', '👨‍👩‍👧‍👦', '中']);
  const rows = (text: string) => {
    const glyphs = graphemes(text);
    return splitAt(glyphs, breakRows(glyphs, 2, () => 1, wordStarts(text))).map(row => row.join(''));
  };
  // Never strand a particle or okurigana at the start of a row.
  expect(rows('夜明けの鐘が鳴るまで')).toEqual(['夜明けの', '鐘が鳴るまで']);
  for (const text of ['二人で走り出そう', '窓の外ひかる街を数えてた']) {
    const [, second] = rows(text);
    expect(second).not.toMatch(/^[をがはでにのもっゃゅょー]/u);
  }
});

it('treats repeated lines as chorus and groups elegy phrases with their particles', () => {
  const doc = { timingMode: 'line' as const, lines: [
    { id: '1', text: '二人で 走り出そう!' }, { id: '2', text: 'verse' }, { id: '3', text: '二人で走り出そう' },
  ] };
  expect(repeatCount(doc, '二人で走り出そう')).toBe(2);
  expect(repeatCount(doc, 'verse')).toBe(1);
  const text = '夜明けの鐘が鳴るまで', glyphs = graphemes(text);
  const chunks = elegyChunks(glyphs, wordStarts(text)).map(chunk => chunk.map(i => glyphs[i]).join(''));
  expect(chunks.join('')).toBe(text);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks.slice(1)) expect(chunk).not.toMatch(/^[のがをはで]/u);
});

it('detects whole chorus blocks, tolerating a changed word and a one-off line', () => {
  const doc = (texts: string[]) => ({ timingMode: 'line' as const, lines: texts.map((text, i) => ({ id: String(i), text })) });
  const song = doc([
    '窓の外ひかる街を数えてた', '眠れない夜のまま', // 0-1 verse
    '二人で走り出そう', '夜明けの鐘が鳴るまで', '君の声だけ聞かせて', '離さないでいて', // 2-5 chorus
    '雨上がりの坂道で', '同じ歌を口ずさむ', // 6-7 verse
    '二人で歩き出そう', '夜明けの鐘が鳴るまで', 'ここにしかない約束', '離さないでいて', // 8-11 chorus, one word and one line changed
    '眠れない夜のまま', // 12 one repeated verse line alone
  ]);
  expect([...chorusLines(song)!].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 8, 9, 10, 11]);
  expect(chorusLines(doc(['a line here', 'another one', 'a line here']))).toBeNull();
});

it('persists independent PV preferences and migrates the earlier PV renderer ids', () => {
  for (const profile of pvProfiles) {
    const prefs = normalizePreferences({ rendererId: profile.id, configs: { [profile.id]: { scale: 99, layout: 'nope' } } });
    expect(prefs.rendererId).toBe(profile.id);
    expect(prefs.configs[profile.id]).toMatchObject({ scale: 1.6, motion: true, ...(profile.style === 'amll' ? {} : { layout: 'auto' }) });
    expect(normalizePreferences({ rendererId: profile.id, enabled: { [profile.id]: false } }).rendererId).toBe('official.renderer.text');
  }
  expect(normalizePreferences({ rendererId: 'official.renderer.pv-impact' }).rendererId).toBe('official.renderer.pv-pop');
  expect(normalizePreferences({ rendererId: 'official.renderer.pv-card' }).rendererId).toBe('official.renderer.pv-letter');
  expect(normalizePreferences({ rendererId: 'official.renderer.pv-cut' }).rendererId).toBe('official.renderer.pv-elegy');
  expect(normalizePreferences({ rendererId: 'unknown' }).rendererId).toBe('official.renderer.text');
});

for (const [index, profile] of pvProfiles.entries()) {
  it(`${profile.style}: schedules lines from the timeline, picks hero / caption and cleans its mount`, async () => {
    // jsdom has no 2D canvas; the stage must still schedule, label and size itself.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    let frame = () => {}; let position = 100;
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { frame = fn; return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const host = new PluginHost(); await host.start([pvPlugins[index]]);
    const state = { settings: normalizeSettings(null), plugins: normalizePreferences(null), lyrics: { timingMode: 'word', lines: [
      { id: 'verse', text: 'Hello world, this is a verse', startMs: 0, endMs: 3000, words: [
        { text: 'Hello world, ', startMs: 0, endMs: 1000 }, { text: 'this is a verse', startMs: 1000, endMs: 2000 },
      ] },
      { id: 'hook', text: '二人で走り出そう', startMs: 3000, endMs: 6000 },
      { id: 'hook2', text: '二人で走り出そう', startMs: 6000 },
    ] } } as AppState;
    const root = document.createElement('div');
    const dispose = host.service<Renderer>(profile.service).mount(root, () => state, { position: () => position });
    expect(root.dataset.pvStyle).toBe(profile.style);
    expect(root.querySelector('canvas')).not.toBeNull();
    expect(parseFloat(root.style.height)).toBeGreaterThan(90);
    expect(root.dataset.pvLine).toBe('verse');
    expect(root.dataset.pvMode).toBe('caption');
    expect(root.querySelector('.pv-text')!.textContent).toBe('Hello world, this is a verse');
    position = 4000; frame();
    expect(root.dataset.pvLine).toBe('hook');
    expect(root.dataset.pvMode).toBe('hero');
    position = 500; frame();
    expect(root.dataset.pvLine).toBe('verse');
    // Malformed source (as in a real NetEase lyric): zero-length credit lines at 0:00 never stay on screen.
    state.lyrics = { timingMode: 'line', lines: [{ id: 'c1', text: '作词 : A', startMs: 0, endMs: 0 }, { id: 'c2', text: '作曲 : B', startMs: 0, endMs: 0 },
      { id: 'l1', text: 'first line', startMs: 0, endMs: 1800 }, { id: 'l2', text: 'second line', startMs: 1800, endMs: 3600 }] };
    for (position of [0, 900, 2500]) { frame(); expect(root.dataset.pvLines).not.toMatch(/c1|c2/); }
    expect(root.dataset.pvLines).toBe('l2');
    // Literal text only; markup in lyrics is never parsed.
    state.lyrics = { timingMode: 'line', lines: [{ id: 'x', text: '<b>家庭👨‍👩‍👧‍👦', startMs: 0, endMs: 5000 }] }; frame();
    expect(root.querySelector('.pv-text')!.textContent).toBe('<b>家庭👨‍👩‍👧‍👦');
    expect(root.querySelector('b')).toBeNull();
    state.lyrics = { timingMode: 'none', lines: [{ id: 'p', text: 'plain' }, { id: 'q', text: 'text' }] }; frame();
    expect(root.querySelector('.pv-text')!.textContent).toBe('plain\ntext');
    host.deactivate(profile.id); expect(root.children).toHaveLength(0);
    expect(root.classList.contains('pv-stage')).toBe(false); expect(root.dataset.pvStyle).toBeUndefined();
    root.textContent = 'replacement'; dispose(); frame(); expect(root.textContent).toBe('replacement');
  });
}
