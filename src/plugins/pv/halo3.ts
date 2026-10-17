import { breakRows, clamp01, easeOutCubic, isSpace, rng, splitAt } from './core';
import { faceFor, type Face } from '../typeface';
import { requestFonts } from './fonts';
import { blit, blitBand, rgba, sprite, type Sprite } from './paint';
import { cellSprite, GRID, pixelMask, pixelSprite } from './pixel';
import { faceFont, hue, type PvEnv, type PvFrame, type PvLine, type PvScene, type PvStyle } from './stage';
import {
  backdrop as haloBackdrop, cardLayout, drawCard, FRAME, frameOf, haloTile, INK, MUTED, mosaicOf, plus, RULE, skyGlyph, tLineSprite, usePalette,
  WHITE, type CardLayout,
} from './halo';

// 晴空终端 III, rebuilt from the PV's chorus frames (qa/pv-study/heavenly3):
// huge white pixel lettering with rounded block corners spread over two or three
// staggered rows, a cyan pixel echo under each glyph and small snowflake / cross
// ornaments clipped onto them. A white "halo" placeholder tile hops onto a slot a
// few frames before its glyph cuts in through one frame of pixel blocks. Behind
// the words: tilted rows of white dashes drifting left, thin rings and flickering
// confetti dots; each line opens with white panels and a white veil, strong beats
// flash the stage, and the line leaves through a halftone dot (or stripe) wipe.
// Verses use the PV's two caption forms: the white "Lyrics" window, and the white
// subtitle strip with a field of white bars rising behind it.
// Everything steps on whole 30 fps frames, like the PV.

const CONFETTI = ['#d6f53a', '#ff9a3c', '#ff4a3a', '#3dff7a', '#39d9ff', '#ffffff'];
const SNAP: { snap: true } = { snap: true };

interface HeroGlyph {
  sprite: Sprite; mosaic: Sprite; echo?: Sprite; x: number; y: number; w: number; index: number;
  ornament?: { kind: number; dx: number; dy: number; s: number };
  /** Placeholder tile: lead in frames, the frame it hops from (offset), size. */
  tile?: { lead: number; hx: number; hy: number; s: number };
  /** Guide frame: offset from the glyph and size scale (the PV's frames sit a little off the letter). */
  guide?: { dx: number; dy: number; sw: number; sh: number };
  jolt: number;
}
interface HeroLayout {
  kind: 'hero'; seed: number; S: number; glyphs: HeroGlyph[];
  box: { x0: number; y0: number; x1: number; y1: number };
  rows: { y: number; dashes: { x: number; w: number }[]; speed: number }[];
  rings: { x: number; y: number; r: number; v: number }[];
  dots: { x: number; y: number; r: number; c: string; vx: number; vy: number; blink: number }[];
  crosses: { x: number; y: number; s: number }[];
  panels: { x: number; y: number; w: number; h: number }[];
  caption: { sprite: Sprite; x: number; y: number } | undefined;
  icon?: { x: number; y: number; s: number };
  translation?: { sprite: Sprite; x: number; y: number };
}
interface StripLayout {
  kind: 'strip'; seed: number; T: number; top: number; h: number;
  glyphs: { sprite: Sprite; x: number; y: number; index: number; chunk: number; w: number }[];
  chunks: number; bars: { x: number; w: number; h: number; delay: number; tone: number }[];
  checks: number[]; translation?: { sprite: Sprite; x: number; y: number };
}
type Layout = CardLayout | StripLayout | HeroLayout;

const glyphMode = (env: PvEnv) => String(env.options.glyph ?? 'pixel');
const on = (env: PvEnv, key: string) => env.options[key] !== false;

// ---------- Ornaments ----------

/** Six-armed snowflake with round tips, the PV's recurring halo ornament. */
function snowflake(g: CanvasRenderingContext2D, x: number, y: number, s: number) {
  g.lineCap = 'round'; g.lineWidth = s * 0.16;
  g.beginPath();
  for (let a = 0; a < 6; a++) {
    const c = Math.cos(a * Math.PI / 3), d = Math.sin(a * Math.PI / 3);
    g.moveTo(x, y); g.lineTo(x + c * s * 0.5, y + d * s * 0.5);
  }
  g.stroke();
  for (let a = 0; a < 6; a++) { g.beginPath(); g.arc(x + Math.cos(a * Math.PI / 3) * s * 0.55, y + Math.sin(a * Math.PI / 3) * s * 0.55, s * 0.12, 0, Math.PI * 2); g.fill(); }
  g.beginPath(); g.arc(x, y, s * 0.16, 0, Math.PI * 2); g.fill();
}
const cross = (g: CanvasRenderingContext2D, x: number, y: number, s: number) => {
  g.lineCap = 'round'; g.lineWidth = s * 0.18;
  g.beginPath(); g.moveTo(x - s / 2, y - s / 2); g.lineTo(x + s / 2, y + s / 2); g.moveTo(x + s / 2, y - s / 2); g.lineTo(x - s / 2, y + s / 2); g.stroke();
};
function ornament(g: CanvasRenderingContext2D, kind: number, x: number, y: number, s: number, deep: string) {
  g.save();
  g.shadowColor = rgba(deep, 0.55); g.shadowBlur = s * 0.25;
  g.fillStyle = WHITE; g.strokeStyle = WHITE;
  if (kind === 0) snowflake(g, x, y, s);
  else if (kind === 1) plus(g, x, y, s * 0.5);
  else if (kind === 2) cross(g, x, y, s * 0.6);
  else { g.fillRect(x - s * 0.3, y - s * 0.12, s * 0.24, s * 0.24); g.fillRect(x + s * 0.06, y - s * 0.12, s * 0.24, s * 0.24); }
  g.restore();
}
/** The placeholder: a plain white rounded tile. */
function placeholder(g: CanvasRenderingContext2D, x: number, y: number, s: number, deep: string) {
  const r = s * 0.16;
  g.save();
  g.fillStyle = rgba(deep, 0.22); roundBox(g, x - s / 2 + s * 0.05, y - s / 2 + s * 0.07, s, s, r); g.fill();
  g.fillStyle = WHITE; roundBox(g, x - s / 2, y - s / 2, s, s, r); g.fill();
  g.restore();
}

/** Guide frame (as in II, with the sky bar always on the top-left): a line that opens into a hairline box. */
const GUIDE_MS = 4 * FRAME;
function guideFrame(g: CanvasRenderingContext2D, glyph: HeroGlyph, S: number, step: number, alpha: number, bar: number, sky: string, deep: string) {
  const guide = glyph.guide;
  if (!guide || alpha <= 0.01 || step < 0) return;
  const w = (glyph.w * 0.92 + S * 0.1) * guide.sw, h = S * 0.98 * guide.sh;
  const x = glyph.x + guide.dx, y = glyph.y + guide.dy;
  // Frame 0: a horizontal line; then the full box.
  const gw = w * (step === 0 ? 0.7 : 1), gh = step === 0 ? 1 : h;
  g.save(); g.globalAlpha *= alpha; g.lineWidth = Math.max(1, S * 0.014);
  g.strokeStyle = rgba(deep, 0.35); g.strokeRect(x - gw / 2 + 1, y - gh / 2 + 1, gw, gh);
  g.strokeStyle = 'rgba(255,255,255,0.95)'; g.strokeRect(x - gw / 2, y - gh / 2, gw, gh);
  if (step >= 1) {
    g.save(); g.globalAlpha = bar; g.fillStyle = sky; g.fillRect(x - w / 2 - S * 0.04, y - h / 2 - S * 0.08, w * 0.4, Math.max(2, S * 0.045)); g.restore();
    g.fillStyle = 'rgba(255,255,255,0.95)';
    plus(g, x - w / 2, y + h / 2, S * 0.05); plus(g, x + w / 2, y - h / 2, S * 0.05);
  }
  g.restore();
}
function roundBox(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.roundRect?.(x, y, w, h, r) ?? g.rect(x, y, w, h);
}

// ---------- Hero (chorus) ----------

function heroGlyphSprite(text: string, S: number, k: number, face: Face, pixel: boolean, deep: string) {
  if (!pixel) return { sprite: skyGlyph(text, S, k, face) };
  // Two cells of growth make strokes about a sixth of the em, as heavy as the PV's
  // lettering; dense glyphs keep one so their counters stay open.
  const light = pixelMask(text, face, 1);
  const mask = light.density < 0.42 ? pixelMask(text, face, 2) : light;
  const solid = pixelSprite(mask, S, k, {
    fill: WHITE, round: 0.42,
    shadow: { color: deep, dx: 0.5, dy: 0.8, blur: 1.1, alpha: 0.55 },
    rim: { color: 'rgba(8,38,92,0.5)', width: 0.12 },
  });
  return { sprite: solid, mask };
}

function heroLayout(g: CanvasRenderingContext2D, line: PvLine, env: PvEnv): HeroLayout {
  const { width: W, height: H, dpr } = env;
  const palette = usePalette(env);
  const random = rng(line.seed), deco = rng(line.seed ^ 0x9e3779b9);
  const glyphs = line.glyphs.map(glyph => glyph === '\n' ? ' ' : glyph);
  const mode = glyphMode(env);
  // The 字体 option replaces the pixel face too (rasterised into blocks).
  const pixelFace = line.face('pixel');
  const gothicFace = line.face('gothic', 900);
  const transH = env.showTranslation && line.translation ? env.size * 0.55 : 0;
  const avail = H - transH;
  let S = env.size * 1.75;
  // Pixel advance: the bitmap face's own width, a little wider for the bold growth.
  g.font = faceFont(mode === 'gothic' ? gothicFace : pixelFace, S);
  const advance = (i: number) => isSpace(glyphs[i]) ? S * 0.45 : Math.max(S * 0.62, g.measureText(glyphs[i]).width) + S * 0.1;
  const total = glyphs.reduce((sum, _, i) => sum + advance(i), 0);
  const rows = Math.min(3, Math.max(1, Math.ceil(total / (W * 0.78))));
  const parts = splitAt(glyphs.map((_, i) => i), breakRows(glyphs, rows, advance, line.starts)).map(part => {
    let a = 0, b = part.length;
    while (a < b && isSpace(glyphs[part[a]])) a++; while (b > a && isSpace(glyphs[part[b - 1]])) b--;
    return part.slice(a, b);
  }).filter(part => part.length);
  const widths = parts.map(part => part.reduce((sum, i) => sum + advance(i), 0));
  // Rows step right, like the PV's staggered blocks (目覚め / 今を…).
  const step = parts.length > 1 ? S * 0.7 : 0;
  const widest = Math.max(...widths.map((w, r) => w + r * step));
  const fit = Math.min(1, W * 0.94 / widest, avail / (parts.length * S * 1.08 + S * 0.1));
  S *= fit;
  const lineH = S * 1.08, k = dpr * 1.1, block = Math.max(2, S / GRID * 2);
  const blockW = widest * fit;
  const x0 = Math.max(S * 0.1, (W - blockW) / 2 - S * 0.2), y0 = avail / 2 - (parts.length - 1) * lineH / 2;
  const out: HeroGlyph[] = [];
  const cache = new Map<string, ReturnType<typeof heroGlyphSprite>>();
  let order = 0;
  parts.forEach((part, r) => {
    // A single short row spreads its words apart, leaving the middle open as the PV does for the art.
    const spare = parts.length === 1 && widths[r] * fit < W * 0.55 ? Math.min(W * 0.94 - widths[r] * fit, S * 3) : 0;
    const split = spare > 0 ? part.findIndex((i, j) => j > 0 && j >= part.length / 2 - 0.5 && (line.starts.has(i) || j === Math.ceil(part.length / 2))) : -1;
    let x = (spare > 0 ? (W - widths[r] * fit - spare) / 2 : x0 + r * step * fit);
    part.forEach((i, j) => {
      if (j === split) x += spare;
      const w = advance(i) * fit;
      if (!isSpace(glyphs[i])) {
        const pixel = mode === 'pixel' || mode === 'mixed' && deco() < 0.6;
        const key = `${glyphs[i]}\u0000${pixel}`;
        let made = cache.get(key);
        if (!made) { made = heroGlyphSprite(glyphs[i], S, k, pixel ? pixelFace : gothicFace, pixel, palette.deep); cache.set(key, made); }
        const glyph: HeroGlyph = { sprite: made.sprite, mosaic: mosaicOf(made.sprite, block), x: x + w / 2, y: y0 + r * lineH + (random() - 0.5) * S * 0.04, w, index: i, jolt: random() };
        if (made.mask) {
          const mask = made.mask, seed = rng(line.seed ^ (i + 1) * 2246822519);
          // Dithered cyan trail under the glyph: checkerboard cells, thinned at random.
          glyph.echo = cellSprite(mask, S, Math.max(0.5, dpr * 0.6), hue(env, 'echo', '#3fd2ff'), (cx, cy) => (cx + cy) % 2 === 0 && seed() < 0.75);
        }
        if (on(env, 'ornaments') && deco() < 0.38) {
          const corner = deco();
          glyph.ornament = { kind: Math.floor(deco() * 4), dx: (corner < 0.5 ? -0.42 : 0.4) * w, dy: (deco() < 0.6 ? -0.42 : 0.38) * S, s: S * (0.2 + deco() * 0.12) };
        }
        if (on(env, 'placeholder') && (order === 0 || deco() < 0.5)) {
          glyph.tile = { lead: 2 + Math.floor(deco() * 3), hx: (deco() - 0.5) * S * 1.6, hy: (deco() - 0.5) * S * 0.7, s: S * (0.5 + deco() * 0.18) };
        }
        if (on(env, 'slots') && (order === 0 || deco() < 0.6)) glyph.guide = { dx: (deco() - 0.5) * S * 0.16, dy: (deco() - 0.5) * S * 0.12, sw: 0.96 + deco() * 0.14, sh: 0.98 + deco() * 0.1 };
        order++;
        out.push(glyph);
      }
      x += w;
    });
  });
  const box = out.length ? {
    x0: Math.min(...out.map(glyph => glyph.x - glyph.w / 2)), x1: Math.max(...out.map(glyph => glyph.x + glyph.w / 2)),
    y0: Math.min(...out.map(glyph => glyph.y)) - S * 0.55, y1: Math.max(...out.map(glyph => glyph.y)) + S * 0.55,
  } : { x0: 0, x1: W, y0: 0, y1: H };
  // Tilted dash rows in the upper part of the frame.
  const rowsOut: HeroLayout['rows'] = [];
  if (on(env, 'streaks')) for (let r = 0; r < 4; r++) {
    const dashes: { x: number; w: number }[] = [];
    let x = -deco() * S * 2;
    while (x < W + S * 4) { const w = S * (0.9 + deco() * 2.6); dashes.push({ x, w }); x += w + S * (0.25 + deco() * 0.6); }
    rowsOut.push({ y: S * 0.12 + r * Math.max(S * 0.2, H * 0.11), dashes, speed: 0.008 + deco() * 0.012 });
  }
  const rings = on(env, 'particles') ? Array.from({ length: 3 }, () => ({ x: deco() * W, y: deco() * H, r: S * (0.4 + deco() * 0.9), v: (deco() - 0.5) * 0.01 })) : [];
  const dots = on(env, 'particles') ? Array.from({ length: 16 }, (_, i) => ({ x: deco() * W, y: deco() * H, r: S * (0.025 + deco() * 0.045), c: CONFETTI[i % CONFETTI.length],
    vx: (deco() - 0.6) * 0.012, vy: (deco() - 0.5) * 0.008, blink: deco() })) : [];
  const crosses = on(env, 'particles') && box.x1 < W * 0.8 ? Array.from({ length: 5 }, (_, i) => ({ x: W * 0.86 + (i % 2) * S * 0.35, y: H * 0.42 + Math.floor(i / 2) * S * 0.35, s: S * 0.16 })) : [];
  const panels = [[-0.06, -0.1, 0.5, 1.15], [0.36, -0.02, 0.62, 0.9], [0.1, 0.32, 0.42, 0.75]].map(([px, py, pw, ph]) => ({
    x: box.x0 + (box.x1 - box.x0) * px, y: box.y0 + (box.y1 - box.y0) * py, w: (box.x1 - box.x0) * pw, h: (box.y1 - box.y0) * ph }));
  const result: HeroLayout = { kind: 'hero', seed: line.seed, S, glyphs: out, box, rows: rowsOut, rings, dots, crosses, panels, caption: undefined };
  // Small tracked caption under the dash rows (the PV's "… the New Covenant" line).
  if (on(env, 'hud')) {
    const text = 'HEAVENLY · LYRICS + CELEBRATION'.split('').join(' ');
    const label = faceFor('gothic', 'latin', text, 500);
    requestFonts([faceFont(label, 32)], text);
    const size = Math.max(7, env.size * 0.15), w = size * text.length * 0.62 + size;
    result.caption = { sprite: sprite(w, size * 2, dpr, gg => {
      gg.font = faceFont(label, size); gg.textBaseline = 'middle'; gg.fillStyle = 'rgba(40,60,90,0.75)'; gg.fillText(text, size * 0.5, size);
    }, 0, size), x: S * 0.3, y: box.y1 < H - size * 2 ? H - size * 1.2 : box.y0 > size * 2.5 ? size * 1.2 : -1 };
    if (result.caption.y < 0) result.caption = undefined;
  }
  // Lime halo tile: top-left when the block leaves room, otherwise just after the last glyph.
  if (on(env, 'accent') && out.length) {
    const lastGlyph = out[out.length - 1];
    if (box.x0 > S * 1.1) result.icon = { x: S * 0.55, y: S * 0.45, s: S * 0.42 };
    else if (lastGlyph.x + lastGlyph.w / 2 + S * 0.9 < W) result.icon = { x: lastGlyph.x + lastGlyph.w / 2 + S * 0.45, y: lastGlyph.y - S * 0.32, s: S * 0.4 };
  }
  if (transH) result.translation = { sprite: tLineSprite(line.translation, env.size * 0.36, dpr, line.tface('gothic', 700)), x: W / 2, y: H - transH / 2 };
  return result;
}

/** Dash rows, rings, confetti and crosses: the chorus field, drawn with the line so it fades with it. */
function field(g: CanvasRenderingContext2D, L: HeroLayout, frame: PvFrame, env: PvEnv, alpha: number, deep: string) {
  if (alpha <= 0.01) return;
  const position = env.motion ? frame.scene.position : 0, S = L.S, W = env.width, f = Math.floor(position / FRAME);
  g.save(); g.globalAlpha = alpha;
  g.save(); g.rotate(-0.05);
  for (const row of L.rows) {
    const span = W + S * 8, shift = (position * row.speed * env.amp) % span;
    for (const dash of row.dashes) {
      const x = ((dash.x - shift) % span + span) % span - S * 4, h = Math.max(2, S * 0.09);
      g.fillStyle = rgba(deep, 0.16); g.fillRect(x + 2, row.y + 2, dash.w, h);
      g.fillStyle = 'rgba(255,255,255,0.62)'; g.fillRect(x, row.y, dash.w, h);
    }
  }
  g.restore();
  if (L.caption) blit(g, L.caption.sprite, L.caption.x, L.caption.y, 1, 0, 0.9);
  g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1.2;
  for (const ring of L.rings) {
    const r = ring.r * (1 + 0.08 * Math.sin(position / 1700 + ring.x));
    g.beginPath(); g.arc(ring.x + position * ring.v * 0.3, ring.y, r, 0, Math.PI * 2); g.stroke();
  }
  for (const dot of L.dots) {
    // Confetti blinks on whole frames: some dots skip a frame or two now and then.
    if (rng(L.seed ^ Math.floor(f / 3) * 7919 ^ Math.round(dot.blink * 1e6))() < 0.18) continue;
    const x = ((dot.x + position * dot.vx * env.amp) % (W + S) + W + S) % (W + S) - S * 0.5;
    g.fillStyle = dot.c; g.beginPath(); g.ellipse(x, dot.y + position * dot.vy * 0.2 % (S * 0.5), dot.r * 1.3, dot.r, dot.blink * 3, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = WHITE; g.strokeStyle = WHITE;
  for (const c of L.crosses) cross(g, c.x, c.y, c.s);
  g.restore();
}

/** Line opening: white panels for two frames (with sky title bars) and a white veil. */
function opening(g: CanvasRenderingContext2D, L: HeroLayout, t: number, env: PvEnv, sky: string, deep: string) {
  const f = frameOf(t);
  if (f > 2 || !env.motion) return;
  const amp = Math.min(1.5, env.amp);
  g.save();
  g.fillStyle = `rgba(255,255,255,${[0.5, 0.28, 0.12][f] * amp})`; g.fillRect(-env.width, -env.height, env.width * 3, env.height * 3);
  if (f < 2) L.panels.forEach((P, i) => {
    if (f === 1 && i === 2) return;
    const scale = f === 0 ? 1.06 : 0.72, w = P.w * scale, h = P.h * scale, x = P.x + (f ? (i - 1) * L.S * 0.2 * amp : 0);
    g.fillStyle = rgba(deep, 0.2); g.fillRect(x + L.S * 0.06, P.y + L.S * 0.06, w, h);
    g.fillStyle = WHITE; g.fillRect(x, P.y, w, h);
    g.fillStyle = sky; g.fillRect(x + w * 0.06, P.y + L.S * 0.08, w * 0.36, Math.max(2, L.S * 0.05));
    g.strokeStyle = RULE; g.lineWidth = 1; g.strokeRect(x + 0.5, P.y + 0.5, w - 1, h - 1);
  });
  g.restore();
}

/** Halftone dots (or vertical stripes) sweep across the block, then shrink away. */
function wipe(g: CanvasRenderingContext2D, L: HeroLayout, exit: number, kind: string, env: PvEnv) {
  const S = L.S, { x0, x1, y0, y1 } = L.box, W = x1 - x0 + S * 1.2, left = x0 - S * 0.6;
  const cell = S * 0.42;
  g.save(); g.fillStyle = 'rgba(255,255,255,0.96)';
  if (kind === 'stripes') {
    const bars = Math.ceil(W / (cell * 0.8));
    for (let b = 0; b < bars; b++) {
      const at = b / bars, grow = clamp01(exit * 2.4 - at * 0.9), shrink = clamp01(exit * 2.4 - 1.2 - at * 0.6);
      const h = (y1 - y0 + S) * Math.max(0, grow - shrink);
      if (h <= 0.5) continue;
      g.fillRect(left + b * cell * 0.8, (y0 + y1) / 2 - h / 2 + (b % 3 - 1) * S * 0.15, cell * 0.42, h);
    }
  } else {
    const cols = Math.ceil(W / cell), rows = Math.ceil((y1 - y0 + S) / cell);
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
      const at = c / cols, grow = clamp01(exit * 2.6 - at * 1.1), shrink = clamp01(exit * 2.6 - 1.25 - at * 0.5);
      const radius = cell * 0.62 * Math.max(0, grow - shrink);
      if (radius <= 0.4) continue;
      g.beginPath(); g.arc(left + (c + (r % 2) * 0.5) * cell, y0 - S * 0.5 + r * cell, radius, 0, Math.PI * 2); g.fill();
    }
  }
  g.restore();
  void env;
}

function drawHero(g: CanvasRenderingContext2D, L: HeroLayout, frame: PvFrame, env: PvEnv) {
  const { t, exit } = frame, S = L.S, n = L.glyphs.length, motion = env.motion, amp = env.amp;
  const palette = usePalette(env);
  const fieldAlpha = clamp01(t / 250) * (1 - exit);
  field(g, L, frame, env, fieldAlpha, palette.deep);
  if (L.icon) haloTile(g, L.icon.x, L.icon.y, L.icon.s * (1 + 0.1 * frame.beat.pulse), fieldAlpha);
  const exitKind = String(env.options.exitFx ?? 'dots');
  // Glyphs vanish under the wipe's first half; the shatter variant breaks them instead.
  const hidden = exitKind !== 'shatter' && exit > 0.42;
  const kick = 1 + 0.05 * frame.beat.pulse;
  const step = Math.min(3 * FRAME, 1300 / Math.max(1, n));
  L.glyphs.forEach((glyph, i) => {
    const at = frame.wordAt(glyph.index);
    const start = at !== undefined ? Math.max(0, at) : 3 * FRAME + i * step;
    // Guide frame opens a few frames ahead, stays bright until the glyph lands, then drops to a faint guide.
    if (glyph.guide && !hidden) {
      const open = Math.max(0, start - GUIDE_MS);
      if (t >= open) {
        const after = frameOf(t - start), linger = t < start ? 1 : after < 2 ? 0.8 : 0.3;
        guideFrame(g, glyph, S, motion ? frameOf(t - open) : 9, linger * (1 - exit), Math.min(1, linger * 2.4) * (1 - exit), palette.sky, palette.deep);
      }
    }
    // Placeholder tile: hops in `lead` frames early, sits on the slot, pops as the glyph lands.
    if (glyph.tile && motion && exit === 0) {
      const f = frameOf(t - (start - glyph.tile.lead * FRAME));
      if (f >= 0 && f <= glyph.tile.lead) {
        const hop = f === 0 ? 1 : 0, s = glyph.tile.s * (f === glyph.tile.lead ? 1.15 : 1);
        placeholder(g, glyph.x + glyph.tile.hx * hop * amp, glyph.y + glyph.tile.hy * hop * amp, s, palette.deep);
      }
    }
    if (t < start || hidden) return;
    const f = motion ? frameOf(t - start) : 99;
    if (exitKind === 'shatter' && exit > 0) {
      const gone = clamp01(exit * 1.7 - (i / Math.max(1, n)) * 0.7);
      if (gone >= 1) return;
      g.save(); g.imageSmoothingEnabled = false;
      const third = glyph.mosaic.h / 3;
      for (let b = 0; b < 3; b++) blitBand(g, glyph.mosaic, b * third, third + 0.5, glyph.x + (b - 1) * gone * S * 0.4 * amp, glyph.y - gone * S * 0.1, 1 - gone);
      g.restore();
      return;
    }
    if (f < 1) {
      // One frame of pixel blocks thrown sideways.
      const random = rng(L.seed ^ (glyph.index + 1) * 40503);
      g.save(); g.imageSmoothingEnabled = false;
      const third = glyph.mosaic.h / 3;
      for (let b = 0; b < 3; b++) blitBand(g, glyph.mosaic, b * third, third + 0.5, glyph.x + (random() - 0.5) * S * 0.6 * amp, glyph.y);
      g.restore();
      return;
    }
    // Echo first (under the glyph): bright on landing, then a faint dithered trail.
    if (glyph.echo) {
      const echoAlpha = f < 3 ? 0.85 : 0.32 + 0.2 * frame.beat.pulse;
      const drift = f < 3 ? (3 - f) * S * 0.04 * amp : 0;
      blit(g, glyph.echo, glyph.x + S * 0.09 + drift, glyph.y + S * 0.13, 1, 0, echoAlpha);
    }
    const punch = f === 1 ? 1 + 0.13 * amp : 1;
    // Rare one-frame slice jolt while holding.
    const slot = Math.floor(t / (FRAME * 4));
    const jolt = motion && f > 6 && rng(L.seed ^ glyph.index * 977 ^ slot * 131)() < 0.02 * amp ? (glyph.jolt - 0.5) * S * 0.2 * amp : 0;
    if (!jolt) blit(g, glyph.sprite, glyph.x, glyph.y, punch * kick);
    else {
      const h = glyph.sprite.h, cut = h * (0.4 + glyph.jolt * 0.2), cutH = h * 0.1;
      blitBand(g, glyph.sprite, 0, cut, glyph.x, glyph.y);
      blitBand(g, glyph.sprite, cut, cutH, glyph.x + jolt, glyph.y);
      blitBand(g, glyph.sprite, cut + cutH, h - cut - cutH, glyph.x, glyph.y);
    }
    if (glyph.ornament && f >= 2) {
      const o = glyph.ornament, pop = f === 2 ? 1.3 : 1;
      ornament(g, o.kind, glyph.x + o.dx, glyph.y + o.dy, o.s * pop, palette.deep);
    }
  });
  if (motion && env.options.flash !== false) {
    opening(g, L, t, env, palette.sky, palette.deep);
    // Strong live beats flash the stage white for a moment.
    if (frame.beat.pulse > 0.5 && exit === 0) {
      g.fillStyle = `rgba(255,255,255,${(0.22 * (frame.beat.pulse - 0.5) * Math.min(1.5, amp)).toFixed(3)})`;
      g.fillRect(-env.width, -env.height, env.width * 3, env.height * 3);
    }
  }
  if (exit > 0 && exitKind !== 'shatter') wipe(g, L, exit, exitKind, env);
  if (L.translation) {
    const e = easeOutCubic((t - 260) / 300);
    blit(g, L.translation.sprite, L.translation.x, L.translation.y + (1 - e) * 6, 1, 0, e * (1 - exit));
  }
}

// ---------- Strip (verse) ----------

function stripLayout(g: CanvasRenderingContext2D, line: PvLine, env: PvEnv): StripLayout {
  const { width: W, height: H, dpr } = env;
  const random = rng(line.seed);
  const glyphs = line.glyphs.map(glyph => glyph === '\n' ? ' ' : glyph);
  const face = line.face('gothic', 700);
  const translation = env.showTranslation ? line.translation : '';
  let T = env.size * 0.5;
  g.font = faceFont(face, T);
  const advance = (i: number) => isSpace(glyphs[i]) ? T * 0.4 : g.measureText(glyphs[i]).width;
  const count = glyphs.filter(glyph => glyph.trim()).length;
  const chunks = Math.min(3, Math.max(1, Math.round(count / 7)));
  const parts = splitAt(glyphs.map((_, i) => i), breakRows(glyphs, chunks, advance, line.starts));
  const widths = parts.map(part => part.reduce((sum, i) => sum + advance(i), 0));
  const gap = T * 2.2, total = widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1);
  const fit = Math.min(1, W * 0.9 / total);
  T *= fit;
  const h = T * (translation ? 3.1 : 1.9);
  const top = H * 0.62 - h / 2;
  const k = dpr * 1.05;
  const out: StripLayout['glyphs'] = [];
  // Phrases spread along the strip like the PV's running subtitles.
  const used = total * fit, spread = Math.max(0, W * 0.9 - used) / Math.max(1, parts.length - 1) * 0.6;
  let x = (W - used - spread * (parts.length - 1)) / 2;
  const cache = new Map<string, Sprite>();
  parts.forEach((part, c) => {
    for (const i of part) {
      const w = advance(i) * fit;
      if (!isSpace(glyphs[i])) {
        let s = cache.get(glyphs[i]);
        if (!s) {
          s = sprite(T * 1.3, T * 1.4, k, gg => { gg.font = faceFont(face, T); gg.textAlign = 'center'; gg.textBaseline = 'middle'; gg.fillStyle = INK; gg.fillText(glyphs[i], T * 0.65, T * 0.7); });
          cache.set(glyphs[i], s);
        }
        out.push({ sprite: s, x: x + w / 2, y: top + T * 0.95, index: i, chunk: c, w });
      }
      x += w;
    }
    x += gap * fit + spread;
  });
  const bars = Array.from({ length: Math.round(W / (T * 1.6)) }, () => ({ x: random() * W, w: T * (0.25 + random() * 1.1), h: (0.25 + random() * 0.7) * top, delay: Math.floor(random() * 7), tone: random() }));
  const checks = Array.from({ length: Math.ceil(W / (T * 0.7)) }, () => random());
  const result: StripLayout = { kind: 'strip', seed: line.seed, T, top, h, glyphs: out, chunks: parts.length, bars, checks };
  if (translation) {
    const tface = line.tface('gothic', 500), ts = T * 0.62;
    g.font = faceFont(tface, ts);
    let text = translation;
    while (text.length > 1 && g.measureText(text).width > W * 0.9) text = text.slice(0, -2) + '…';
    const w = g.measureText(text).width + ts;
    result.translation = { sprite: sprite(w, ts * 1.6, dpr, gg => { gg.font = faceFont(tface, ts); gg.textBaseline = 'middle'; gg.fillStyle = MUTED; gg.fillText(text, ts / 2, ts * 0.8); }), x: W / 2, y: top + T * 2.25 };
  }
  return result;
}

function drawStrip(g: CanvasRenderingContext2D, L: StripLayout, frame: PvFrame, env: PvEnv) {
  const { t, exit } = frame, T = L.T, W = env.width, motion = env.motion, amp = env.amp;
  const palette = usePalette(env);
  const f = motion ? frameOf(t) : 99;
  // Bars rise behind the strip in steps and flicker on whole frames.
  for (const bar of L.bars) {
    const bf = f - bar.delay;
    if (bf < 0) continue;
    const grow = Math.min(1, (bf + 1) / 3) * (1 - exit);
    if (motion && rng(L.seed ^ Math.floor(f / 4) * 3301 ^ Math.round(bar.x))() < 0.1 * amp) continue;
    const h = bar.h * grow;
    g.fillStyle = bar.tone < 0.3 ? rgba(palette.sky, 0.55) : `rgba(255,255,255,${0.6 + bar.tone * 0.3})`;
    g.fillRect(bar.x, L.top - h, bar.w, h);
  }
  // White strip: wipes open from the left in three frames, collapses on exit.
  const open = f >= 2 ? 1 : [0.35, 0.75][f] ?? 1;
  const h = L.h * (1 - easeOutCubic(exit));
  if (h < 1) return;
  const cy = L.top + L.h / 2;
  g.fillStyle = rgba(palette.deep, 0.18); g.fillRect(0, cy - h / 2 + 3, W * open, h);
  g.fillStyle = 'rgba(255,255,255,0.94)'; g.fillRect(0, cy - h / 2, W * open, h);
  g.fillStyle = palette.sky; g.fillRect(0, cy - h / 2, W * open, Math.max(1, T * 0.05));
  // Checker row under the strip.
  const cell = T * 0.35;
  for (let c = 0; c < L.checks.length; c++) {
    if (L.checks[c] < 0.45 || c * cell * 2 > W * open) continue;
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(c * cell * 2, cy + h / 2 + cell * 0.4, cell, cell);
  }
  if (exit > 0.3) return;
  g.save(); g.beginPath(); g.rect(0, cy - h / 2, W * open, h); g.clip();
  const per = 2 * FRAME;
  let last: StripLayout['glyphs'][number] | undefined, waiting = false;
  L.glyphs.forEach((glyph, i) => {
    const at = frame.wordAt(glyph.index);
    const shown = at !== undefined ? Math.max(0, at) : 3 * FRAME + glyph.chunk * 8 * FRAME + i * per * 0.5;
    if (t < shown) { waiting = true; return; }
    blit(g, glyph.sprite, glyph.x, glyph.y);
    last = glyph;
  });
  const anchor = last ?? L.glyphs[0];
  if (waiting && motion && anchor && Math.floor(t / 260) % 2 === 0) {
    const x = last ? last.x + last.w / 2 + T * 0.08 : anchor.x - anchor.w / 2;
    g.fillStyle = INK; g.fillRect(x, anchor.y - T * 0.42, T * 0.5, T * 0.84);
  }
  if (L.translation) blit(g, L.translation.sprite, L.translation.x, L.translation.y, 1, 0, clamp01((t - 200) / 200));
  g.restore();
}

// ---------- Style ----------

const verseKind = (line: PvLine, env: PvEnv) => {
  const mode = String(env.options.verse ?? 'mix');
  if (mode === 'window' || mode === 'strip') return mode;
  return Math.floor(Math.max(0, line.index) / 4) % 2 ? 'strip' : 'window';
};

function backdrop(g: CanvasRenderingContext2D, frame: { scene: PvScene; beat: PvFrame['beat']; current?: PvLine; motion: boolean }, env: PvEnv) {
  usePalette(env);
  haloBackdrop(g, frame, env);
}

export const halo3Style: PvStyle<Layout> = {
  id: 'halo3', exitMs: 360,
  fonts: [],
  height: (size, translation) => size * 3.3 + (translation ? size * 0.5 : 0),
  layout: (g, line, env) => {
    usePalette(env);
    if (line.hero) return heroLayout(g, line, env);
    return verseKind(line, env) === 'strip' ? stripLayout(g, line, env) : cardLayout(g, line, env);
  },
  draw: (g, layout, frame, env) => {
    usePalette(env);
    if (layout.kind === 'hero') drawHero(g, layout, frame, env);
    else if (layout.kind === 'strip') drawStrip(g, layout, frame, env);
    else drawCard(g, layout, frame, env, SNAP);
  },
  backdrop,
};
