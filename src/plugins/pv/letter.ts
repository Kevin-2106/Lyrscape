import { breakRows, clamp01, easeOutBack, easeOutCubic, isSpace, rng, splitAt } from './core';
import type { Face } from '../typeface';
import { blit, rgba, sprite, type Sprite } from './paint';
import { faceFont, hue, type PvEnv, type PvFrame, type PvLine, type PvStyle } from './stage';

// Love letter: ivory rounded type blooming into a pink / mint glow, falling
// petals, and verses written on mint ornate labels or scalloped paper notes.
const IVORY = '#fffaf0';
const GLOW = { pink: '#ff7fb5', mint: '#36d9bd' };
const MINT = '#78c2ad';
const PAPER = '#fbf6ea';
const PEN = '#2c2b44';
const PETALS = ['#ffa6c9', '#ffe27a', '#9ff3dc', '#ffc2d8'];

interface Glyph { index: number; sprite: Sprite; x: number; y: number }
interface Part { glyphs: Glyph[]; bloom: Sprite; x: number; y: number; size: number; delay: number }
interface Petal { x: number; y: number; vx: number; vy: number; spin: number; size: number; color: string; delay: number }
interface Hero { hero: true; parts: Part[]; petals: Petal[]; script?: { sprite: Sprite; x: number; y: number } }
interface Card {
  hero: false; note: boolean; card: Sprite; x: number; y: number; rest: number; size: number;
  glyphs: Glyph[]; total: number;
}
type Layout = Hero | Card;

let measurer: CanvasRenderingContext2D | null | undefined;
const glyphSprite = (text: string, size: number, k: number, glow: string, face: Face, color: string, halo: boolean) => {
  measurer ??= document.createElement('canvas').getContext('2d');
  if (measurer) measurer.font = faceFont(face, size);
  const w = (measurer?.measureText(text).width ?? size) + size * 0.9, h = size * 1.9;
  return sprite(w, h, k, (g, k) => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle';
    const x = w / 2, y = h / 2 + size * 0.03;
    if (halo) {
      // A faint dark edge keeps ivory legible over bright desktops without reading as an outline.
      g.shadowColor = 'rgba(110,50,100,0.35)'; g.shadowBlur = size * 0.05 * k; g.fillStyle = color; g.fillText(text, x, y);
      g.shadowColor = rgba(glow, 0.9); g.shadowBlur = size * 0.24 * k; g.fillText(text, x, y); g.fillText(text, x, y);
      g.shadowBlur = 0;
    }
    g.fillStyle = color; g.fillText(text, x, y);
  });
};
const bloomSprite = (text: string, size: number, k: number, glow: string, width: number, face: Face) => {
  const w = width + size * 2, h = size * 2.6;
  return sprite(w, h, k, (g, k) => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.shadowColor = '#ffffff'; g.shadowBlur = size * 0.7 * k; g.fillText(text, w / 2, h / 2);
    g.shadowColor = glow; g.shadowBlur = size * 0.45 * k; g.fillText(text, w / 2, h / 2); g.fillText(text, w / 2, h / 2);
  });
};

function heroLayout(g: CanvasRenderingContext2D, line: PvLine, env: PvEnv): Hero {
  const { width: W, height: H, dpr } = env, S = env.size, k = dpr * 1.1;
  const glyphs = line.glyphs, halo = env.options.glow !== false;
  const mode = String(env.options.palette);
  const random = rng(line.seed);
  const duo = mode === 'duo' || mode === 'custom';
  const custom = mode === 'custom' ? { pink: hue(env, 'glowA', GLOW.pink), mint: hue(env, 'glowB', GLOW.mint) } : GLOW;
  const glowA = mode === 'mint' ? custom.mint : custom.pink, glowB = mode === 'pink' ? custom.pink : custom.mint;
  const ivory = hue(env, 'ink', IVORY);
  const face = line.face('maru', 500);
  g.font = faceFont(face, 100);
  const unit = glyphs.map(glyph => isSpace(glyph) ? 30 : g.measureText(glyph).width / 100);
  const count = glyphs.filter(glyph => glyph.trim()).length;
  const breaks = count >= 6 ? breakRows(glyphs, 2, i => unit[i], line.starts) : [];
  const groups = splitAt(glyphs.map((_, i) => i), breaks);
  const translation = env.showTranslation && line.translation;
  const parts: Part[] = [];
  // On wide overlays keep the two-part composition together instead of pinning it to the edges.
  const R = Math.min(W, S * 15), x0 = (W - R) / 2;
  const build = (indices: number[], size: number, glow: string, anchor: 'left' | 'right' | 'center', cy: number, maxWidth: number, delay: number) => {
    let widthAt = indices.reduce((sum, i) => sum + (isSpace(glyphs[i]) ? 0.3 : unit[i]), 0) * size;
    if (widthAt > maxWidth) { size *= maxWidth / widthAt; widthAt = maxWidth; }
    const left = anchor === 'left' ? x0 + R * 0.05 : anchor === 'right' ? x0 + R * 0.95 - widthAt : W / 2 - widthAt / 2;
    let x = left;
    const out: Glyph[] = [];
    for (const i of indices) {
      const adv = (isSpace(glyphs[i]) ? 0.3 : unit[i]) * size;
      if (!isSpace(glyphs[i])) out.push({ index: i, sprite: glyphSprite(glyphs[i], size, k, glow, face, ivory, halo), x: x + adv / 2, y: cy });
      x += adv;
    }
    const text = indices.map(i => glyphs[i]).join('').trim();
    parts.push({ glyphs: out, bloom: bloomSprite(text, size, dpr * 0.5, glow, widthAt, face), x: left + widthAt / 2, y: cy, size, delay });
  };
  const bottom = H - (translation ? S * 0.55 : 0);
  if (groups.length === 2) {
    build(groups[0], S * 0.78, glowA, 'left', S * 0.62, R * 0.62, 0);
    build(groups[1], S * 1.32, duo ? glowB : glowA, 'right', bottom - S * 0.88, R * 0.9, 160);
  } else {
    build(groups[0] ?? [], S * 1.35, duo ? (random() < 0.5 ? glowA : glowB) : glowA, 'center', bottom / 2 + S * 0.05, W * 0.9, 0);
  }
  const petals: Petal[] = [];
  if (env.options.petals !== false) for (let p = 0; p < 12; p++) {
    petals.push({ x: random() * W, y: -S * 0.3 - random() * H * 0.4, vx: (random() - 0.2) * S * 0.9 * env.amp, vy: (0.5 + random() * 0.8) * H,
      spin: (random() - 0.5) * 8, size: S * (0.1 + random() * 0.1), color: PETALS[p % PETALS.length], delay: random() * 600 });
  }
  const layout: Hero = { hero: true, parts, petals };
  if (translation) {
    const ts = S * 0.36;
    const s = glyphSprite(line.translation, ts, dpr, glowA, line.tface('script', 400, 'italic'), ivory, halo);
    layout.script = { sprite: s, x: Math.min(W * 0.95 - s.w / 2, W * 0.08 + s.w / 2), y: H - S * 0.32 };
  }
  return layout;
}

function cardLayout(g: CanvasRenderingContext2D, line: PvLine, env: PvEnv): Card {
  const { width: W, height: H, dpr } = env, k = dpr * 1.1;
  const note = (line.seed & 1) === 1;
  const face = note ? line.face('hand', 600) : line.face('maru', 500);
  let size = Math.max(14, env.size * 0.56);
  const glyphs = line.glyphs;
  g.font = faceFont(face, size);
  let advance = glyphs.map(glyph => glyph === '\n' ? 0 : isSpace(glyph) ? size * 0.35 : g.measureText(glyph).width);
  const padX = size * (note ? 1.1 : 1.4);
  const maxText = W * 0.9 - padX * 2;
  const indices = glyphs.map((_, i) => i);
  const hard = indices.filter(i => glyphs[i] === '\n');
  const total = advance.reduce((sum, value) => sum + value, 0);
  let rows = hard.length ? splitAt(indices, hard).map(row => row.filter(i => glyphs[i] !== '\n'))
    : total <= maxText ? [indices] : splitAt(indices, breakRows(glyphs, Math.min(3, Math.ceil(total / maxText)), i => advance[i], line.starts));
  const translation = env.showTranslation && line.translation ? line.translation : '';
  const header = note ? 0 : size * 0.85;
  const rowH = size * (note ? 1.55 : 1.35);
  const chrome = size * (note ? 0.9 : 1.0) + header;
  let widths = rows.map(row => row.reduce((sum, i) => sum + advance[i], 0));
  const fit = Math.min(1, maxText / Math.max(1, ...widths), (H * 0.86 - chrome) / (rows.length * rowH));
  if (fit < 1) { size *= fit; advance = advance.map(a => a * fit); widths = widths.map(w => w * fit); }
  rows = rows.filter(row => row.length);
  const textW = Math.max(...widths, size * 4);
  const w = textW + padX * 2, h = rows.length * rowH * Math.min(1, fit) + chrome * Math.min(1, fit);
  const random = rng(line.seed);
  const margin = 16;
  const card = sprite(w + margin * 2, h + margin * 2, k, (g, k) => {
    const x = margin, y = margin;
    if (note) {
      const r = size * 0.16;
      g.beginPath(); g.moveTo(x, y + r);
      for (let px = x; px < x + w; px += r * 2) g.arc(px + r, y + r, r, Math.PI, 0);
      g.lineTo(x + w, y + h - r);
      for (let px = x + w; px > x; px -= r * 2) g.arc(px - r, y + h - r, r, 0, Math.PI);
      g.closePath();
      g.shadowColor = 'rgba(70,50,30,0.28)'; g.shadowBlur = 9 * k; g.shadowOffsetY = 3 * k;
      g.fillStyle = PAPER; g.fill();
      g.shadowColor = 'transparent';
      g.strokeStyle = '#c9bfae'; g.lineWidth = 1.2; g.setLineDash([size * 0.22, size * 0.18]);
      rows.forEach((_, r2) => {
        const ly = y + size * 0.45 + (r2 + 1) * rowH * Math.min(1, fit) - size * 0.05;
        g.beginPath(); g.moveTo(x + size * 0.5, ly); g.lineTo(x + w - size * 0.5, ly); g.stroke();
      });
      g.setLineDash([]);
    } else {
      const r = size * 0.5;
      const path = (inset: number) => {
        const x0 = x + inset, y0 = y + inset, x1 = x + w - inset, y1 = y + h - inset, rr = Math.max(2, r - inset * 0.6);
        g.beginPath();
        g.moveTo(x0 + rr, y0); g.lineTo(x1 - rr, y0);
        g.arc(x1, y0, rr, Math.PI, Math.PI / 2, true); g.lineTo(x1, y1 - rr);
        g.arc(x1, y1, rr, -Math.PI / 2, Math.PI, true); g.lineTo(x0 + rr, y1);
        g.arc(x0, y1, rr, 0, -Math.PI / 2, true); g.lineTo(x0, y0 + rr);
        g.arc(x0, y0, rr, Math.PI / 2, 0, true); g.closePath();
      };
      path(0);
      g.shadowColor = 'rgba(25,80,70,0.3)'; g.shadowBlur = 10 * k; g.shadowOffsetY = 3 * k;
      g.fillStyle = MINT; g.fill(); g.shadowColor = 'transparent';
      path(size * 0.2); g.strokeStyle = '#c3eadc'; g.lineWidth = 1.4; g.stroke();
      // Dotted rule header, with the translation set in it when available.
      const hy = y + size * 0.62 + size * 0.2;
      g.fillStyle = 'rgba(255,255,255,0.85)';
      let gap = 0;
      if (translation) {
        g.font = faceFont(line.tface('gothic', 500), size * 0.34); g.textAlign = 'center'; g.textBaseline = 'middle';
        const tw = Math.min(w - size * 3, g.measureText(translation).width);
        g.fillText(translation, x + w / 2, hy, w - size * 3); gap = tw / 2 + size * 0.4;
      }
      for (let dx = size * 0.9; dx < w / 2 - size * 0.2; dx += size * 0.28) {
        if (w / 2 - dx < gap) continue;
        g.beginPath(); g.arc(x + dx, hy, size * 0.035, 0, Math.PI * 2); g.arc(x + w - dx, hy, size * 0.035, 0, Math.PI * 2); g.fill();
      }
    }
  }, (w + margin * 2) / 2, (h + margin * 2) / 2);
  const cx = W / 2 + (random() - 0.5) * Math.max(0, W - w) * 0.3, cy = H / 2;
  const top = cy - h / 2;
  const glyphOut: Glyph[] = [];
  let count = 0;
  rows.forEach((row, r) => {
    const rw = row.reduce((sum, i) => sum + advance[i], 0);
    let x = note ? cx - w / 2 + padX : cx - rw / 2;
    const y = top + header * Math.min(1, fit) + size * (note ? 0.45 : 0.55) + rowH * Math.min(1, fit) * (r + 0.5) + (note ? -size * 0.08 : 0);
    for (const i of row) {
      if (!isSpace(glyphs[i])) {
        glyphOut.push({ index: i, sprite: glyphSprite(glyphs[i], size, k, MINT, face, note ? PEN : IVORY, false), x: x + advance[i] / 2 - cx, y: y - cy });
        count++;
      }
      x += advance[i];
    }
  });
  return { hero: false, note, card, x: cx, y: cy, rest: (random() - 0.5) * 0.07, size, glyphs: glyphOut, total: count };
}

function drawHero(g: CanvasRenderingContext2D, layout: Hero, frame: PvFrame, env: PvEnv) {
  const { t, exit } = frame, amp = env.amp;
  if (env.motion) for (const p of layout.petals) {
    const tp = t - p.delay;
    if (tp <= 0 || tp > 2600) continue;
    const s = tp / 1000;
    const alpha = Math.min(1, tp / 200) * (tp > 1900 ? 1 - (tp - 1900) / 700 : 1) * (1 - exit) * 0.9;
    g.save(); g.globalAlpha = alpha; g.translate(p.x + p.vx * s + Math.sin(s * 3 + p.spin) * p.size * 2, p.y + p.vy * s * 0.6);
    g.rotate(p.spin * s); g.scale(1, 0.55 + 0.45 * Math.sin(s * 5 + p.spin));
    g.fillStyle = p.color; g.beginPath(); g.ellipse(0, 0, p.size, p.size * 0.6, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  for (const part of layout.parts) {
    const firstWord = part.glyphs.length ? frame.wordAt(part.glyphs[0].index) : undefined;
    const start = Math.max(part.delay, firstWord ?? 0);
    const tp = t - start;
    if (tp <= 0) continue;
    const float = env.motion ? Math.sin(t / 2600 * Math.PI * 2 + part.delay) * part.size * 0.025 * amp : 0;
    // Bloom flash: overexposed white-mint glow that settles into the crisp glyphs.
    if (env.motion && tp < 900) {
      const peak = tp < 90 ? tp / 90 : 1 - easeOutCubic((tp - 90) / 810);
      blit(g, part.bloom, part.x, part.y + float, 1 + 0.05 * amp * (1 - easeOutCubic(tp / 900)), 0, peak * Math.min(1, 0.95 * amp) * (1 - exit));
    }
    part.glyphs.forEach((glyph, i) => {
      const tg = tp - i * 45;
      if (tg <= 0) return;
      const e = easeOutCubic(tg / 380);
      const blur = env.motion ? ((1 - e) * part.size * 0.18 + exit * part.size * 0.16) * Math.min(1.5, amp) : 0;
      g.save();
      if (blur > 0.4) g.filter = `blur(${blur.toFixed(1)}px)`;
      const y = glyph.y + float + ((1 - e) * part.size * 0.2 - exit * part.size * 0.18) * amp;
      const kick = frame.beat.pulse;
      blit(g, glyph.sprite, glyph.x, y, 1 + 0.04 * kick, 0, e * (1 - exit));
      g.restore();
      if (kick > 0.02 && exit === 0) {
        // Beat: the pink / mint glow surges, as in the PV's pulsing bloom.
        g.save(); g.globalCompositeOperation = 'lighter';
        blit(g, glyph.sprite, glyph.x, y, 1.04 + 0.03 * kick, 0, 0.4 * Math.min(1, kick) * e);
        g.restore();
      }
      const at = frame.wordAt(glyph.index);
      if (at !== undefined && t >= at && t - at < 480 && exit === 0) {
        g.save(); g.globalCompositeOperation = 'lighter';
        blit(g, glyph.sprite, glyph.x, y, 1.03, 0, 0.55 * (1 - (t - at) / 480));
        g.restore();
      }
    });
  }
  if (layout.script) {
    const e = easeOutCubic((t - 500) / 600);
    blit(g, layout.script.sprite, layout.script.x - (1 - e) * 20, layout.script.y, 1, 0, e * (1 - exit));
  }
}

function drawCard(g: CanvasRenderingContext2D, layout: Card, frame: PvFrame, env: PvEnv) {
  const { t, exit } = frame, S = layout.size, amp = env.amp;
  const e = easeOutBack(t / 420, 1.6 * Math.min(1.5, amp)), settle = easeOutCubic(t / 420);
  const rotation = layout.rest + ((1 - settle) * -0.14 + exit * 0.08) * amp;
  const scale = (1 - 0.14 * amp * (1 - e)) * (1 - exit * 0.06) * (1 + 0.025 * frame.beat.pulse);
  g.translate(layout.x + exit * S * 1.4 * amp, layout.y - (1 - settle) * S * 0.7 * amp);
  g.rotate(rotation); g.scale(scale, scale);
  g.globalAlpha = clamp01(t / 120) * (1 - exit);
  blit(g, layout.card, 0, 0);
  const step = layout.note ? Math.min(70, 1100 / Math.max(1, layout.total)) : 12;
  layout.glyphs.forEach((glyph, i) => {
    const at = frame.wordAt(glyph.index);
    const appear = at !== undefined ? Math.max(120, at) : (layout.note ? 220 : 160) + i * step;
    const tg = t - appear;
    if (tg <= 0) return;
    const a = easeOutCubic(tg / (layout.note ? 220 : 180));
    // Notes ink in like handwriting; labels print with a short lift.
    blit(g, glyph.sprite, glyph.x, glyph.y + (layout.note ? 0 : (1 - a) * S * 0.2 * amp), layout.note ? 1 + 0.12 * amp * (1 - a) : 1, 0, a);
  });
}

export const letterStyle: PvStyle<Layout> = {
  id: 'letter', exitMs: 420,
  fonts: [],
  height: (size, translation) => size * 3.0 + (translation ? size * 0.45 : 0),
  layout: (g, line, env) => line.hero ? heroLayout(g, line, env) : cardLayout(g, line, env),
  draw(g, layout, frame, env) {
    if (layout.hero) drawHero(g, layout, frame, env); else drawCard(g, layout, frame, env);
  },
};
