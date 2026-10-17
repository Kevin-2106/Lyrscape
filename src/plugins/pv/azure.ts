import { breakRows, clamp01, easeInCubic, easeOutBack, easeOutCubic, isKana, isSpace, rng, splitAt } from './core';
import { faceFor, type Face } from '../typeface';
import { requestFonts } from './fonts';
import { blit, rgba, sprite, type Sprite } from './paint';
import { faceFont, hue, type PvEnv, type PvFrame, type PvLine, type PvScene, type PvStyle } from './stage';

// 一起出发: a bright youth-MV look (qa/pv-study/letsgo). Verses: rounded white
// glyphs inside a translucent sky strip, each one condensing out of a large
// cyan ghost while a four-point sparkle slides along a hairline to the newest
// glyph. Chorus: big white mincho stamped in glyph by glyph over a blue drop
// shadow, a sparkle burst at each landing, the last kana written on as a cyan
// outline; confetti tumbles, a title ticker crosses the corner, viewfinder
// brackets frame the stage. Short shouts switch to a heavy rounded face on a
// slanted cyan band, glyphs slamming in from the right with motion trails.
// Verses can also run vertically (as in the MV), which makes the stage taller.

const CONFETTI = ['#ffe14d', '#ff5fa2', '#5ee0ff', '#a77bff', '#b6ff5c', '#ffffff'];
/** Glyphs turned sideways in vertical text. */
const ROTATE = /^[ー〜~…‥—―\-–()（）「」『』【】〈〉《》[\]<>a-zA-Z0-9]$/u;
const CORNER = /^[、。，．,.]$/u;
const SMALL = /^[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]$/u;

interface Glyph { sprite: Sprite; ghost?: Sprite; x: number; y: number; index: number; w: number; rot: number }
interface Palette { ink: string; shadow: string; sky: string; cyan: string }
interface Caption {
  kind: 'caption'; vertical: boolean; T: number; glyphs: Glyph[];
  band: { x: number; y: number; w: number; h: number };
  rail: { x0: number; y0: number; x1: number; y1: number };
  translation?: { sprite: Sprite; x: number; y: number };
}
interface Chorus {
  kind: 'chorus'; seed: number; S: number; glyphs: Glyph[]; tilt: number; cx: number; cy: number;
  outline?: { text: string; x: number; y: number; font: string; size: number; rot: number };
  confetti: { x: number; y: number; w: number; h: number; c: string; vy: number; sway: number; spin: number; phase: number }[];
  sparkles: { x: number; y: number; s: number; phase: number }[];
  translation?: { sprite: Sprite; x: number; y: number };
}
interface Hook {
  kind: 'hook'; seed: number; S: number; glyphs: Glyph[]; band: { y: number; h: number; angle: number };
  grid: Sprite; translation?: { sprite: Sprite; x: number; y: number };
}
type Layout = Caption | Chorus | Hook;

const vertical = (env: PvEnv) => env.options.direction === 'vertical';
const palette = (env: PvEnv): Palette => ({ ink: hue(env, 'ink', '#ffffff'), shadow: hue(env, 'shadow', '#2a7fd4'), sky: hue(env, 'sky', '#4fc3ee'), cyan: hue(env, 'cyan', '#6fe3ff') });

/** Four-point sparkle. */
function sparkle(g: CanvasRenderingContext2D, x: number, y: number, s: number, color = '#ffffff', rotation = 0) {
  if (s <= 0.2) return;
  g.save(); g.translate(x, y); g.rotate(rotation); g.fillStyle = color;
  g.beginPath(); g.moveTo(0, -s);
  g.quadraticCurveTo(s * 0.12, -s * 0.12, s, 0); g.quadraticCurveTo(s * 0.12, s * 0.12, 0, s);
  g.quadraticCurveTo(-s * 0.12, s * 0.12, -s, 0); g.quadraticCurveTo(-s * 0.12, -s * 0.12, 0, -s);
  g.fill(); g.restore();
}

let measure: CanvasRenderingContext2D | null | undefined;
const widthOf = (text: string, face: Face, size: number) => {
  measure ??= document.createElement('canvas').getContext('2d');
  if (!measure) return size * text.length;
  measure.font = faceFont(face, size); return measure.measureText(text).width;
};

// ---------- Sprites ----------

const roundGlyph = (text: string, size: number, k: number, face: Face, p: Palette) => {
  const w = size * 1.5, h = size * 1.5;
  return sprite(w, h, k, (g, k) => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = rgba(p.shadow, 0.75); g.shadowBlur = size * 0.16 * k; g.shadowOffsetY = size * 0.04 * k;
    g.fillStyle = p.ink; g.fillText(text, w / 2, h / 2);
    g.shadowColor = 'transparent'; g.fillText(text, w / 2, h / 2);
  });
};
/** The large translucent cyan ghost a verse glyph condenses from. */
const ghostGlyph = (text: string, size: number, k: number, face: Face, p: Palette) => {
  const w = size * 1.5, h = size * 1.5;
  return sprite(w, h, k, (g, k) => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = rgba(p.cyan, 0.9); g.shadowBlur = size * 0.12 * k;
    g.fillStyle = rgba(p.cyan, 0.55); g.fillText(text, w / 2, h / 2);
    g.lineWidth = Math.max(1, size * 0.03); g.strokeStyle = rgba('#ffffff', 0.7); g.strokeText(text, w / 2, h / 2);
  });
};
/** Chorus mincho: white face on a blue offset shadow, a hair of dark rim for pale desktops. */
const minchoGlyph = (text: string, size: number, k: number, face: Face, p: Palette) => {
  const w = size * 1.45, h = size * 1.45;
  return sprite(w, h, k, (g, k) => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    g.shadowColor = rgba(p.shadow, 0.6); g.shadowBlur = size * 0.1 * k;
    g.fillStyle = p.shadow; g.fillText(text, w / 2 + size * 0.04, h / 2 + size * 0.05);
    g.shadowColor = 'transparent';
    g.strokeStyle = 'rgba(10,40,90,0.35)'; g.lineWidth = Math.max(1, size * 0.025); g.strokeText(text, w / 2, h / 2);
    g.fillStyle = p.ink; g.fillText(text, w / 2, h / 2);
  });
};
/** Hook: heavy rounded white with a cyan outline and a pale offset outline. */
const hookGlyph = (text: string, size: number, k: number, face: Face, p: Palette) => {
  const w = size * 1.6, h = size * 1.6;
  return sprite(w, h, k, g => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    g.strokeStyle = 'rgba(220,248,255,0.95)'; g.lineWidth = size * 0.2; g.strokeText(text, w / 2 + size * 0.07, h / 2 + size * 0.07);
    g.strokeStyle = p.sky; g.lineWidth = size * 0.16; g.strokeText(text, w / 2, h / 2);
    g.strokeStyle = p.shadow; g.lineWidth = size * 0.05; g.strokeText(text, w / 2, h / 2);
    g.fillStyle = p.ink; g.fillText(text, w / 2, h / 2);
  });
};
const translationSprite = (text: string, size: number, k: number, face: Face, p: Palette) => {
  const w = widthOf(text, face, size) + size, h = size * 1.8;
  return sprite(w, h, k, (g, k) => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.strokeStyle = 'rgba(16,58,120,0.55)'; g.lineWidth = Math.max(1.5, size * 0.12); g.strokeText(text, w / 2, h / 2);
    g.shadowColor = rgba(p.shadow, 0.9); g.shadowBlur = size * 0.35 * k;
    g.fillStyle = p.ink; g.fillText(text, w / 2, h / 2);
  });
};

// ---------- Caption (verse) ----------

function captionLayout(line: PvLine, env: PvEnv): Caption {
  const { width: W, height: H, dpr } = env, p = palette(env), vert = vertical(env);
  const glyphs = line.glyphs.map(glyph => glyph === '\n' ? ' ' : glyph);
  const face = line.face('rounded', 800);
  const translation = env.showTranslation ? line.translation : '';
  const transH = translation ? env.size * 0.5 : 0;
  let T = env.size * (vert ? 0.56 : 0.62);
  const advance = (i: number) => isSpace(glyphs[i]) ? T * 0.35 : vert ? T * 1.04 : widthOf(glyphs[i], face, T) + T * 0.04;
  const total = glyphs.reduce((sum, _, i) => sum + advance(i), 0);
  const room = vert ? H - transH - T * 1.6 : W * 0.84;
  const columns = vert ? Math.min(3, Math.max(1, Math.ceil(total / room))) : 1;
  const parts = splitAt(glyphs.map((_, i) => i), breakRows(glyphs, columns, advance, line.starts));
  const longest = Math.max(...parts.map(part => part.reduce((sum, i) => sum + advance(i), 0)));
  const fit = Math.min(1, room / longest);
  T *= fit;
  const k = dpr * 1.15, out: Glyph[] = [];
  const cache = new Map<string, Sprite>(), ghosts = new Map<string, Sprite>();
  const make = (text: string) => {
    if (!cache.has(text)) { cache.set(text, roundGlyph(text, T, k, face, p)); ghosts.set(text, ghostGlyph(text, T, dpr * 0.8, face, p)); }
    return { sprite: cache.get(text)!, ghost: ghosts.get(text)! };
  };
  let band: Caption['band'], rail: Caption['rail'];
  if (vert) {
    const colW = T * 1.5, cx = W / 2 + (parts.length - 1) * colW / 2;
    const top = (H - transH - longest * fit) / 2;
    parts.forEach((part, c) => {
      let y = top + c * T * 0.9; // later columns start a little lower, as in the MV
      for (const i of part) {
        const a = advance(i) * fit, glyph = glyphs[i];
        if (!isSpace(glyph)) {
          const rot = ROTATE.test(glyph) ? Math.PI / 2 : 0;
          const dx = CORNER.test(glyph) ? T * 0.32 : SMALL.test(glyph) ? T * 0.1 : 0, dy = CORNER.test(glyph) ? -T * 0.3 : SMALL.test(glyph) ? -T * 0.08 : 0;
          out.push({ ...make(glyph), x: cx - c * colW + dx, y: y + a / 2 + dy, index: i, w: a, rot });
        }
        y += a;
      }
    });
    const w = colW * parts.length + T * 0.5, h = Math.min(H - transH, longest * fit + T * 2.2 + (parts.length - 1) * T * 0.9);
    band = { x: W / 2 - w / 2, y: (H - transH - h) / 2, w, h };
    rail = { x0: cx + T * 0.95, y0: band.y + T * 0.2, x1: cx + T * 0.95, y1: band.y + band.h - T * 0.2 };
  } else {
    const rowW = longest * fit, x0 = (W - rowW) / 2, cy = (H - transH) / 2;
    let x = x0;
    for (const i of parts[0] ?? []) {
      const a = advance(i) * fit;
      if (!isSpace(glyphs[i])) out.push({ ...make(glyphs[i]), x: x + a / 2, y: cy, index: i, w: a, rot: 0 });
      x += a;
    }
    const w = rowW + T * 2.6, h = T * 1.9;
    band = { x: W / 2 - w / 2, y: cy - h / 2, w, h };
    rail = { x0: band.x + T * 0.5, y0: cy + T * 0.72, x1: band.x + band.w - T * 0.5, y1: cy + T * 0.72 };
  }
  const result: Caption = { kind: 'caption', vertical: vert, T, glyphs: out, band, rail };
  if (translation) result.translation = { sprite: translationSprite(translation, env.size * 0.34, dpr, line.tface('rounded', 500), p), x: W / 2, y: H - transH / 2 };
  return result;
}

function drawCaption(g: CanvasRenderingContext2D, L: Caption, frame: PvFrame, env: PvEnv) {
  const { t, exit } = frame, T = L.T, amp = env.amp, p = palette(env), n = L.glyphs.length;
  // Strip opens along the reading direction and folds away on exit.
  const open = env.motion ? easeOutCubic(t / 320) : 1, close = 1 - easeInCubic(exit);
  const b = L.band;
  g.save();
  g.fillStyle = rgba(p.sky, 0.72 * close);
  if (L.vertical) g.fillRect(b.x, b.y, b.w, b.h * open);
  else g.fillRect(b.x, b.y, b.w * open, b.h);
  // Thin white edges, like the MV's glass strips.
  g.fillStyle = `rgba(255,255,255,${0.75 * close})`;
  if (L.vertical) { g.fillRect(b.x, b.y, 1.2, b.h * open); g.fillRect(b.x + b.w - 1.2, b.y, 1.2, b.h * open); }
  else { g.fillRect(b.x, b.y, b.w * open, 1.2); g.fillRect(b.x, b.y + b.h - 1.2, b.w * open, 1.2); }
  g.restore();
  const step = Math.min(110, 1300 / Math.max(1, n));
  let head = -1;
  L.glyphs.forEach((glyph, i) => {
    const at = frame.wordAt(glyph.index);
    const start = (at !== undefined ? Math.max(0, at) : 160 + i * step) + (at !== undefined ? 0 : 0);
    const tg = t - start;
    if (tg < 0) return;
    head = i;
    const e = env.motion ? easeOutCubic(tg / 260) : 1;
    const gone = clamp01(exit * 1.6 - (i / Math.max(1, n)) * 0.6);
    const drift = gone * T * 0.6 * amp;
    const along = L.vertical ? { x: 0, y: 1 } : { x: 1, y: 0 };
    // Ghost: large, offset along the line, condensing onto the glyph.
    if (glyph.ghost && env.motion && tg < 320) {
      const q = clamp01(tg / 320);
      blit(g, glyph.ghost, glyph.x + along.x * (1 - q) * T * 0.55 * amp, glyph.y + along.y * (1 - q) * T * 0.55 * amp, 1 + 0.8 * amp * (1 - easeOutCubic(q)), glyph.rot, (1 - q) * 0.9);
    }
    blit(g, glyph.sprite, glyph.x + along.x * drift, glyph.y + along.y * drift - (1 - e) * T * 0.12 * amp * (L.vertical ? 0 : 1), 1 + 0.03 * frame.beat.pulse, glyph.rot, clamp01(tg / 140) * (1 - gone));
  });
  // Hairline with a sparkle riding to the newest glyph.
  const r = L.rail, grow = (env.motion ? easeOutCubic(t / 500) : 1) * close;
  g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(r.x0, r.y0); g.lineTo(r.x0 + (r.x1 - r.x0) * grow, r.y0 + (r.y1 - r.y0) * grow); g.stroke();
  if (env.options.sparkles !== false && head >= 0 && exit < 0.9) {
    const glyph = L.glyphs[head];
    const sx = L.vertical ? r.x0 : glyph.x + glyph.w / 2, sy = L.vertical ? glyph.y + glyph.w / 2 : r.y0;
    const twinkle = 0.8 + 0.2 * Math.sin(t / 160);
    sparkle(g, sx, sy, T * 0.26 * twinkle * (1 + 0.3 * frame.beat.pulse), '#ffffff', t / 900);
  }
  if (L.translation) blit(g, L.translation.sprite, L.translation.x, L.translation.y, 1, 0, clamp01((t - 300) / 300) * close);
}

// ---------- Chorus ----------

function chorusLayout(line: PvLine, env: PvEnv): Chorus {
  const { width: W, height: H, dpr } = env, p = palette(env), vert = vertical(env);
  const random = rng(line.seed);
  const glyphs = line.glyphs.map(glyph => glyph === '\n' ? ' ' : glyph);
  const face = line.face('mincho', 700);
  const translation = env.showTranslation ? line.translation : '';
  const transH = translation ? env.size * 0.5 : 0, avail = H - transH;
  let S = env.size * (vert ? 1.45 : 1.55);
  const advance = (i: number) => isSpace(glyphs[i]) ? S * 0.35 : vert ? S * 1.02 : widthOf(glyphs[i], face, S) + S * 0.02;
  const total = glyphs.reduce((sum, _, i) => sum + advance(i), 0);
  const room = vert ? avail * 0.9 : W * 0.8;
  const count = Math.min(3, Math.max(1, Math.ceil(total / room)));
  const parts = splitAt(glyphs.map((_, i) => i), breakRows(glyphs, count, advance, line.starts));
  const longest = Math.max(...parts.map(part => part.reduce((sum, i) => sum + advance(i), 0)));
  const stagger = parts.length > 1 ? S * 0.8 : 0;
  const across = parts.length * S * 1.12;
  const fit = vert ? Math.min(1, room / (longest + stagger), W * 0.6 / across) : Math.min(1, room / (longest + stagger), avail * 0.92 / across);
  S *= fit;
  const k = dpr * 1.15, out: Glyph[] = [];
  const cache = new Map<string, Sprite>();
  const make = (text: string) => { if (!cache.has(text)) cache.set(text, minchoGlyph(text, S, k, face, p)); return cache.get(text)!; };
  let outline: Chorus['outline'];
  const last = glyphs.length - 1 - [...glyphs].reverse().findIndex(glyph => !isSpace(glyph));
  const outlined = last >= 2 && isKana(glyphs[last]);
  parts.forEach((part, r) => {
    let pos = 0;
    for (const i of part) {
      const a = advance(i) * fit, glyph = glyphs[i];
      // Rows / columns step like the MV's staggered blocks.
      const x = vert ? W / 2 + (parts.length - 1) * S * 0.56 - r * S * 1.12 : -longest * fit / 2 + pos + a / 2 + (r - (parts.length - 1) / 2) * stagger * fit;
      const y = vert ? (avail - longest * fit) / 2 + pos + a / 2 + r * stagger * fit * 0.5 : (r - (parts.length - 1) / 2) * S * 1.12;
      if (!isSpace(glyph)) {
        const rot = vert && ROTATE.test(glyph) ? Math.PI / 2 : 0;
        if (i === last && outlined) outline = { text: glyph, x: vert ? x : x, y, font: faceFont(face, S), size: S, rot };
        else out.push({ sprite: make(glyph), x, y, index: i, w: a, rot });
      }
      pos += a;
    }
  });
  if (outline) out.push({ sprite: make(outline.text), x: outline.x, y: outline.y, index: last, w: S, rot: outline.rot });
  const block = Math.floor(Math.max(0, line.index) / 4) % 2 === 1;
  const tilt = vert ? 0 : (block ? -1 : 0) * Number(env.options.tilt ?? 8) * Math.PI / 180;
  const confetti = env.options.confetti === false ? [] : Array.from({ length: 26 }, (_, i) => ({
    x: random() * W, y: random() * H, w: env.size * (0.1 + random() * 0.1), h: env.size * (0.06 + random() * 0.06), c: CONFETTI[i % CONFETTI.length],
    vy: 0.02 + random() * 0.035, sway: random() * env.size * 0.4, spin: (random() - 0.5) * 0.008, phase: random() * Math.PI * 2 }));
  const sparkles = env.options.sparkles === false ? [] : Array.from({ length: 5 }, () => ({ x: random() * W, y: random() * avail, s: env.size * (0.12 + random() * 0.14), phase: random() * 3000 }));
  const result: Chorus = { kind: 'chorus', seed: line.seed, S, glyphs: out, tilt, cx: vert ? 0 : W / 2, cy: vert ? 0 : avail / 2, outline, confetti, sparkles };
  if (translation) result.translation = { sprite: translationSprite(translation, env.size * 0.36, dpr, line.tface('rounded', 500), p), x: W / 2, y: H - transH / 2 };
  return result;
}

function drawChorus(g: CanvasRenderingContext2D, L: Chorus, frame: PvFrame, env: PvEnv) {
  const { t, exit } = frame, S = L.S, amp = env.amp, p = palette(env), n = L.glyphs.length, W = env.width, H = env.height;
  const live = clamp01(t / 300) * (1 - exit);
  // Confetti tumbles down the whole stage (looping), flipping as it turns.
  if (env.motion) for (const c of L.confetti) {
    const y = ((c.y + t * c.vy * amp) % (H + S)) - S * 0.5;
    const x = c.x + Math.sin(t / 900 + c.phase) * c.sway * amp;
    g.save(); g.globalAlpha = live * 0.9; g.translate(x, y); g.rotate(c.phase + t * c.spin * amp); g.scale(1, Math.cos(t / 380 + c.phase));
    g.fillStyle = c.c; g.fillRect(-c.w / 2, -c.h / 2, c.w, c.h); g.restore();
  }
  for (const s of L.sparkles) {
    const tw = env.motion ? 0.5 + 0.5 * Math.sin((t + s.phase) / 420) : 0.8;
    g.globalAlpha = live * tw; sparkle(g, s.x, s.y, s.s * (0.6 + 0.4 * tw)); g.globalAlpha = 1;
  }
  g.save();
  if (L.cx || L.cy) g.translate(L.cx, L.cy);
  if (L.tilt) g.rotate(L.tilt);
  const step = Math.min(150, 1500 / Math.max(1, n));
  let newest = -1, newestAge = Infinity;
  L.glyphs.forEach((glyph, i) => {
    const at = frame.wordAt(glyph.index);
    const start = at !== undefined ? Math.max(0, at) : 120 + i * step;
    const tg = t - start;
    if (tg < 0) return;
    if (tg < newestAge) { newestAge = tg; newest = i; }
    const isOutline = L.outline && glyph.index === L.glyphs[L.glyphs.length - 1].index && i === n - 1;
    const gone = clamp01(exit * 1.6 - (i / Math.max(1, n)) * 0.6);
    const float = env.motion ? Math.sin(t / 1600 + i * 0.7) * S * 0.015 * amp : 0;
    const y = glyph.y + float - gone * S * 0.35 * amp;
    if (isOutline && L.outline) {
      // Written on as a cyan outline, then kept as an outline.
      const o = L.outline, q = env.motion ? clamp01(tg / 650) : 1;
      g.save(); g.translate(glyph.x, y); if (o.rot) g.rotate(o.rot);
      g.font = o.font; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.lineCap = 'round';
      g.globalAlpha = 1 - gone;
      g.fillStyle = rgba('#ffffff', 0.18 * q); g.fillText(o.text, 0, 0);
      const dash = o.size * 9;
      g.setLineDash([dash * q, dash]); g.lineDashOffset = 0;
      g.strokeStyle = rgba(p.shadow, 0.5); g.lineWidth = Math.max(2, o.size * 0.05); g.strokeText(o.text, o.size * 0.03, o.size * 0.04);
      g.strokeStyle = p.cyan; g.lineWidth = Math.max(1.5, o.size * 0.035); g.strokeText(o.text, 0, 0);
      g.restore();
      return;
    }
    // Stamp: drops from a larger size with a brief overshoot and a white flash.
    const e = env.motion ? easeOutBack(tg / 220, 1.6 * Math.min(1.6, amp)) : 1;
    const scale = (1 + 0.35 * amp * (1 - e)) * (1 + 0.04 * frame.beat.pulse);
    const alpha = clamp01(tg / 80) * (1 - gone);
    blit(g, glyph.sprite, glyph.x, y, scale, glyph.rot, alpha);
    if (env.motion && tg < 220) {
      g.save(); g.globalCompositeOperation = 'lighter';
      blit(g, glyph.sprite, glyph.x, y, scale * 1.03, glyph.rot, 0.5 * (1 - tg / 220));
      g.restore();
    }
  });
  // Sparkle burst at the newest landing.
  if (newest >= 0 && env.motion && newestAge < 420 && exit === 0 && env.options.sparkles !== false) {
    const glyph = L.glyphs[newest], q = newestAge / 420;
    const s = S * 0.42 * Math.sin(Math.PI * Math.min(1, q * 1.3)) * Math.min(1.6, amp);
    sparkle(g, glyph.x + S * 0.55, glyph.y - S * 0.45, s, p.cyan, q * 1.2);
    sparkle(g, glyph.x + S * 0.55, glyph.y - S * 0.45, s * 0.55, '#ffffff', q * 1.2);
  }
  g.restore();
  frameDecor(g, env, frame.scene, live, t);
  if (L.translation) blit(g, L.translation.sprite, L.translation.x, L.translation.y, 1, 0, clamp01((t - 300) / 300) * (1 - exit));
  void W;
}

/** Viewfinder brackets, outline triangles and the title ticker. */
function frameDecor(g: CanvasRenderingContext2D, env: PvEnv, scene: PvScene, alpha: number, t: number) {
  if (alpha <= 0.01) return;
  const { width: W, height: H, size: S } = env;
  g.save(); g.globalAlpha = alpha;
  if (env.options.frame !== false) {
    const L = S * 0.32, m = S * 0.12;
    g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 2;
    g.beginPath();
    g.moveTo(m, m + L); g.lineTo(m, m); g.lineTo(m + L, m);
    g.moveTo(W - m - L, m); g.lineTo(W - m, m); g.lineTo(W - m, m + L);
    g.moveTo(W - m, H - m - L); g.lineTo(W - m, H - m); g.lineTo(W - m - L, H - m);
    g.moveTo(m + L, H - m); g.lineTo(m, H - m); g.lineTo(m, H - m - L);
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1.2;
    for (let i = 0; i < 2; i++) {
      const x = W * (0.12 + i * 0.74) + Math.sin(t / 2400 + i) * S * 0.2, y = H * (0.3 + i * 0.35), s = S * 0.3;
      g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s * 0.9, y + s * 0.5); g.lineTo(x - s * 0.9, y + s * 0.5); g.closePath(); g.stroke();
    }
  }
  if (env.options.ticker !== false) {
    const title = (scene.title.trim() || 'LYRSCAPE');
    const text = `${/[a-z]/i.test(title) ? title.toUpperCase() : title}  + + +  `;
    const face = faceFor('gothic', /[^\x00-\x7f]/.test(title) ? 'ja' : 'latin', text, 900);
    requestFonts([faceFont(face, 32)], text);
    const size = S * 0.2;
    g.save(); g.translate(W * 0.2, H * 0.12); g.rotate(-0.24);
    g.font = faceFont(face, size); g.textBaseline = 'middle'; g.fillStyle = 'rgba(255,255,255,0.92)';
    const unit = g.measureText(text).width || size * 10;
    const shift = env.motion ? (scene.position * 0.04) % unit : 0;
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(-W, -size * 0.85, W * 2.4, 1); g.fillRect(-W, size * 0.85, W * 2.4, 1);
    g.fillStyle = '#ffffff'; g.shadowColor = 'rgba(20,80,160,0.6)'; g.shadowBlur = 3;
    for (let x = -W - shift; x < W * 1.4; x += unit) g.fillText(text, x, 0);
    g.restore();
  }
  g.restore();
}

// ---------- Hook (short shouts) ----------

function hookLayout(line: PvLine, env: PvEnv): Hook {
  const { width: W, height: H, dpr } = env, p = palette(env);
  const items = line.glyphs.map((glyph, index) => ({ glyph, index })).filter(item => item.glyph !== '\n');
  const face = line.face('rounded', 900);
  const translation = env.showTranslation ? line.translation : '';
  const transH = translation ? env.size * 0.5 : 0;
  let S = env.size * 1.7;
  const advance = (glyph: string) => isSpace(glyph) ? S * 0.35 : widthOf(glyph, face, S) + S * 0.04;
  S *= Math.min(1, W * 0.78 / items.reduce((sum, item) => sum + advance(item.glyph), 0), (H - transH) * 0.8 / S);
  const k = dpr * 1.15, out: Glyph[] = [];
  let x = W / 2 - items.reduce((sum, item) => sum + advance(item.glyph), 0) / 2;
  const cy = (H - transH) / 2;
  const cache = new Map<string, Sprite>();
  items.forEach(({ glyph, index }, i) => {
    const a = advance(glyph);
    if (!isSpace(glyph)) {
      if (!cache.has(glyph)) cache.set(glyph, hookGlyph(glyph, S, k, face, p));
      out.push({ sprite: cache.get(glyph)!, x: x + a / 2, y: cy + (i % 2 ? -1 : 1) * S * 0.03, index, w: a, rot: 0 });
    }
    x += a;
  });
  const h = S * 1.25;
  const grid = sprite(W * 1.6, h, Math.max(0.5, dpr * 0.75), g => {
    g.fillStyle = p.sky; g.fillRect(0, 0, W * 1.6, h);
    g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 1;
    const cell = S * 0.22;
    g.beginPath();
    for (let gx = 0; gx < W * 1.6; gx += cell) { g.moveTo(gx, 0); g.lineTo(gx, h); }
    for (let gy = 0; gy < h; gy += cell) { g.moveTo(0, gy); g.lineTo(W * 1.6, gy); }
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(0, 0, W * 1.6, Math.max(2, S * 0.03)); g.fillRect(0, h - Math.max(2, S * 0.03), W * 1.6, Math.max(2, S * 0.03));
  });
  const result: Hook = { kind: 'hook', seed: line.seed, S, glyphs: out, band: { y: cy, h, angle: -0.14 }, grid };
  if (translation) result.translation = { sprite: translationSprite(translation, env.size * 0.36, dpr, line.tface('rounded', 500), p), x: W / 2, y: H - transH / 2 };
  return result;
}

function drawHook(g: CanvasRenderingContext2D, L: Hook, frame: PvFrame, env: PvEnv) {
  const { t, exit } = frame, S = L.S, amp = env.amp, W = env.width, n = L.glyphs.length, p = palette(env);
  const sweep = env.motion ? easeOutCubic(t / 260) : 1, leave = easeInCubic(exit);
  g.save();
  g.translate(W / 2, L.band.y); g.rotate(L.band.angle * Math.min(1.5, amp));
  // Band sweeps in from the left and out to the right.
  blit(g, L.grid, (sweep - 1) * W * 1.4 + leave * W * 1.4, 0, 1, 0, 0.92 * (1 - exit));
  g.restore();
  g.save();
  g.translate(W / 2, L.band.y); g.rotate(L.band.angle * 0.45 * Math.min(1.5, amp)); g.translate(-W / 2, -L.band.y);
  L.glyphs.forEach((glyph, i) => {
    const at = frame.wordAt(glyph.index);
    const start = at !== undefined ? Math.max(0, at) : 140 + i * 70;
    const tg = t - start;
    if (tg < 0) return;
    const q = env.motion ? clamp01(tg / 180) : 1, e = easeOutCubic(q);
    const fly = (1 - e) * S * 2.6 * amp + leave * W * 0.9;
    // Motion trails behind a glyph still flying in.
    if (q < 1) for (let k = 2; k >= 1; k--) blit(g, glyph.sprite, glyph.x + fly + k * S * 0.35 * amp * (1 - e), glyph.y, 1, 0, 0.18 * k * (1 - e));
    // Squash on impact.
    const settle = env.motion ? clamp01((tg - 180) / 160) : 1;
    const squash = q >= 1 ? Math.sin(Math.PI * settle) * 0.16 * amp : 0;
    g.save(); g.translate(glyph.x + fly, glyph.y); g.scale(1 + squash, 1 - squash * 0.8);
    blit(g, glyph.sprite, 0, 0, 1 + 0.05 * frame.beat.pulse, 0, clamp01(tg / 60) * (1 - exit));
    g.restore();
  });
  const last = L.glyphs[n - 1];
  if (last && env.motion && env.options.sparkles !== false) {
    const at = frame.wordAt(last.index);
    const tg = t - (at !== undefined ? Math.max(0, at) : 140 + (n - 1) * 70) - 180;
    if (tg > 0 && tg < 600) {
      const s = S * 0.5 * Math.sin(Math.PI * tg / 600) * Math.min(1.6, amp);
      sparkle(g, last.x + last.w * 0.6, last.y - S * 0.55, s, p.sky, tg / 500);
      sparkle(g, last.x + last.w * 0.6, last.y - S * 0.55, s * 0.5, '#ffffff', tg / 500);
    }
  }
  g.restore();
  if (L.translation) blit(g, L.translation.sprite, L.translation.x, L.translation.y, 1, 0, clamp01((t - 300) / 300) * (1 - exit));
}

export const azureStyle: PvStyle<Layout> = {
  id: 'azure', exitMs: 340,
  fonts: [],
  height: (size, translation, options) => (options.direction === 'vertical' ? size * 7.2 : size * 3.0) + (translation ? size * 0.5 : 0),
  layout: (_g, line, env) => {
    if (!line.hero) return captionLayout(line, env);
    const count = line.glyphs.filter(glyph => glyph.trim()).length;
    return env.options.hook !== false && count <= 6 && !vertical(env) ? hookLayout(line, env) : chorusLayout(line, env);
  },
  draw: (g, layout, frame, env) => {
    if (layout.kind === 'caption') drawCaption(g, layout, frame, env);
    else if (layout.kind === 'hook') drawHook(g, layout, frame, env);
    else drawChorus(g, layout, frame, env);
  },
};
