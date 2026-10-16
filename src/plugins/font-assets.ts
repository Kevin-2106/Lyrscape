import { fontCatalog } from './font-catalog';
import fontRanges from './font-ranges.json';

/** Whole-line coverage is available before font CSS or bytes are loaded. */
const coverageCache = new Map<string, [number, number][]>();
export function bundledCoverage(family: string): [number, number][] | null {
  const encoded = (fontRanges as Record<string, string>)[family];
  if (!encoded) return null;
  let spans = coverageCache.get(family);
  if (!spans) {
    spans = []; const bytes = atob(encoded); let at = 0, previous = -1;
    const integer = () => { let value = 0, shift = 0, byte; do { byte = bytes.charCodeAt(at++); value |= (byte & 127) << shift; shift += 7; } while (byte & 128); return value; };
    while (at < bytes.length) { const lo = previous + 1 + integer(), hi = lo + integer(); spans.push([lo, hi]); previous = hi; }
    coverageCache.set(family, spans);
  }
  return spans;
}

const key = Symbol.for('lyrscape.bundled-fonts.v1');
type FontRegistry = { ensure(spec: string, text: string, complete?: boolean): Promise<void> };
const shared = globalThis as typeof globalThis & { [key]?: FontRegistry };
type Rule = { css: string; spans: [number, number][] };
const rules = new Map<string, Promise<Rule[]>>(), rangeCache = new Map<string, [number, number][]>();
const registered = new WeakMap<Document, Map<string, { style: HTMLStyleElement; rules: Set<string> }>>();
// Reloadable plugin bundles use the host's URLs, promises and existing faces.
const registry = shared[key] ??= { ensure(spec: string, text: string, complete = false) {
  if (typeof document === 'undefined' || !text && !complete) return Promise.resolve();
  const target = document;
  let loaded = registered.get(target);
  if (!loaded) { loaded = new Map(); registered.set(target, loaded); }
  const pending: Promise<void>[] = [], points = [...text].map(char => char.codePointAt(0)!);
  for (const family in fontCatalog) {
    if (spec !== family && !spec.includes(`"${family}"`) && !spec.includes(`'${family}'`) && !spec.split(',').some(part => part.trim() === family)) continue;
    let promise = rules.get(family);
    if (!promise) {
      promise = Promise.all(fontCatalog[family].map(load => load())).then(modules => {
        const result: Rule[] = [];
        for (const module of modules) for (const match of module.default.matchAll(/@font-face\s*\{[^}]+\}/g)) {
          const source = /unicode-range:\s*([^;}]+)/.exec(match[0])?.[1] ?? 'U+0-10FFFF';
          let spans = rangeCache.get(source);
          if (!spans) {
            spans = [...source.matchAll(/U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/gi)].map(([, lo, hi]) =>
              [parseInt(lo.replace(/\?/g, '0'), 16), parseInt(hi ?? lo.replace(/\?/g, 'f'), 16)] as [number, number]);
            rangeCache.set(source, spans);
          }
          result.push({ css: match[0], spans });
        }
        return result;
      }).catch(error => { rules.delete(family); throw error; });
      rules.set(family, promise);
    }
    pending.push(promise.then(values => {
      let registered = loaded!.get(family);
      if (!registered) {
        const style = target.createElement('style'); style.dataset.bundledFont = family; target.head.append(style);
        registered = { style, rules: new Set() }; loaded!.set(family, registered);
      }
      for (const rule of values) {
        if (registered.rules.has(rule.css) || !complete && !points.some(point => rule.spans.some(([lo, hi]) => point >= lo && point <= hi))) continue;
        registered.style.sheet!.insertRule(rule.css, registered.style.sheet!.cssRules.length);
        registered.rules.add(rule.css);
      }
    }));
  }
  return Promise.all(pending).then(() => {});
} };
export const ensureBundledFonts = (spec: string, text = '') => registry.ensure(spec, text);

/** Older editable bundles relied on globally registered font CSS. Preserve
 * their look; rebuilt bundles share the demand loader and avoid this cost. */
export async function prepareLegacyPluginFonts(javascript: string) {
  if (javascript.includes('lyrscape.bundled-fonts.v1')) return;
  const referenced = Object.keys(fontCatalog).filter(family => javascript.includes(family));
  await Promise.all(referenced.map(family => registry.ensure(family, '', true)));
}
