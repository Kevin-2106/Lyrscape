import type { Plugin } from '../kernel/host';
import type { AppState } from '../sdk/types';
import { createDomRenderer, ownRenderer } from './renderer';
import { optionalBeat } from './beat';
import { AURORA_RENDERER, auroraFields, normalizeConfig } from './management';
import './aurora.css';

const config = (state: AppState) => normalizeConfig(auroraFields, state.plugins.configs[AURORA_RENDERER]);

export const auroraPlugin: Plugin = {
  id: AURORA_RENDERER,
  activate(ctx) {
    const detector = optionalBeat(ctx);
    ctx.provide('renderer.aurora@1', ownRenderer(ctx, createDomRenderer({
      mount(root) {
        root.classList.add('aurora-surface');
        const ornament = document.createElement('div'); ornament.className = 'aurora-ornament';
        ornament.setAttribute('aria-hidden', 'true');
        for (let i = 0; i < 8; i++) {
          const spark = document.createElement('i'); spark.style.setProperty('--spark-index', String(i)); ornament.append(spark);
        }
        root.append(ornament);
        return () => {
          root.classList.remove('aurora-surface', 'aurora-glow', 'aurora-motion', 'aurora-sparks');
          delete root.dataset.entrance;
          for (const key of ['--entry-duration', '--entry-intensity', '--aurora-beat']) root.style.removeProperty(key);
          ornament.remove();
        };
      },
      revision: state => JSON.stringify(config(state)),
      frame(root, state) {
        const options = config(state);
        const amount = options.motion ? Number(options.beat) : 0;
        const beat = amount > 0 ? detector()?.sample() : undefined;
        const value = beat?.active ? (Math.min(1.5, beat.pulse * amount)).toFixed(3) : '0';
        if (root.style.getPropertyValue('--aurora-beat') !== value) root.style.setProperty('--aurora-beat', value);
      },
      line(root, line, state) {
        const options = config(state);
        root.dataset.entrance = String(options.entrance);
        root.style.setProperty('--entry-duration', `${options.duration}ms`);
        root.style.setProperty('--entry-intensity', String(options.intensity));
        root.classList.toggle('aurora-motion', Boolean(options.motion));
        root.classList.toggle('aurora-glow', Boolean(options.glow));
        root.classList.toggle('aurora-sparks', Boolean(options.sparks));
        // Only the first 96 units animate individually; very long lyrics keep one block.
        // Per-word timing stays on the original fill spans. Entrance delays are cosmetic.
        let units = Array.from(line.children) as HTMLElement[];
        if (!units.length) {
          const text = line.textContent ?? '';
          const segments: string[] = [];
          for (const item of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
            segments.push(item.segment); if (segments.length > 96) break;
          }
          if (segments.length <= 96) {
            line.replaceChildren();
            units = segments.map(text => { const span = document.createElement('span'); span.textContent = text; line.append(span); return span; });
          }
        }
        if (units.length > 96 || !units.length) {
          // Fresh block per revision restarts long-line entrances without forced layout.
          const block = document.createElement('span'); block.className = 'aurora-block';
          block.append(...Array.from(line.childNodes)); line.append(block); units = [block];
        }
        units.forEach((unit, index) => {
          unit.classList.add('aurora-unit');
          unit.style.setProperty('--entry-delay', `${Math.min(700, index * Number(options.stagger))}ms`);
          // Deterministic alternating direction avoids randomness on every render.
          unit.style.setProperty('--entry-sign', index % 2 ? '-1' : '1');
        });
        // Gradient text has transparent foreground color. A text-shadow on the
        // same element paints over its background-clipped gradient, so give
        // the crisp glyph a separate foreground layer above the shadow.
        const glyphs = [...line.querySelectorAll<HTMLElement>('.word-fill'),
          ...units.filter(unit => !unit.classList.contains('lyric-word') && !unit.querySelector('.lyric-word'))];
        for (const glyph of glyphs) {
          glyph.classList.add('aurora-glyph');
          glyph.dataset.glowText = glyph.textContent ?? '';
          const solid = document.createElement('span'); solid.className = 'aurora-solid';
          solid.textContent = glyph.textContent;
          const glow = document.createElement('span'); glow.className = 'aurora-glow-layer';
          glow.setAttribute('aria-hidden', 'true'); glow.dataset.glowText = glyph.dataset.glowText;
          glyph.replaceChildren(glow, solid);
        }
        // Decoration belongs to the mount, not the lyric revision: keep stars
        // alive so their slow twinkle doesn't restart on every line/config.
      },
    })));
  },
};
