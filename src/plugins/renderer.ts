import type { AppState, LyricLine, Renderer, Timeline } from '../sdk/types';
import type { Plugin } from '../kernel/host';
import '../renderer.css';

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

const renderer: Renderer = {
  mount(root, getState, time: Timeline) {
    root.classList.add('lyric-surface');
    const line = document.createElement('div'); line.className = 'lyric-current';
    const translation = document.createElement('div'); translation.className = 'lyric-translation';
    const next = document.createElement('div'); next.className = 'lyric-next';
    root.replaceChildren(line, translation, next);
    let renderedDocument: AppState['lyrics'] | undefined, renderedIndex = -999;
    let words: { node: HTMLElement; start: number; end: number }[] = [];
    let raf = 0, disposed = false;
    const frame = () => {
      if (disposed) return;
      const state = getState(), s = state.settings, position = time.position(state);
      root.style.fontFamily = s.fontFamily; root.style.fontSize = `${s.fontSize}px`;
      root.style.fontWeight = String(s.fontWeight); root.style.lineHeight = String(s.lineHeight);
      root.style.textAlign = s.textAlign;
      root.style.setProperty('--lyric-color', s.color);
      root.style.setProperty('--lyric-inactive', s.inactiveColor);
      root.style.setProperty('--lyric-paint', s.gradientEnabled
        ? `linear-gradient(${s.gradientAngle}deg, ${s.gradientStart}, ${s.gradientEnd})` : s.color);
      root.style.setProperty('--lyric-shadow', `${s.shadow * 5}px`);
      root.style.backgroundColor = `rgba(12, 12, 16, ${s.backgroundOpacity})`;
      root.classList.toggle('gradient-text', s.gradientEnabled);
      const lines = state.lyrics.lines;
      const index = state.lyrics.timingMode === 'none' ? 0 : activeLine(lines, position);
      if (renderedDocument !== state.lyrics || renderedIndex !== index) {
        renderedDocument = state.lyrics; renderedIndex = index; words = []; line.replaceChildren();
        const current = lines[index];
        if (current) {
          if (current.words?.length && state.lyrics.timingMode === 'word') {
            for (const word of current.words) {
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
      }
      for (const word of words) {
        const progress = Math.min(1, Math.max(0, (position - word.start) / Math.max(1, word.end - word.start)));
        word.node.style.clipPath = `inset(0 ${(1 - progress) * 100}% 0 0)`;
      }
      translation.hidden = !s.showTranslation || !translation.textContent;
      next.hidden = !s.showNextLine || !next.textContent;
      raf = requestAnimationFrame(frame);
    };
    frame();
    return () => { disposed = true; cancelAnimationFrame(raf); root.replaceChildren(); root.classList.remove('lyric-surface'); };
  },
};
export const rendererPlugin: Plugin = {
  id: 'official.renderer.text', activate(ctx) { ctx.provide('renderer@1', renderer); },
};
