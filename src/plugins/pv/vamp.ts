import { breakRows, clamp01, easeOutCubic, isHan, isKana, isSpace, rng, splitAt } from './core';
import type { Face } from '../typeface';
import { blit, blitBand, sprite, type Sprite } from './paint';
import { faceFont, type PvEnv, type PvFrame, type PvLine, type PvStyle } from './stage';

// Vampire: heavy white gothic over crimson. Upcoming characters wait as thin
// crimson outlines and slam in solid when sung; the line erases from its first
// character. Short hero lines split huge kanji to the edges with a ticker of the
// line running between them. Toned down from the PV for everyday songs: no red
// field, small jitter, and the slab offset only plays during the entrance.
const WHITE = '#ffffff', CRIMSON = '#d8001c', GHOST = '#ff2a44';

interface Glyph { solid: Sprite; ghost: Sprite; x: number; y: number; index: number; rot: number; big: boolean }
interface Layout {
  hero: boolean; size: number; glyphs: Glyph[]; seed: number;
  echo?: { sprite: Sprite; x: number; y: number; scale: number };
  ticker?: { sprite: Sprite; x0: number; x1: number; y: number };
  translation?: { sprite: Sprite; x: number; y: number };
}

const solidGlyph = (text: string, size: number, k: number, face: Face) => {
  const w = size * 1.5, h = size * 1.5;
  return sprite(w, h, k, g => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle';
    const d = size * 0.055;
    // Hard crimson drop, a dark rim for light desktops, then the white face.
    g.fillStyle = CRIMSON; g.fillText(text, w / 2 + d, h / 2 + d);
    g.lineJoin = 'round'; g.strokeStyle = 'rgba(40,0,8,0.55)'; g.lineWidth = Math.max(1.5, size * 0.07);
    g.strokeText(text, w / 2, h / 2);
    g.fillStyle = WHITE; g.fillText(text, w / 2, h / 2);
  });
};
const ghostGlyph = (text: string, size: number, k: number, face: Face) => {
  const w = size * 1.5, h = size * 1.5;
  return sprite(w, h, k, (g, k) => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.shadowColor = 'rgba(40,0,8,0.5)'; g.shadowBlur = 2 * k;
    g.strokeStyle = GHOST; g.lineWidth = Math.max(1, size * 0.03); g.strokeText(text, w / 2, h / 2);
  });
};
const lineSprite = (text: string, size: number, k: number, outline: boolean, face: Face) => {
  const probe = document.createElement('canvas').getContext('2d');
  if (probe) probe.font = faceFont(face, size);
  const w = (probe?.measureText(text).width ?? size * text.length) + size, h = size * 1.6;
  return sprite(w, h, k, (g, k) => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    if (outline) {
      g.strokeStyle = GHOST; g.lineWidth = Math.max(1, size * 0.025); g.strokeText(text, w / 2, h / 2);
    } else {
      g.shadowColor = 'rgba(92,0,13,0.85)'; g.shadowBlur = Math.max(2, size * 0.18) * k;
      g.strokeStyle = 'rgba(40,0,8,0.6)'; g.lineWidth = Math.max(1.5, size * 0.12); g.strokeText(text, w / 2, h / 2);
      g.shadowBlur = 0; g.fillStyle = WHITE; g.fillText(text, w / 2, h / 2);
    }
  });
};

function layout(g: CanvasRenderingContext2D, line: PvLine, env: PvEnv): Layout {
  const { width: W, height: H, dpr } = env;
  const random = rng(line.seed);
  const glyphs = line.glyphs.map(glyph => glyph === '\n' ? ' ' : glyph);
  const visible = glyphs.filter(glyph => !isSpace(glyph)).length;
  const result: Layout = { hero: line.hero, size: env.size, glyphs: [], seed: line.seed };
  const face = line.face('heavy');
  const scaleOf = (glyph: string) => isHan(glyph) ? 1.08 : isKana(glyph) ? 0.86 : 0.9;
  const translationH = env.showTranslation && line.translation ? env.size * 0.5 : 0;
  const top = 0, bottom = H - translationH;

  // Hero split: two to four characters thrown to the edges, huge, with a ticker between.
  if (line.hero && visible >= 2 && visible <= 4 && W > env.size * 9) {
    const S = Math.min((bottom - top) * 0.92, env.size * 2.6), k = dpr * 1.15;
    result.size = S;
    const chars = glyphs.filter(glyph => !isSpace(glyph));
    const left = chars.slice(0, Math.ceil(chars.length / 2)), right = chars.slice(left.length);
    const cy = (top + bottom) / 2;
    let x = W * 0.06 + S * 0.55, index = 0;
    const place = (glyph: string) => {
      const at = glyphs.indexOf(glyph, index); index = at + 1;
      result.glyphs.push({ solid: solidGlyph(glyph, S, k, face), ghost: ghostGlyph(glyph, S, k, face), x, y: cy, index: at, rot: 0, big: true });
    };
    for (const glyph of left) { place(glyph); x += S * 1.02; }
    const leftEdge = x - S * 0.5;
    x = W * 0.94 - S * 0.55 - (right.length - 1) * S * 1.02;
    const rightEdge = x - S * 0.5;
    for (const glyph of right) { place(glyph); x += S * 1.02; }
    if (rightEdge - leftEdge > env.size * 2) {
      const tickerText = `${chars.join('')}  ·  `.repeat(6);
      result.ticker = { sprite: lineSprite(tickerText, env.size * 0.34, dpr, false, face), x0: leftEdge, x1: rightEdge, y: cy };
    }
  } else {
    let S = env.size * (line.hero ? 1.45 : 1.0);
    g.font = faceFont(face, S);
    const advance = (i: number) => isSpace(glyphs[i]) ? S * 0.35 : g.measureText(glyphs[i]).width * scaleOf(glyphs[i]);
    const total = glyphs.reduce((sum, _, i) => sum + advance(i), 0);
    const rows = total > W * 0.86 || (line.hero && total > W * 0.6 && visible > 6) ? 2 : 1;
    const parts = splitAt(glyphs.map((_, i) => i), breakRows(glyphs, rows, advance, line.starts));
    const widest = Math.max(...parts.map(part => part.reduce((sum, i) => sum + advance(i), 0)));
    const stagger = rows > 1 ? S * 1.1 : 0;
    const fit = Math.min(1, (W * 0.9) / (widest + stagger), (bottom - top) / (rows * S * 1.12 + S * 0.2));
    S *= fit;
    const k = dpr * 1.3;
    const lineH = S * 1.1;
    const blockW = (widest + stagger) * fit;
    // Mirror composition (solid left, outlined echo right) when the line is short enough.
    const echo = env.options.echo !== false && W > env.size * 12 && blockW < W * 0.44;
    const x0 = echo ? W * 0.3 - blockW / 2 : (W - blockW) / 2;
    const y0 = (top + bottom) / 2 - (rows - 1) * lineH / 2;
    parts.forEach((part, r) => {
      let x = x0 + (r === 1 ? stagger * fit : 0);
      for (const i of part) {
        const w = advance(i) * fit;
        if (!isSpace(glyphs[i])) {
          const size = S * scaleOf(glyphs[i]);
          result.glyphs.push({ solid: solidGlyph(glyphs[i], size, k, face), ghost: ghostGlyph(glyphs[i], size, k, face),
            x: x + w / 2, y: y0 + r * lineH + (random() - 0.5) * S * 0.08, index: i, rot: (random() - 0.5) * 0.06, big: false });
        }
        x += w;
      }
    });
    if (echo) {
      const text = glyphs.join('').trim();
      const scale = line.hero ? 1.15 : 1;
      result.echo = { sprite: lineSprite(text, S, dpr * scale, true, face), x: W * 0.72, y: (top + bottom) / 2 + (line.hero ? -S * 0.1 : S * 0.05), scale };
    }
    result.size = S;
  }
  if (translationH) {
    const sprite = lineSprite(line.translation, env.size * 0.36, dpr, false, line.tface('gothic', 500));
    result.translation = { sprite, x: W / 2, y: H - translationH / 2 };
  }
  return result;
}

function draw(g: CanvasRenderingContext2D, layout: Layout, frame: PvFrame, env: PvEnv) {
  const { t, exit } = frame, n = layout.glyphs.length, S = layout.size;
  const step = Math.min(60, 1400 / Math.max(1, n));
  const kick = 1 + 0.06 * frame.beat.pulse;
  if (layout.echo) {
    const appear = clamp01((t - 120) / 260);
    blit(g, layout.echo.sprite, layout.echo.x, layout.echo.y, layout.echo.scale, 0, (0.42 + 0.25 * frame.beat.pulse) * appear * (1 - exit));
  }
  if (layout.ticker && env.motion !== false) {
    const { sprite: tick, x0, x1, y } = layout.ticker;
    g.save(); g.beginPath(); g.rect(x0, y - tick.h, x1 - x0, tick.h * 2); g.clip();
    const shift = (t * 0.07) % (tick.w / 6);
    blit(g, tick, x0 + tick.w / 2 - shift, y, 1, 0, 0.85 * clamp01((t - 200) / 200) * (1 - exit));
    g.restore();
  } else if (layout.ticker) blit(g, layout.ticker.sprite, layout.ticker.x0 + layout.ticker.sprite.w / 2, layout.ticker.y, 1, 0, 1 - exit);
  layout.glyphs.forEach((glyph, i) => {
    // Erase from the first character as the line leaves.
    const gone = clamp01(exit * 1.7 - (i / Math.max(1, n)) * 0.7);
    if (gone >= 1) return;
    const outline = clamp01((t - i * 18) / 80);
    const at = frame.wordAt(glyph.index);
    const fillAt = at !== undefined ? Math.max(0, at) + (i % 4) * 12 : 120 + i * step;
    const f = clamp01((t - fillAt) / 110);
    const y = glyph.y + gone * S * 0.18;
    if (f < 1) blit(g, glyph.ghost, glyph.x, y, 1, glyph.rot, outline * (1 - f) * (1 - gone));
    if (f <= 0) return;
    const pop = 1 + 0.28 * (1 - easeOutCubic(f));
    if (glyph.big && t - fillAt < 260) {
      // Slab entrance: three horizontal cuts slide in from alternating sides and lock.
      const e = easeOutCubic((t - fillAt) / 260), band = glyph.solid.h / 3;
      for (let b = 0; b < 3; b++) {
        const dx = (b % 2 ? 1 : -1) * (1 - e) * S * 0.22;
        blitBand(g, glyph.solid, b * band, band + 0.5, glyph.x + dx, y, f * (1 - gone));
      }
      return;
    }
    blit(g, glyph.solid, glyph.x, y, pop * kick, glyph.rot, f * (1 - gone));
  });
  if (layout.translation) {
    const e = easeOutCubic((t - 250) / 300);
    blit(g, layout.translation.sprite, layout.translation.x, layout.translation.y + (1 - e) * 6, 1, 0, e * (1 - exit));
  }
}

export const vampStyle: PvStyle<Layout> = {
  id: 'vamp', exitMs: 360,
  fonts: [],
  height: (size, translation) => size * 2.7 + (translation ? size * 0.5 : 0),
  layout, draw,
};
