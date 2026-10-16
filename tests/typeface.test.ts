// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fontAssets from '../src/plugins/font-assets';
import { normalizeSettings } from '../src/plugins/theme';
import { covers, detectLang, documentLangs, faceFor, lineLang, themeFamily } from '../src/plugins/typeface';
import type { LyricDocument } from '../src/sdk/types';

const CJK_FAMILIES = ['Noto Sans JP', 'Noto Sans SC', 'Noto Sans TC', 'Mochiy Pop One', 'ZCOOL KuaiLe', 'Huninn', 'Zen Maru Gothic',
  'LXGW WenKai', 'LXGW WenKai TC', 'Klee One', 'Shippori Mincho', 'Noto Serif SC', 'Noto Serif TC', 'Dela Gothic One',
  'ZCOOL QingKe HuangYou', 'M PLUS 1 Code', 'Malgun Gothic', 'Batang'];
const families = (family: string) => CJK_FAMILIES.filter(name => family.includes(`"${name}"`));

describe('lyric language', () => {
  it('tells Japanese, Simplified, Traditional, Korean and Latin apart', () => {
    expect(detectLang(['夜明けの鐘が鳴る', '二人で走り出そう'])).toBe('ja');
    expect(detectLang(['我们说过的话', '这个梦还没醒来'])).toBe('zh-Hans');
    expect(detectLang(['我們說過的話', '這個夢還沒醒來'])).toBe('zh-Hant');
    // 只 / 台 are ordinary Traditional characters too and must not outvote 們.
    expect(detectLang(['我只想要你', '台上的人們'])).toBe('zh-Hant');
    expect(detectLang(['사랑해요 오늘도'])).toBe('ko');
    expect(detectLang(['Hello world', ''])).toBe('latin');
    // A stray の in a long Chinese lyric does not make it Japanese.
    expect(detectLang(['我们的爱'.repeat(30) + 'の'])).toBe('zh-Hans');
    // Katakana long-vowel marks alone are not Japanese evidence.
    expect(detectLang(['我们ー的・歌'])).toBe('zh-Hans');
  });

  it('keeps per-line script decisive inside a song', () => {
    expect(lineLang('走り出そう', 'zh-Hans')).toBe('ja');
    expect(lineLang('我们走吧', 'zh-Hans')).toBe('zh-Hans');
    expect(lineLang('風の中', 'ja')).toBe('ja');
    // Kanji-only lines follow the song (Japanese kanji stay Japanese forms).
    expect(lineLang('永遠', 'ja')).toBe('ja');
    expect(lineLang('永遠', 'zh-Hant')).toBe('zh-Hant');
    // A Latin song with a Chinese line detects that line.
    expect(lineLang('我們', 'latin')).toBe('zh-Hant');
    expect(lineLang('Hello', 'zh-Hans')).toBe('zh-Hans');
  });

  it('detects lyrics and translations separately and caches per document', () => {
    const doc = { timingMode: 'line', lines: [
      { id: 'a', text: '夜明けの鐘', translation: '黎明的钟声', startMs: 0 },
      { id: 'b', text: '走り出そう', translation: '一起跑起来吧', startMs: 1000 },
    ] } as unknown as LyricDocument;
    expect(documentLangs(doc)).toEqual({ lyrics: 'ja', translation: 'zh-Hans' });
    expect(documentLangs(doc)).toBe(documentLangs(doc));
  });
});

describe('faces', () => {
  it('names exactly one CJK family per face', () => {
    for (const role of ['pop', 'maru', 'hand', 'gothic', 'mincho', 'heavy', 'code', 'mono', 'script', 'serif'] as const) {
      for (const lang of ['ja', 'zh-Hans', 'zh-Hant', 'ko', 'latin'] as const) {
        for (const text of ['夜明けの鐘', '我们的梦', 'Hello']) {
          expect(families(faceFor(role, lang, text).family).length, `${role} ${lang} ${text}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('picks the language-matched family', () => {
    expect(faceFor('gothic', 'ja', '夜明け').family).toContain('Noto Sans JP');
    expect(faceFor('gothic', 'zh-Hans', '我们').family).toContain('Noto Sans SC');
    expect(faceFor('gothic', 'zh-Hant', '我們').family).toContain('Noto Sans TC');
    expect(faceFor('pop', 'zh-Hans', '我们').family).toContain('ZCOOL KuaiLe');
    expect(faceFor('heavy', 'zh-Hant', '我們')).toMatchObject({ weight: 900 });
    // Latin-only roles route CJK translations to a CJK role in the right language.
    expect(faceFor('script', 'zh-Hans', '我们', 400, 'italic')).toMatchObject({ style: 'normal' });
    expect(faceFor('script', 'zh-Hans', '我们').family).toContain('LXGW WenKai');
    expect(faceFor('script', 'latin', 'Hello', 400, 'italic')).toMatchObject({ style: 'italic' });
    expect(faceFor('script', 'latin', 'Hello').family).toContain('Playfair Display');
    // Weights snap to the bundled ones.
    expect(faceFor('mincho', 'zh-Hans', '我们', 400).weight).toBe(700);
  });

  it('resolves theme presets per language and keeps custom families', () => {
    expect(themeFamily('auto:sans', 'zh-Hans')).toContain('Noto Sans SC');
    expect(themeFamily('auto:sans', 'ja')).toContain('Noto Sans JP');
    expect(themeFamily('"Arial", sans-serif', 'ja')).toBe('"Arial", sans-serif');
    expect(normalizeSettings({}).fontFamily).toBe('auto:sans');
    expect(normalizeSettings({ fontFamily: '"Microsoft YaHei", "Segoe UI", sans-serif' }).fontFamily).toBe('auto:sans');
    expect(normalizeSettings({ fontFamily: '"KaiTi", serif' }).fontFamily).toBe('"KaiTi", serif');
  });
});

describe('coverage fallback', () => {
  const original = Object.getOwnPropertyDescriptor(document, 'fonts');
  afterEach(() => { vi.restoreAllMocks(); if (original) Object.defineProperty(document, 'fonts', original); else delete (document as { fonts?: unknown }).fonts; });
  const install = (faces: { family: string; unicodeRange: string }[]) => {
    vi.spyOn(fontAssets, 'bundledCoverage').mockReturnValue(null);
    return Object.defineProperty(document, 'fonts', {
    configurable: true, value: { size: faces.length + Math.random(), forEach: (callback: (face: unknown) => void) => faces.forEach(callback) },
    });
  };

  it('hands a whole line to the complete face when a decorative face lacks a character', () => {
    install([
      { family: 'ZCOOL KuaiLe', unicodeRange: 'U+0000-00FF, U+4E00-4E10, U+6211, U+4EEC' },
      { family: '"Noto Sans SC"', unicodeRange: 'U+0000-00FF, U+3000-9FFF' },
    ]);
    expect(covers('ZCOOL KuaiLe', '我们')).toBe(true);
    expect(covers('ZCOOL KuaiLe', '我们的')).toBe(false);
    expect(covers('ZCOOL KuaiLe', '我们 🎵')).toBe(true);
    expect(faceFor('pop', 'zh-Hans', '我们').family).toContain('ZCOOL KuaiLe');
    const fallback = faceFor('pop', 'zh-Hans', '我们的歌');
    expect(fallback.family).toContain('Noto Sans SC');
    expect(fallback.family).not.toContain('ZCOOL');
    // Text the language's own Noto cannot fully draw moves whole to a Noto that can.
    install([
      { family: 'Noto Sans JP', unicodeRange: 'U+0000-00FF, U+3040-30FF, U+4E00-4EFF' },
      { family: 'Mochiy Pop One', unicodeRange: 'U+0000-00FF, U+3040-30FF' },
      { family: 'Noto Sans SC', unicodeRange: 'U+0000-00FF, U+3040-30FF, U+4E00-9FFF' },
    ]);
    expect(faceFor('pop', 'ja', '二人で').family).toContain('Noto Sans JP');
    expect(faceFor('pop', 'ja', '我们で').family).toContain('Noto Sans SC');
    // Unknown (system) families are trusted.
    expect(covers('Malgun Gothic', '사랑')).toBe(true);
  });
});
