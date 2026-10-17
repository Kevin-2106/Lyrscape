import { breakRows, clamp01, isSpace, rng, splitAt } from './core';
import { faceFor, type Face } from '../typeface';
import { requestFonts } from './fonts';
import { blit, font, rgba, sprite, type Sprite } from './paint';
import { GRID, pixelMask, pixelSprite, type PixelMask } from './pixel';
import { faceFont, hue, type PvEnv, type PvFrame, type PvLine, type PvScene, type PvStyle } from './stage';

// 游戏开发部: a retro game-club look (no reference video; built from the club's
// motifs: a handheld RPG, its dialogue windows and a pixel arcade HUD). Verses
// are typed into a pixel dialogue box under a member's name plate (with her
// halo colour) and end on a blinking ▼. Chorus lines are huge pixel glyphs that
// drop in from above on choppy retro frames with a pink / green double drop
// shadow, bursting coins and pixel stars, "+100" pops and a closing cheer.
// SCORE, a draining life bar (song progress) and the stage number sit in the
// corners; CRT scanlines darken only what is drawn, so the desktop stays clear.

const MEMBERS = [
  { id: 'momoi', name: 'MOMOI', color: '#ff6fae' },
  { id: 'midori', name: 'MIDORI', color: '#7bd957' },
  { id: 'yuzu', name: 'YUZU', color: '#ff9a3d' },
  { id: 'aris', name: 'ARIS', color: '#4fa8ff' },
];
const PINK = '#ff6fae', GREEN = '#7bd957', GOLD = '#ffd84a', NAVY = '#14173a';
const CHEERS = ['NICE!', 'GREAT!', 'LEVEL UP!', 'COMBO!', 'CLEAR!'];
/** 4 × 4 ordered-dither thresholds for the pixel dissolve. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

interface Cell { sprite: Sprite; x: number; y: number; index: number; w: number }
interface Dialogue {
  kind: 'dialogue'; T: number; member: typeof MEMBERS[number]; glyphs: Cell[];
  box: { x: number; y: number; w: number; h: number }; tag?: Sprite; translation?: Sprite; total: number;
}
interface Title {
  kind: 'title'; seed: number; S: number; glyphs: (Cell & { fades: Sprite[]; drop: number; spin: number })[];
  member: typeof MEMBERS[number]; cheer: Sprite; top: number; translation?: { sprite: Sprite; x: number; y: number };
}
type Layout = Dialogue | Title;

const memberOf = (line: PvLine, env: PvEnv) => {
  const cast = String(env.options.cast ?? 'rotate');
  return MEMBERS.find(member => member.id === cast) ?? MEMBERS[Math.max(0, line.index) % MEMBERS.length];
};
/** Retro frame clock: time snapped to whole frames of `fps` (0 = smooth). */
const retro = (t: number, env: PvEnv) => {
  const fps = Number(env.options.fps ?? 12);
  return fps > 0 && env.motion ? Math.floor(t / (1000 / fps)) * (1000 / fps) : t;
};
let measure: CanvasRenderingContext2D | null | undefined;
const advanceOf = (glyph: string, face: Face, size: number) => {
  measure ??= document.createElement('canvas').getContext('2d');
  if (!measure) return size;
  measure.font = faceFont(face, GRID);
  return Math.max(GRID * 0.5, measure.measureText(glyph).width) / GRID * size;
};
const arcade = (text: string) => { const face = faceFor('arcade', 'latin', text); requestFonts([faceFont(face, 32)], text); return face; };
/** Crisp Latin label in the arcade face (rendered at a multiple of its 8 px grid). */
function label(text: string, px: number, k: number, fill: string, outline = NAVY): Sprite {
  const face = arcade(text), size = Math.max(8, Math.round(px / 8) * 8);
  const w = text.length * size + size, h = size * 2;
  return sprite(w, h, k, g => {
    g.font = faceFont(face, size); g.textBaseline = 'middle'; g.textAlign = 'center'; g.imageSmoothingEnabled = false;
    g.fillStyle = outline;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1], [2, 2]]) g.fillText(text, w / 2 + dx * size / 8, h / 2 + dy * size / 8);
    g.fillStyle = fill; g.fillText(text, w / 2, h / 2);
  });
}

// ---------- Dialogue (verse) ----------

function dialogueLayout(line: PvLine, env: PvEnv): Dialogue {
  const { width: W, height: H, dpr } = env;
  const member = memberOf(line, env), ink = hue(env, 'ink', '#ffffff');
  const glyphs = line.glyphs.map(glyph => glyph === '\n' ? ' ' : glyph);
  const face = line.face('pixel');
  const translation = env.showTranslation ? line.translation : '';
  // Whole font pixels: the 12 px face doubled, tripled… keeps every block square.
  let T = Math.max(12, Math.round(env.size * 0.56 / 6) * 6);
  const pad = () => T * 0.75;
  const room = () => Math.min(W * 0.94, T * 30) - pad() * 2;
  const advance = (i: number) => isSpace(glyphs[i]) ? T * 0.5 : advanceOf(glyphs[i], face, T);
  let total = glyphs.reduce((sum, _, i) => sum + advance(i), 0);
  const maxRows = translation ? 2 : 3;
  while (total > room() * maxRows && T > 12) { T -= 6; total = glyphs.reduce((sum, _, i) => sum + advance(i), 0); }
  const rows = Math.min(maxRows, Math.max(1, Math.ceil(total / room())));
  const parts = splitAt(glyphs.map((_, i) => i), breakRows(glyphs, rows, advance, line.starts));
  const lineH = T * 1.35, k = dpr;
  const widest = Math.max(...parts.map(part => part.reduce((sum, i) => sum + advance(i), 0)));
  const w = Math.min(W * 0.96, Math.max(widest + pad() * 2, T * 14)), h = parts.length * lineH + pad() * 1.4 + (translation ? T * 1.1 : 0);
  const box = { x: Math.round((W - w) / 2), y: Math.round(Math.max(T * 0.9, H - h - T * 0.25)), w: Math.round(w), h: Math.round(h) };
  const masks = new Map<string, Sprite>(), out: Cell[] = [];
  parts.forEach((part, r) => {
    let x = box.x + pad();
    for (const i of part) {
      const a = advance(i);
      if (!isSpace(glyphs[i])) {
        let s = masks.get(glyphs[i]);
        if (!s) { s = pixelSprite(pixelMask(glyphs[i], face, 0), T, k, { fill: ink, drops: [{ color: 'rgba(0,0,0,0.55)', dx: 2, dy: 2 }] }); masks.set(glyphs[i], s); }
        out.push({ sprite: s, x: Math.round(x + a / 2), y: Math.round(box.y + pad() * 0.8 + lineH * (r + 0.5)), index: i, w: a });
      }
      x += a;
    }
  });
  const result: Dialogue = { kind: 'dialogue', T, member, glyphs: out, box, total: out.length };
  if (env.options.names !== false) result.tag = label(member.name, T * 0.6, k, '#ffffff', NAVY);
  if (translation) {
    const tface = line.tface('pixel'), ts = Math.max(12, T * 0.75);
    result.translation = sprite(box.w - pad() * 2, ts * 1.6, k, g => {
      g.font = faceFont(tface, ts); g.textBaseline = 'middle'; g.fillStyle = rgba(ink, 0.62);
      let text = translation;
      while (text.length > 1 && g.measureText(text).width > box.w - pad() * 2) text = text.slice(0, -2) + '…';
      g.fillText(text, 0, ts * 0.8);
    }, 0, 0);
  }
  return result;
}

/** Window with a stepped pixel border: white outer frame, member-colour inner frame. */
function windowFrame(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, px: number, fill: string, accent: string) {
  const notch = (inset: number, color: string) => {
    g.fillStyle = color;
    g.fillRect(x + inset + px, y + inset, w - inset * 2 - px * 2, h - inset * 2);
    g.fillRect(x + inset, y + inset + px, w - inset * 2, h - inset * 2 - px * 2);
  };
  notch(0, '#ffffff'); notch(px, accent); notch(px * 2, fill);
}

function drawDialogue(g: CanvasRenderingContext2D, L: Dialogue, frame: PvFrame, env: PvEnv) {
  const { t, exit } = frame, T = L.T, px = Math.max(2, Math.round(T / 8));
  const q = retro(t, env);
  // Opens in three steps from a thin bar; closes in two.
  const open = env.motion ? [0.08, 0.45, 1][Math.min(2, Math.floor(q / 60))] : 1;
  const close = exit <= 0 ? 1 : exit < 0.5 ? 0.5 : 0;
  if (close <= 0) return;
  const b = L.box, h = Math.max(px * 4, b.h * open * close), y = b.y + (b.h - h) / 2;
  g.save(); g.imageSmoothingEnabled = false;
  windowFrame(g, b.x, Math.round(y), b.w, Math.round(h), px, hue(env, 'box', '#1b1f3b'), L.member.color);
  if (L.tag) {
    // Name plate with the member's halo above it.
    const tw = L.tag.w * 0.8, th = T * 0.95, tx = b.x + T * 0.6, ty = Math.round(y - th * 0.7);
    windowFrame(g, tx, ty, Math.round(tw), Math.round(th), px, L.member.color, '#ffffff');
    blit(g, L.tag, tx + tw / 2, ty + th / 2);
    g.strokeStyle = L.member.color; g.lineWidth = px;
    g.beginPath(); g.ellipse(tx + tw * 0.18, ty - px * 3, T * 0.32, T * 0.1, 0, 0, Math.PI * 2); g.stroke();
  }
  if (open < 1 || close < 1) { g.restore(); return; }
  // Typewriter: real word timing reveals words as sung (one glyph per 30 ms inside a word); otherwise a steady 45 ms per glyph.
  let typed = 0;
  L.glyphs.forEach((glyph, i) => {
    const at = frame.wordAt(glyph.index);
    const first = at !== undefined ? L.glyphs.findIndex(other => frame.wordAt(other.index) === at) : 0;
    const shown = at !== undefined ? Math.max(0, at) + (i - first) * 30 : 160 + i * 45;
    if (t < shown) return;
    typed++;
    // Freshly typed glyph hops one pixel, like a text blip.
    const hop = env.motion && t - shown < 50 ? -px : 0;
    blit(g, glyph.sprite, glyph.x, glyph.y + hop);
  });
  if (L.translation && typed === L.total) blit(g, L.translation, b.x + T * 0.75, b.y + b.h - T * 0.55 - L.translation.h, 1, 0, 1);
  if (typed === L.total && env.motion && Math.floor(t / 320) % 2 === 0) {
    // ▼ prompt in the corner.
    const cx = b.x + b.w - T * 0.9, cy = b.y + b.h - T * 0.55, s = Math.round(T * 0.22);
    g.fillStyle = '#ffffff';
    for (let r = 0; r < 3; r++) g.fillRect(cx - s * (2.5 - r), cy + (r - 1) * s, s * (5 - r * 2), s);
  }
  g.restore();
}

// ---------- Title (chorus) ----------

function titleLayout(line: PvLine, env: PvEnv): Title {
  const { width: W, height: H, dpr } = env;
  const member = memberOf(line, env), ink = hue(env, 'ink', '#ffffff');
  const random = rng(line.seed);
  const glyphs = line.glyphs.map(glyph => glyph === '\n' ? ' ' : glyph);
  const face = line.face('pixel');
  const transH = env.showTranslation && line.translation ? env.size * 0.5 : 0;
  let S = env.size * 1.6;
  const advance = (i: number) => isSpace(glyphs[i]) ? S * 0.5 : advanceOf(glyphs[i], face, S) + S * 0.12;
  const total = glyphs.reduce((sum, _, i) => sum + advance(i), 0);
  const rows = total > W * 0.9 ? 2 : 1;
  const parts = splitAt(glyphs.map((_, i) => i), breakRows(glyphs, rows, advance, line.starts));
  const widest = Math.max(...parts.map(part => part.reduce((sum, i) => sum + advance(i), 0)));
  // Keep clear of the HUD row along the top.
  const hud = env.options.hud === false ? 0 : Math.max(8, Math.round(env.size * 0.2 / 8) * 8) * 1.8;
  const avail = H - transH - hud;
  const fit = Math.min(1, W * 0.94 / widest, avail / (rows * S * 1.12));
  S *= fit;
  // Snap to whole cells so blocks stay square on any DPR.
  const cell = Math.max(1, Math.round(S / GRID * dpr) / dpr); S = cell * GRID;
  const k = dpr, lineH = S * 1.12;
  const top = hud + (avail - parts.length * lineH) / 2;
  const masks = new Map<string, { solid: Sprite; fades: Sprite[] }>();
  const out: Title['glyphs'] = [];
  const make = (text: string) => {
    let made = masks.get(text);
    if (!made) {
      const mask: PixelMask = pixelMask(text, face, 1);
      const look = { fill: ink, rim: { color: NAVY, width: 1 }, drops: [{ color: PINK, dx: -2.5, dy: 2.5 }, { color: GREEN, dx: 2.5, dy: 2.5 }] };
      const solid = pixelSprite(mask, S, k, look);
      // Dissolve steps: fewer cells each step, in ordered-dither order, still outlined.
      const fades = [12, 8, 4].map(level => pixelSprite(mask, S, k, { ...look, drops: [], keep: (x, y) => BAYER[(y % 4) * 4 + (x % 4)] < level }));
      made = { solid, fades }; masks.set(text, made);
    }
    return made;
  };
  parts.forEach((part, r) => {
    const rowW = part.reduce((sum, i) => sum + advance(i), 0) * fit;
    let x = (W - rowW) / 2;
    for (const i of part) {
      const a = advance(i) * fit;
      if (!isSpace(glyphs[i])) {
        const made = make(glyphs[i]);
        out.push({ sprite: made.solid, fades: made.fades, x: Math.round(x + a / 2), y: Math.round(top + lineH * (r + 0.5)), index: i, w: a, drop: 0.8 + random() * 0.6, spin: random() });
      }
      x += a;
    }
  });
  const cheer = label(CHEERS[line.seed % CHEERS.length], Math.max(8, S * 0.22), k, GOLD, NAVY);
  const result: Title = { kind: 'title', seed: line.seed, S, glyphs: out, member, cheer, top };
  if (transH) {
    const tface = line.tface('pixel'), ts = Math.max(12, Math.round(env.size * 0.36 / 6) * 6);
    measure ??= document.createElement('canvas').getContext('2d');
    if (measure) measure.font = faceFont(tface, ts);
    const w = (measure?.measureText(line.translation).width ?? ts * line.translation.length) + ts;
    result.translation = { sprite: sprite(w, ts * 1.8, k, g => {
      g.font = faceFont(tface, ts); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = NAVY; g.fillText(line.translation, w / 2 + 2, ts * 0.9 + 2);
      g.fillStyle = ink; g.fillText(line.translation, w / 2, ts * 0.9);
    }), x: W / 2, y: H - transH / 2 };
  }
  return result;
}

/** Coin: a stepped yellow disc that "spins" by narrowing. */
function coin(g: CanvasRenderingContext2D, x: number, y: number, s: number, phase: number) {
  const w = Math.max(1, Math.round(s * Math.abs(Math.cos(phase)))), h = Math.round(s);
  g.fillStyle = '#b8860b'; g.fillRect(Math.round(x - w / 2) + 1, Math.round(y - h / 2) + 1, w, h);
  g.fillStyle = GOLD; g.fillRect(Math.round(x - w / 2), Math.round(y - h / 2), w, h);
  if (w > s * 0.4) { g.fillStyle = '#fff6b0'; g.fillRect(Math.round(x - w / 4), Math.round(y - h / 3), Math.max(1, Math.round(w / 5)), Math.round(h / 2)); }
}
/** Plus-shaped pixel star. */
function pixelStar(g: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  const u = Math.max(1, Math.round(s / 3));
  g.fillStyle = color;
  g.fillRect(Math.round(x - u / 2), Math.round(y - u * 1.5), u, u * 3);
  g.fillRect(Math.round(x - u * 1.5), Math.round(y - u / 2), u * 3, u);
}

function drawTitle(g: CanvasRenderingContext2D, L: Title, frame: PvFrame, env: PvEnv) {
  const { t, exit } = frame, S = L.S, amp = env.amp, n = L.glyphs.length;
  const q = retro(t, env);
  const step = Math.min(110, 1400 / Math.max(1, n));
  g.save(); g.imageSmoothingEnabled = false;
  let landedAll = n > 0, lastLand = 0;
  L.glyphs.forEach((glyph, i) => {
    const at = frame.wordAt(glyph.index);
    const start = at !== undefined ? Math.max(0, at) : 140 + i * step;
    const tg = q - start;
    if (tg < 0) { landedAll = false; return; }
    // Drop from above with two retro bounces.
    const fall = 220 * glyph.drop;
    let dy = 0;
    if (env.motion) {
      if (tg < fall) dy = -(1 - (tg / fall) ** 2) * S * 1.3 * amp;
      else if (tg < fall + 160) dy = -Math.sin(Math.PI * (tg - fall) / 160) * S * 0.22 * amp;
      else if (tg < fall + 260) dy = -Math.sin(Math.PI * (tg - fall - 160) / 100) * S * 0.07 * amp;
    }
    if (tg < fall) landedAll = false;
    lastLand = Math.max(lastLand, start + fall);
    const kick = frame.beat.pulse > 0.3 && i % 2 === frame.beat.index % 2 ? -Math.round(S / GRID * 2) : 0;
    // Exit: ordered-dither dissolve in three steps, staggered left to right.
    const gone = clamp01(exit * 1.6 - (i / Math.max(1, n)) * 0.6);
    if (gone > 0) {
      const level = Math.floor(gone * 4);
      if (level >= 4) return;
      blit(g, level === 0 ? glyph.sprite : glyph.fades[level - 1], glyph.x, glyph.y);
      return;
    }
    blit(g, glyph.sprite, glyph.x, Math.round(glyph.y + dy + kick));
    // Landing burst: coins and stars thrown up, falling back, blinking out.
    if (env.options.particles !== false && env.motion && tg >= fall && tg < fall + 700) {
      const p = (tg - fall) / 700, random = rng(L.seed ^ (glyph.index + 7) * 2654435761);
      for (let c = 0; c < 4; c++) {
        const vx = (random() - 0.5) * S * 1.6 * amp, vy = -(0.6 + random() * 0.7) * S * 1.4 * amp;
        const x = glyph.x + vx * p, y = glyph.y - S * 0.4 + vy * p + S * 2.4 * p * p;
        if (p > 0.7 && Math.floor(q / 60) % 2) continue;
        if (c % 2 === 0) coin(g, x, y, S * 0.16, q / 90 + c);
        else pixelStar(g, x, y, S * 0.16, c === 1 ? L.member.color : '#ffffff');
      }
      // Score pop on the first glyph of each sung word.
      if (at !== undefined && L.glyphs.findIndex(other => frame.wordAt(other.index) === at) === i || at === undefined && i % 4 === 0) {
        const pop = hudLabel('+100', Math.max(8, S * 0.18), env.dpr, GOLD);
        blit(g, pop, glyph.x, glyph.y - S * 0.7 - p * S * 0.5, 1, 0, p > 0.75 ? 0 : 1);
      }
    }
  });
  // Closing cheer once every glyph has landed.
  if (landedAll && exit === 0 && env.motion) {
    const tc = q - lastLand - 120;
    if (tc > 0 && tc < 1400) {
      const last = L.glyphs[n - 1], blink = tc > 1000 && Math.floor(q / 80) % 2;
      if (!blink) blit(g, L.cheer, Math.min(env.width - L.cheer.w / 2, last.x + S * 0.4), last.y - S * 0.8 - Math.min(1, tc / 120) * S * 0.2);
    }
  }
  g.restore();
  if (L.translation) blit(g, L.translation.sprite, L.translation.x, L.translation.y, 1, 0, clamp01((t - 300) / 200) * (1 - exit));
}

// ---------- HUD and CRT ----------

const hudCache = new Map<string, Sprite>();
function hudLabel(text: string, px: number, k: number, color: string) {
  const key = `${text}\u0000${px}\u0000${k}\u0000${color}`;
  let result = hudCache.get(key);
  if (!result) {
    if (hudCache.size > 80) { for (const value of hudCache.values()) { value.canvas.width = 0; value.canvas.height = 0; } hudCache.clear(); }
    result = label(text, px, k, color, NAVY); hudCache.set(key, result);
  }
  return result;
}
function backdrop(g: CanvasRenderingContext2D, { scene, current, motion }: { scene: PvScene; current?: PvLine; motion: boolean }, env: PvEnv) {
  if (env.options.hud === false) return;
  const { width: W, height: H, size, dpr } = env, px = Math.max(8, Math.round(size * 0.2 / 8) * 8);
  if (!current) {
    if (!motion || Math.floor(scene.position / 600) % 2 === 0) { const s = hudLabel('PRESS START', px, dpr, '#ffffff'); blit(g, s, W / 2, H / 2); }
    return;
  }
  const score = `SCORE ${String(Math.floor(Math.max(0, scene.position) / 100) * 10).padStart(6, '0')}`;
  const s = hudLabel(score, px, dpr, '#ffffff');
  blit(g, s, s.w / 2 - px * 0.5, px * 0.9);
  const stage = `STAGE ${1 + Math.floor(Math.max(0, current.index) / 8)}-${Math.max(0, current.index) % 8 + 1}`;
  const st = hudLabel(stage, px, dpr, GOLD);
  blit(g, st, W - st.w / 2 + px * 0.5, px * 0.9);
  // Life bar drains with the song.
  const life = scene.durationMs ? clamp01(1 - scene.position / scene.durationMs) : 1, cells = 10, cw = px * 0.9, x0 = s.w - px * 0.2;
  g.fillStyle = NAVY; g.fillRect(x0 - 2, px * 0.45 - 2, cells * (cw + 2) + 2, px * 0.9 + 4);
  for (let c = 0; c < cells; c++) {
    g.fillStyle = c < Math.ceil(life * cells) ? (life < 0.3 ? '#ff4a5a' : '#5dff7a') : '#3a3f6a';
    g.fillRect(x0 + c * (cw + 2), px * 0.45, cw, px * 0.9);
  }
}
function overlay(g: CanvasRenderingContext2D, _frame: unknown, env: PvEnv) {
  if (env.options.crt === false) return;
  const { width: W, height: H } = env, gap = Math.max(3, Math.round(env.size / 14));
  // Darken only pixels already drawn: the transparent desktop stays untouched.
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = 'rgba(0,0,10,0.22)';
  for (let y = -env.size; y < H + env.size; y += gap) g.fillRect(-env.size, y, W + env.size * 2, Math.max(1, gap / 3));
  g.globalCompositeOperation = 'source-over';
}

export const gamedevStyle: PvStyle<Layout> = {
  id: 'gamedev', exitMs: 320,
  fonts: [font(400, 16, '"Press Start 2P", monospace')],
  height: (size, translation) => size * 3.2 + (translation ? size * 0.5 : 0),
  layout: (_g, line, env) => line.hero ? titleLayout(line, env) : dialogueLayout(line, env),
  draw: (g, layout, frame, env) => layout.kind === 'title' ? drawTitle(g, layout, frame, env) : drawDialogue(g, layout, frame, env),
  backdrop, overlay,
};
