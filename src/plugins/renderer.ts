import type { AppState, LyricLine, Renderer, Timeline } from '../sdk/types';
import type { Plugin, PluginContext } from '../kernel/host';
import '../renderer.css';
import { AUTO_FAMILIES, documentLangs, langTag, lineLang, themeFamily, type Lang } from './typeface';

export function activeLine(lines: LyricLine[], position: number): number {
  let index = -1, background = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startMs !== undefined && line.startMs <= position && (line.endMs === undefined || position < line.endMs)) {
      if (line.isBackground) background = i; else index = i;
    }
  }
  return index >= 0 ? index : background;
}

/** One phrase covering a whole line supplies line timing, not granular progress. */
export function hasGranularWordTiming(line: LyricLine): boolean {
  const words = line.words ?? [];
  if (words.length > 1) return true;
  if (words.length !== 1) return false;
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(words[0].text);
  let count = 0;
  for (const _segment of segments) { if (++count > 1) return false; }
  return count === 1;
}

/** Public DOM renderer construction hooks, shared by independent DOM renderers. */
export interface DomRendererHooks {
  mount?(root: HTMLElement): () => void;
  revision?(state: AppState): string;
  line?(root: HTMLElement, line: HTMLElement, state: AppState): void;
  frame?(root: HTMLElement, state: AppState, clock: DomRendererClock): void;
}
export interface DomRendererClock { position: number; index: number }
export function createDomRenderer(hooks: DomRendererHooks = {}): Renderer { return {
  mount(root, getState, time: Timeline) {
    root.classList.add('lyric-surface');
    const line = document.createElement('div'); line.className = 'lyric-current';
    const translation = document.createElement('div'); translation.className = 'lyric-translation';
    const next = document.createElement('div'); next.className = 'lyric-next';
    root.replaceChildren(line, translation, next);
    const disposeHook = hooks.mount?.(root);
    let renderedDocument: AppState['lyrics'] | undefined, renderedIndex = -999;
    let renderedRevision = '', renderedFont = '';
    let words: { node: HTMLElement; start: number; end: number }[] = [];
    let raf = 0, disposed = false;
    const frame = () => {
      if (disposed) return;
      const state = getState(), s = state.settings, position = time.position(state);
      const auto = s.fontFamily in AUTO_FAMILIES, langs = documentLangs(state.lyrics);
      root.style.fontFamily = themeFamily(s.fontFamily, langs.lyrics); root.style.fontSize = `${s.fontSize}px`;
      root.style.fontWeight = String(s.fontWeight); root.style.lineHeight = String(s.lineHeight);
      root.style.textAlign = s.textAlign;
      // Bundled CJK faces ship one or two weights; never smear a fake bold over them.
      root.style.setProperty('font-synthesis', auto ? 'none' : '');
      root.style.setProperty('--lyric-color', s.color);
      root.style.setProperty('--lyric-inactive', s.inactiveColor);
      root.style.setProperty('--lyric-paint', s.gradientEnabled
        ? `linear-gradient(${s.gradientAngle}deg, ${s.gradientStart}, ${s.gradientEnd})` : s.color);
      root.style.setProperty('--lyric-shadow', `${s.shadow * 5}px`);
      root.style.backgroundColor = `rgba(12, 12, 16, ${s.backgroundOpacity})`;
      root.classList.toggle('gradient-text', s.gradientEnabled);
      const lines = state.lyrics.lines;
      const index = state.lyrics.timingMode === 'none' ? 0 : activeLine(lines, position);
      const revision = hooks.revision?.(state) ?? '';
      if (renderedDocument !== state.lyrics || renderedIndex !== index || renderedRevision !== revision || renderedFont !== s.fontFamily) {
        renderedRevision = revision; renderedFont = s.fontFamily;
        renderedDocument = state.lyrics; renderedIndex = index; words = []; line.replaceChildren();
        const current = lines[index];
        if (current) {
          if (hasGranularWordTiming(current) && state.lyrics.timingMode === 'word') {
            for (const word of current.words!) {
              const span = document.createElement('span'); span.className = 'lyric-word';
              const base = document.createElement('span'); base.className = 'word-base'; base.textContent = word.text;
              const fill = document.createElement('span'); fill.className = 'word-fill'; fill.textContent = word.text;
              fill.setAttribute('aria-hidden', 'true'); span.append(base, fill); line.append(span);
              words.push({ node: fill, start: word.startMs, end: word.endMs });
            }
          } else {
            line.textContent = state.lyrics.timingMode === 'none' ? lines.map(l => l.text).join('\n') : current.text;
          }
          translation.textContent = current.translation ?? current.romanization ?? '';
          next.textContent = state.lyrics.timingMode === 'none' ? '' : lines.slice(index + 1).find(l => !l.isBackground)?.text ?? '';
        } else {
          line.textContent = lines.length ? '♪' : '等待歌词'; translation.textContent = '';
          next.textContent = lines.find(l => (l.startMs ?? 0) > position)?.text ?? '';
        }
        // One language (so one CJK family) per element: a Japanese line in a Chinese song keeps Japanese glyphs.
        const typeset = (element: HTMLElement, songLang: Lang) => {
          const text = element.textContent ?? '', lang = text ? lineLang(text, songLang) : songLang;
          element.lang = langTag(lang);
          element.style.fontFamily = auto ? themeFamily(s.fontFamily, lang, text) : '';
        };
        typeset(line, langs.lyrics); typeset(translation, langs.translation); typeset(next, langs.lyrics);
        hooks.line?.(root, line, state);
      }
      for (const word of words) {
        const progress = Math.min(1, Math.max(0, (position - word.start) / Math.max(1, word.end - word.start)));
        word.node.style.clipPath = `inset(0 ${(1 - progress) * 100}% 0 0)`;
      }
      translation.hidden = !s.showTranslation || !translation.textContent;
      next.hidden = !s.showNextLine || !next.textContent;
      hooks.frame?.(root, state, { position, index });
      raf = requestAnimationFrame(frame);
    };
    frame();
    return () => { if (disposed) return; disposed = true; cancelAnimationFrame(raf); disposeHook?.(); root.replaceChildren(); root.classList.remove('lyric-surface'); };
  },
}; }

/** A provider owns all live mounts, while disposed mounts leave no retained scope entry. */
export function ownRenderer(ctx: PluginContext, renderer: Renderer): Renderer {
  const mounts = new Set<() => void>();
  let active = true;
  ctx.own(() => { active = false; for (const dispose of [...mounts]) dispose(); });
  return { mount(root, state, timeline) {
    if (!active) throw new Error('渲染器插件已释放');
    const cleanup = renderer.mount(root, state, timeline);
    let disposed = false;
    const dispose = () => { if (disposed) return; disposed = true; mounts.delete(dispose); cleanup(); };
    mounts.add(dispose); return dispose;
  } };
}
export const rendererPlugin: Plugin = {
  id: 'official.renderer.text', activate(ctx) { ctx.provide('renderer.text@1', ownRenderer(ctx, createDomRenderer())); },
};
