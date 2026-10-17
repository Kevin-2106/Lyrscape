import { breakRows, clamp01, easeOutBack, easeOutCubic, isHan, isSpace, lerp, rng, splitAt } from './core';
import { blit, blitBand, font, heart, mix, releaseSprites, scallopCircle, sprite, star, type Sprite } from './paint';
import type { Face } from '../typeface';
import { faceFont, hue, type PvEnv, type PvFrame, type PvLine, type PvStyle } from './stage';

// Candy pop: flat maroon kana, gradient kanji, soft white halo, sticker stars,
// and a torn maroon caption pill for verses.
// 假名 / 字幕条 colours come from the options; set before each layout (option changes rebuild layouts).
let INK = '#5c1a2b';
let PILL = '#4c1823';
const KANJI: [string, string][] = [
  ['#ff3d8b', '#b23cc8'], ['#ff8a12', '#ffc83a'], ['#3f5cf2', '#a35cf0'], ['#ef2638', '#ff6a55'], ['#e0409c', '#ff7d5a'],
];
const PARTICLES = 'がでははをにものと';

interface Glyph { index: number; sprite: Sprite; x: number; y: number; kanji: boolean; badge: boolean; sign: number; spin: number }
interface Particle { kind: number; x: number; y: number; vx: number; vy: number; spin: number; size: number; delay: number }
interface Layout {
  hero: boolean; size: number; glyphs: Glyph[]; cx: number; cy: number; tilt: number; width: number; height: number;
  particles: Particle[]; pill?: { sprite: Sprite; x: number; y: number; w: number }; translation?: { sprite: Sprite; x: number; y: number };
}

const glyphSprite = (glyph: string, size: number, k: number, fill: [string, string] | string, halo: boolean, advance: number, face: Face) => {
  const pad = size * 0.32, w = advance + pad * 2, h = size * 1.3 + pad * 2;
  return sprite(w, h, k, (g, k) => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round';
    const x = w / 2, y = h / 2 + size * 0.04;
    if (halo) {
      g.shadowColor = 'rgba(255,255,255,0.95)'; g.shadowBlur = size * 0.2 * k;
      g.strokeStyle = 'rgba(255,255,255,0.92)'; g.lineWidth = size * 0.15;
      g.strokeText(glyph, x, y); g.strokeText(glyph, x, y);
      g.shadowBlur = 0;
    }
    if (typeof fill === 'string') g.fillStyle = fill;
    else {
      const gradient = g.createLinearGradient(x - advance / 2, y - size / 2, x + advance / 2, y + size / 2);
      gradient.addColorStop(0, fill[0]); gradient.addColorStop(1, fill[1]); g.fillStyle = gradient;
    }
    g.fillText(glyph, x, y);
  });
};
const badgeSprite = (glyph: string, size: number, k: number, face: Face) => {
  const r = size * 0.56, w = r * 2 + size * 0.5;
  return sprite(w, w, k, (g, k) => {
    g.shadowColor = 'rgba(255,255,255,0.9)'; g.shadowBlur = size * 0.18 * k;
    scallopCircle(g, w / 2, w / 2, r, 18, size * 0.035); g.fillStyle = PILL; g.fill();
    g.shadowBlur = 0;
    g.font = faceFont(face, size * 0.74); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#fff6f2'; g.fillText(glyph, w / 2, w / 2 + size * 0.03);
  });
};

const particleCache = new Map<string, Sprite>();
const STICKERS = ['#ff6fb1', '#ffd23f', '#b48cff', '#ff8fb8', '#5fd4ff'];
function particleSprite(kind: number, size: number, k: number): Sprite {
  const key = `${kind}:${size.toFixed(1)}:${k}`;
  let result = particleCache.get(key);
  if (result) return result;
  if (particleCache.size >= 60) { releaseSprites(particleCache.values()); particleCache.clear(); }
  const w = size * 1.5;
  result = sprite(w, w, k, g => {
    g.lineJoin = 'round'; g.lineWidth = size * 0.12; g.strokeStyle = INK;
    if (kind === 3) heart(g, w / 2, w / 2, size * 0.5); else if (kind === 4) { g.beginPath(); g.arc(w / 2, w / 2, size * 0.22, 0, Math.PI * 2); }
    else star(g, w / 2, w / 2, size * 0.58, 0.52);
    g.fillStyle = STICKERS[kind]; g.fill();
    if (kind !== 4) {
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.75)'; g.beginPath(); g.arc(w / 2 - size * 0.14, w / 2 - size * 0.14, size * 0.08, 0, Math.PI * 2); g.fill();
    }
  });
  particleCache.set(key, result);
  return result;
}

function translationSprite(text: string, size: number, k: number, measureWidth: number, face: Face): Sprite {
  const w = measureWidth + size * 1.2, h = size * 2;
  return sprite(w, h, k, (g, k) => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    g.shadowColor = 'rgba(255,255,255,0.95)'; g.shadowBlur = size * 0.35 * k;
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = size * 0.28; g.strokeText(text, w / 2, h / 2);
    g.shadowBlur = 0; g.fillStyle = INK; g.fillText(text, w / 2, h / 2);
  });
}

function heroLayout(g: CanvasRenderingContext2D, line: PvLine, env: PvEnv): Layout {
  const { width: W, dpr } = env;
  const base = env.size * 1.05, k = dpr * 1.3, halo = env.options.halo !== false;
  const glyphs = line.glyphs;
  const face = line.face('pop');
  g.font = faceFont(face, base);
  const advance = glyphs.map(glyph => isSpace(glyph) ? base * 0.35 : g.measureText(glyph).width);
  // Han word followed by a lone particle: the particle becomes a maroon badge (二人「が」).
  let run = 0; while (run < glyphs.length && isHan(glyphs[run])) run++;
  const badgeAt = run > 0 && run <= 3 && PARTICLES.includes(glyphs[run] ?? '') && glyphs.length - run > 2 ? run : -1;
  let rows: number[][];
  const indices = glyphs.map((_, i) => i);
  const total = advance.reduce((sum, value) => sum + value, 0);
  if (badgeAt > 0) rows = [indices.slice(0, badgeAt + 1), indices.slice(badgeAt + 1)];
  else if (total <= W * 0.8 && glyphs.length <= 9) rows = [indices];
  else rows = splitAt(indices, breakRows(glyphs, 2, i => advance[i], line.starts));
  rows = rows.map(row => {
    let a = 0, b = row.length; while (a < b && isSpace(glyphs[row[a]])) a++; while (b > a && isSpace(glyphs[row[b - 1]])) b--;
    return row.slice(a, b);
  }).filter(row => row.length);
  const stagger = rows.length > 1 ? base * 0.45 : 0;
  const rowWidth = (row: number[]) => row.reduce((sum, i) => sum + (i === badgeAt ? base * 1.2 : advance[i]), 0);
  const widest = Math.max(...rows.map(rowWidth)) + stagger;
  const fit = Math.min(1, (W * 0.9) / Math.max(1, widest), (env.height * 0.92) / (rows.length * base * 1.12));
  const size = base * fit;
  const translation = env.showTranslation && line.translation;
  const cy = env.height / 2 - (translation ? env.size * 0.3 : 0);
  const random = rng(line.seed);
  const custom = env.options.kanji === 'custom';
  const kanji: [string, string][] = custom ? [[hue(env, 'kanjiStart', '#ff3d8b'), hue(env, 'kanjiEnd', '#b23cc8')]] : KANJI;
  let palette = Math.floor(random() * kanji.length);
  const out: Glyph[] = [];
  const runColor = new Map<number, { colors: [string, string]; from: number; length: number }>();
  for (let i = 0; i < glyphs.length;) {
    if (!isHan(glyphs[i])) { i++; continue; }
    let j = i; while (j < glyphs.length && isHan(glyphs[j])) j++;
    const info = { colors: kanji[palette++ % kanji.length], from: i, length: j - i };
    for (let x = i; x < j; x++) runColor.set(x, info);
    i = j;
  }
  rows.forEach((row, r) => {
    const rw = rowWidth(row) * fit;
    let x = -rw / 2 + (rows.length > 1 ? (r === 0 ? 0.5 : -0.5) * stagger * fit : 0);
    const y = (r - (rows.length - 1) / 2) * size * 1.12;
    for (const i of row) {
      const glyph = glyphs[i], badge = i === badgeAt;
      const adv = badge ? size * 1.2 : advance[i] * fit;
      const info = runColor.get(i);
      const fill: [string, string] | string = info
        ? [mix(info.colors[0], info.colors[1], (i - info.from) / info.length), mix(info.colors[0], info.colors[1], (i - info.from + 1) / info.length)]
        : INK;
      if (!isSpace(glyph)) out.push({ index: i,
        sprite: badge ? badgeSprite(glyph, size, k, face) : glyphSprite(glyph, size, k, fill, halo, advance[i] * fit, face),
        x: x + adv / 2 + (badge ? size * 0.08 : 0), y: y - (badge ? size * 0.3 : 0), kanji: Boolean(info), badge,
        sign: random() < 0.5 ? -1 : 1, spin: (random() - 0.5) * 0.06,
      });
      x += adv;
    }
  });
  const blockW = widest * fit, blockH = rows.length * size * 1.12;
  const particles: Particle[] = [];
  if (env.options.particles !== false) {
    for (let p = 0; p < 16; p++) {
      const angle = random() * Math.PI * 2, speed = (0.5 + random() * 1.1) * size;
      particles.push({ kind: p % 6 === 5 ? 4 : Math.floor(random() * 4), x: (random() - 0.5) * blockW * 0.9, y: (random() - 0.5) * blockH * 0.6,
        vx: Math.cos(angle) * speed * 1.6 * env.amp, vy: Math.sin(angle) * speed * 0.5 * env.amp, spin: (random() - 0.5) * 6, size: size * (0.28 + random() * 0.3), delay: random() * 120 });
    }
  }
  const layout: Layout = { hero: true, size, glyphs: out, cx: W / 2, cy, tilt: Number(env.options.tilt) * Math.PI / 180, width: blockW, height: blockH, particles };
  if (translation) {
    const ts = env.size * 0.36, tface = line.tface('maru', 500); g.font = faceFont(tface, ts);
    layout.translation = { sprite: translationSprite(line.translation, ts, dpr, g.measureText(line.translation).width, tface), x: W / 2, y: env.height - env.size * 0.42 };
  }
  return layout;
}

function captionLayout(g: CanvasRenderingContext2D, line: PvLine, env: PvEnv): Layout {
  const { width: W, dpr } = env;
  const k = dpr * 1.1, glyphs = line.glyphs;
  let size = Math.max(13, env.size * 0.5);
  const face = line.face('pop');
  g.font = faceFont(face, size);
  let advance = glyphs.map(glyph => glyph === '\n' ? 0 : isSpace(glyph) ? size * 0.4 : g.measureText(glyph).width);
  const pad = size * 1.2, maxText = W * 0.94 - pad * 2;
  const total = advance.reduce((sum, value) => sum + value, 0);
  const indices = glyphs.map((_, i) => i);
  const hardBreaks = indices.filter(i => glyphs[i] === '\n');
  let rows: number[][];
  if (hardBreaks.length) rows = splitAt(indices, hardBreaks).map(row => row.filter(i => glyphs[i] !== '\n'));
  else if (total <= maxText) rows = [indices];
  else if (total * 0.78 <= maxText) { const f = maxText / total; size *= f; advance = advance.map(a => a * f); rows = [indices]; }
  else rows = splitAt(indices, breakRows(glyphs, Math.min(4, Math.ceil(total / maxText)), i => advance[i], line.starts));
  const rowWidths = rows.map(row => row.reduce((sum, i) => sum + advance[i], 0));
  const maxRows = Math.max(1, Math.floor((env.height * 0.8) / (size * 1.4)));
  if (rows.length > maxRows || Math.max(...rowWidths) > maxText) {
    const f = Math.min(maxRows / rows.length, maxText / Math.max(...rowWidths), 1);
    size *= f; advance = advance.map(a => a * f); rowWidths.forEach((w, i) => { rowWidths[i] = w * f; });
  }
  const textW = Math.max(...rowWidths), pillPad = size * 1.1;
  const w = Math.min(W * 0.96, Math.max(textW + pillPad * 2 + size * 1.5, Math.min(W * 0.62, size * 22)));
  const h = rows.length * size * 1.4 + size * 0.75;
  const translation = env.showTranslation && line.translation;
  const top = env.height / 2 - h / 2 - (translation ? env.size * 0.28 : 0);
  const random = rng(line.seed);
  const pill = sprite(w + 24, h + 24, k, (g, k) => {
    const x = 12, y = 12, r = Math.min(h / 2, size * 0.9);
    g.beginPath();
    g.moveTo(x + r, y + h);
    g.arcTo(x, y + h, x, y, r);
    g.lineTo(x, y + r);
    g.arcTo(x, y, x + r, y, r);
    // Torn paper top edge.
    for (let px = x + r; px < x + w - r; px += size * 0.45) g.lineTo(px, y + (random() - 0.5) * size * 0.12);
    g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r); g.lineTo(x + w, y + h - r); g.arcTo(x + w, y + h, x + w - r, y + h, r);
    g.closePath();
    g.shadowColor = 'rgba(40,8,16,0.45)'; g.shadowBlur = 10 * k; g.shadowOffsetY = 3 * k;
    g.fillStyle = PILL; g.fill();
    g.shadowColor = 'transparent';
    g.strokeStyle = 'rgba(255,214,222,0.22)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x + r, y + 3); g.lineTo(x + w - r, y + 3); g.stroke();
  }, 12, 12);
  const out: Glyph[] = [];
  rows.forEach((row, r) => {
    let x = W / 2 - w / 2 + pillPad;
    const y = top + size * 0.375 + size * 0.7 + r * size * 1.4;
    for (const i of row) {
      if (!isSpace(glyphs[i])) out.push({ index: i, sprite: glyphSprite(glyphs[i], size, k, '#fff4f1', false, advance[i], face), x: x + advance[i] / 2, y, kanji: false, badge: false, sign: 1, spin: 0 });
      x += advance[i];
    }
  });
  const layout: Layout = { hero: false, size, glyphs: out, cx: W / 2, cy: top + h / 2, tilt: 0, width: w, height: h, particles: [],
    pill: { sprite: pill, x: W / 2 - w / 2, y: top, w } };
  if (translation) {
    const ts = env.size * 0.34, tface = line.tface('maru', 500); g.font = faceFont(tface, ts);
    layout.translation = { sprite: translationSprite(line.translation, ts, dpr, g.measureText(line.translation).width, tface), x: W / 2, y: top + h + env.size * 0.42 };
  }
  return layout;
}

function drawHero(g: CanvasRenderingContext2D, layout: Layout, frame: PvFrame, env: PvEnv) {
  const { t, exit } = frame, S = layout.size, amp = env.amp;
  const drift = env.motion && env.options.drift !== false ? lerp(0.14, -0.14, clamp01(t / 4500)) * S : 0;
  g.translate(layout.cx + drift, layout.cy);
  g.rotate(layout.tilt);
  if (t < 300) {
    // Entrance flash behind the words; kept faint so dark desktops don't turn grey.
    const alpha = 0.3 * (1 - t / 300) ** 2;
    const radius = Math.max(layout.width, layout.height) * 0.65;
    const glow = g.createRadialGradient(0, 0, 0, 0, 0, radius);
    glow.addColorStop(0, `rgba(255,255,255,${alpha})`); glow.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = glow; g.fillRect(-radius, -radius, radius * 2, radius * 2);
  }
  const n = layout.glyphs.length;
  layout.glyphs.forEach((glyph, i) => {
    const tg = t - i * 32 - (glyph.badge ? 140 : 0);
    if (tg <= 0) return;
    const bob = env.motion ? Math.sin(t / 1400 * Math.PI * 2 + i * 0.9) * S * 0.035 * amp : 0;
    const sway = env.motion ? Math.sin(t / 1900 * Math.PI * 2 + i * 1.3) * 0.025 * amp : 0;
    const out = clamp01(exit * 1.5 - (i / Math.max(1, n)) * 0.5);
    let bump = 0;
    const sung = frame.sung(glyph.index), at = frame.wordAt(glyph.index);
    if (sung >= 0 && at !== undefined && t >= at) bump = Math.sin(Math.PI * clamp01((t - at) / 260)) * 0.16;
    if (glyph.kanji && tg < 420 && out === 0) {
      // Kanji assemble from three bars sliding in from alternating sides.
      const band = glyph.sprite.h / 3;
      for (let b = 0; b < 3; b++) {
        const e = easeOutCubic((tg - b * 45) / 240);
        const dx = (b % 2 ? 1 : -1) * glyph.sign * (1 - e) * S * 1.4 * amp;
        blitBand(g, glyph.sprite, b * band, band + 0.5, glyph.x + dx, glyph.y + bob, clamp01((tg - b * 45) / 60));
      }
      return;
    }
    const e = glyph.kanji ? 1 : easeOutBack(tg / 300, 2.3 * Math.min(1.6, amp));
    const settle = easeOutCubic(tg / 300);
    // Beat: every glyph swells, alternate glyphs hop higher, like the PV's bouncing kana.
    const kick = frame.beat.pulse;
    const scale = e * (1 + bump + 0.1 * kick) * (1 - 0.45 * out);
    const rotation = ((1 - settle) * 0.55 * glyph.sign + out * 0.4 * glyph.sign) * amp + glyph.spin + sway;
    const y = glyph.y + bob + ((1 - settle) * S * 0.35 - out * S * 0.3) * amp - kick * S * (i % 2 ? 0.07 : 0.14);
    blit(g, glyph.sprite, glyph.x - out * S * 0.25, y, scale, rotation, clamp01(tg / 60) * (1 - out));
  });
  if (env.motion) for (const p of layout.particles) {
    const tp = t - p.delay;
    if (tp <= 0 || tp > 1300) continue;
    const travel = 1 - Math.exp(-tp / 380);
    const scale = easeOutBack(tp / 200, 2.6) * (tp > 900 ? 1 - (tp - 900) / 400 : 1);
    blit(g, particleSprite(p.kind, p.size, env.dpr), p.x + p.vx * travel, p.y + p.vy * travel + tp * tp * 0.00004 * S,
      scale, p.spin * tp / 1000, 1 - exit);
  }
}

function drawCaption(g: CanvasRenderingContext2D, layout: Layout, frame: PvFrame, amp: number) {
  const { t, exit } = frame, pill = layout.pill!, S = layout.size;
  const wipe = easeOutCubic(t / 260);
  g.translate(0, exit * S * 0.5 * amp);
  const k = 1 + 0.03 * frame.beat.pulse;
  if (k !== 1) {
    const cx = pill.x + pill.w / 2, cy = pill.y + layout.height / 2;
    g.translate(cx, cy); g.scale(k, k); g.translate(-cx, -cy);
  }
  g.globalAlpha = 1 - exit;
  g.save();
  g.beginPath(); g.rect(pill.x - 14, pill.y - 14, (pill.w + 28) * wipe, layout.height + 28); g.clip();
  blit(g, pill.sprite, pill.x, pill.y, 1, 0, clamp01(t / 80));
  g.restore();
  layout.glyphs.forEach((glyph, i) => {
    const at = frame.wordAt(glyph.index);
    // Real word timings reveal chunks as sung; otherwise the line types on once.
    const appear = at !== undefined ? Math.max(0, at) : 140 + i * 14;
    const tg = t - appear;
    if (tg < 0) return;
    const e = easeOutCubic(tg / 140);
    blit(g, glyph.sprite, glyph.x, glyph.y + (1 - e) * S * 0.25 * amp, 1, 0, e);
  });
}

export const popStyle: PvStyle<Layout> = {
  id: 'pop', exitMs: 260,
  fonts: [],
  height: (size, translation) => size * 2.8 + (translation ? size * 0.6 : 0),
  layout: (g, line, env) => {
    const ink = hue(env, 'ink', '#5c1a2b');
    // Sticker outlines bake the ink colour in.
    if (ink !== INK) { releaseSprites(particleCache.values()); particleCache.clear(); INK = ink; }
    PILL = hue(env, 'pill', '#4c1823');
    return (line.hero ? heroLayout : captionLayout)(g, line, env);
  },
  draw(g, layout, frame, env) {
    if (layout.hero) { g.save(); drawHero(g, layout, frame, env); g.restore(); }
    else { g.save(); drawCaption(g, layout, frame, env.amp); g.restore(); }
    if (layout.translation) {
      const e = easeOutCubic((frame.t - 200) / 300);
      blit(g, layout.translation.sprite, layout.translation.x, layout.translation.y + (1 - e) * 6, 1, 0, e * (1 - frame.exit));
    }
  },
};
