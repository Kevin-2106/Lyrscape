import { ensureBundledFonts } from '../font-assets';
// Bundled faces (OFL). CJK families are split by unicode-range, so only the
// subsets a lyric actually uses are fetched; nothing is loaded from the network.
// Which family draws a line is decided per lyric language in ../typeface.ts.

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
    const key = `${spec}\u0000${text}`;
    if (requested.has(key)) continue;
    if (requested.size > 2000) requested.clear();
    requested.add(key);
    void ensureBundledFonts(spec, text).then(() => {
      if (fonts.check?.(spec, text)) return;
      return fonts.load(spec, text).then(faces => { if (faces.length) version++; });
    }).catch(console.error);
  }
}
