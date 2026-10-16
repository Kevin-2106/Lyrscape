// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { ensureBundledFonts, prepareLegacyPluginFonts } from '../src/plugins/font-assets';
import { covers } from '../src/plugins/typeface';
// Vitest stubs CSS by default; the real bundled URLs/faces are checked in WebView2.
vi.mock('@fontsource/lxgw-wenkai-tc/400.css?inline', () => ({ default: '@font-face { font-family: "LXGW WenKai TC"; src: url(tc.woff2); }' }));
vi.mock('lxgw-wenkai-webfont/lxgwwenkai-regular.css?inline', () => ({ default: '@font-face { font-family: "LXGW WenKai"; src: url(sc.woff2); }' }));
vi.mock('@fontsource/mochiy-pop-one/400.css?inline', () => ({ default: '@font-face { font-family: "Mochiy Pop One"; src: url(latin.woff2); unicode-range: U+0041-005A; } @font-face { font-family: "Mochiy Pop One"; src: url(kana.woff2); unicode-range: U+3040-30FF; }' }));

it('registers only requested font families, once, and distinguishes TC from the SC prefix', async () => {
  expect(document.head.querySelectorAll('[data-bundled-font]')).toHaveLength(0);
  await ensureBundledFonts('"Arial", sans-serif', 'test');
  expect(document.head.querySelectorAll('[data-bundled-font]')).toHaveLength(0);
  await ensureBundledFonts('"LXGW WenKai TC", serif', '我們');
  expect([...document.head.querySelectorAll<HTMLElement>('[data-bundled-font]')].map(node => node.dataset.bundledFont)).toEqual(['LXGW WenKai TC']);
  const style = document.head.querySelector('[data-bundled-font]');
  await ensureBundledFonts('normal 400 32px "LXGW WenKai TC", serif', '我們');
  expect(document.head.querySelectorAll('[data-bundled-font]')).toHaveLength(1);
  expect(document.head.querySelector('[data-bundled-font]')).toBe(style);
  await ensureBundledFonts('LXGW WenKai', '我们');
  expect(document.head.querySelectorAll('[data-bundled-font]')).toHaveLength(2);
  expect((style as HTMLStyleElement).sheet!.cssRules[0].cssText).toContain('@font-face');
});

it('uses complete bundled coverage even when only an earlier lyric subset is registered', () => {
  const previous = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, value: {
    size: 1, forEach(callback: (face: unknown) => void) { callback({ family: 'Noto Sans SC', unicodeRange: 'U+6211' }); },
  } });
  try {
    expect(covers('Noto Sans SC', '中国未来')).toBe(true);
    expect(covers('Noto Sans SC', String.fromCodePoint(0x10ffff))).toBe(false);
  } finally {
    if (previous) Object.defineProperty(document, 'fonts', previous);
    else delete (document as { fonts?: unknown }).fonts;
  }
});

it('registers only the used subset but keeps fonts available to older editable bundles', async () => {
  await ensureBundledFonts('Mochiy Pop One', 'ABC');
  const style = document.head.querySelector<HTMLStyleElement>('[data-bundled-font="Mochiy Pop One"]')!;
  expect(style.sheet!.cssRules).toHaveLength(1);
  await prepareLegacyPluginFonts('/* lyrscape.bundled-fonts.v1 */ const family = "Mochiy Pop One";');
  expect(style.sheet!.cssRules).toHaveLength(1);
  await prepareLegacyPluginFonts('const family = "Mochiy Pop One";');
  expect(style.sheet!.cssRules).toHaveLength(2);
});
