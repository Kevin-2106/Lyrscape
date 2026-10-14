// Bundled faces (OFL). CJK families are split by unicode-range, so only the
// subsets a lyric actually uses are fetched; nothing is loaded from the network.
// Which family draws a line is decided per lyric language in ../typeface.ts.
import '@fontsource/mochiy-pop-one/400.css';
import '@fontsource/zen-maru-gothic/500.css';
import '@fontsource/klee-one/600.css';
import '@fontsource/noto-sans-jp/500.css';
import '@fontsource/shippori-mincho/700.css';
import '@fontsource/playfair-display/400-italic.css';
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/dela-gothic-one/400.css';
import '@fontsource/share-tech-mono/400.css';
import '@fontsource/m-plus-1-code/300.css';
import '@fontsource/m-plus-1-code/500.css';
import '@fontsource/noto-sans-jp/700.css';
import '@fontsource/noto-sans-jp/900.css';
// Simplified Chinese
import '@fontsource/noto-sans-sc/500.css';
import '@fontsource/noto-sans-sc/700.css';
import '@fontsource/noto-sans-sc/900.css';
import '@fontsource/noto-serif-sc/700.css';
import '@fontsource/zcool-kuaile/400.css';
import '@fontsource/zcool-qingke-huangyou/400.css';
import 'lxgw-wenkai-webfont/lxgwwenkai-regular.css';
// Traditional Chinese
import '@fontsource/noto-sans-tc/500.css';
import '@fontsource/noto-sans-tc/700.css';
import '@fontsource/noto-sans-tc/900.css';
import '@fontsource/noto-serif-tc/700.css';
import '@fontsource/huninn/400.css';
import '@fontsource/lxgw-wenkai-tc/400.css';

export const FONT = {
  pop: '"Mochiy Pop One", "Zen Maru Gothic", "Yu Gothic UI", sans-serif',
  maru: '"Zen Maru Gothic", "Yu Gothic UI", sans-serif',
  hand: '"Klee One", "Zen Maru Gothic", sans-serif',
  gothic: '"Noto Sans JP", "Yu Gothic UI", sans-serif',
  mincho: '"Shippori Mincho", "Yu Mincho", serif',
  script: '"Playfair Display", Georgia, serif',
  serif: '"EB Garamond", Georgia, serif',
  heavy: '"Dela Gothic One", "Noto Sans JP", "Yu Gothic UI", sans-serif',
  mono: '"Share Tech Mono", "M PLUS 1 Code", Consolas, monospace',
  code: '"M PLUS 1 Code", "Share Tech Mono", "Yu Gothic UI", monospace',
};

let version = 0;
const requested = new Set<string>();
/** Bumps whenever a face finishes loading, so cached layouts and sprites are rebuilt. */
export const fontsVersion = () => version;
export function requestFonts(specs: string[], text: string) {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts?.load || !text) return;
  for (const spec of specs) {
    if (fonts.check?.(spec, text)) continue;
    const key = `${spec}\u0000${text}`;
    if (requested.has(key)) continue;
    if (requested.size > 2000) requested.clear();
    requested.add(key);
    fonts.load(spec, text).then(faces => { if (faces.length) version++; }, () => {});
  }
}
