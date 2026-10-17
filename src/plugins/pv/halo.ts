import { breakRows, clamp01, easeInCubic, easeOutBack, easeOutCubic, isHan, isKana, isSpace, rng, splitAt } from './core';
import { faceFor, type Face } from '../typeface';
import { requestFonts } from './fonts';
import { blit, blitBand, roundRect, sprite, type Sprite } from './paint';
import { faceFont, hue, type PvEnv, type PvFrame, type PvLine, type PvScene, type PvStyle } from './stage';

// Halo: a bright sky-and-white interface PV. Verses type into small white
// "Lyrics" windows (title bar, double rule, black heavy gothic) that open with a
// sky-blue flash and alternate left / right. Chorus lines are huge white gothic
// glyphs with a blue rim that decode out of pixel mosaics as they are sung, keep
// a few sliced scars, and shatter back into blocks when the line leaves. Lime
// halo tiles, white dash streaks and a quoted-title HUD complete the frame.
// Readability first: cards are opaque, white glyphs carry a dark-blue rim.
//
// The "type" variant (晴空终端 II) follows the PV frame by frame: everything cuts
// on 30 fps steps instead of easing. Freshly typed verse chunks flicker through
// saturated colours (the chunk's first glyph sits in a dark selection block)
// before settling to black. A chorus line slams in behind a burst of white
// panels; each glyph slot draws a thin outline frame, some get a plain white
// window that hops into place and shrinks away, and glyphs hard-cut in.
export const INK = '#0d0e12', WHITE = '#ffffff', RULE = '#cfd8e1', MUTED = '#5d6672';
// Palette options (天蓝 / 深蓝 / 光环图标). Set at the top of every layout, draw and
// backdrop call; option changes rebuild layouts, so cached sprites match.
let SKY = '#38b4ee', DEEP = '#1767d6', LIME = '#d6f53a';
export function usePalette(env: PvEnv) {
  SKY = hue(env, 'sky', '#38b4ee'); DEEP = hue(env, 'deep', '#1767d6'); LIME = hue(env, 'lime', '#d6f53a');
  return { sky: SKY, deep: DEEP, lime: LIME };
}
export const RIM = 'rgba(8,38,92,0.68)';

interface Glyph { sprite: Sprite; x: number; y: number; index: number; w: number }
/** Card glyphs also carry their word number, so II can type line-timed lyrics word by word. */
interface CardGlyph extends Glyph { unit: number }
interface HeroGlyph extends Glyph { mosaic: Sprite; scar: number; debris: { dx: number; dy: number; s: number; c: string }[]; slot: { dx: number; dy: number; bar: number } }
/** II: a white block over an arbitrary part of 1–3 glyphs, timed to the glyph `anchor`. */
interface Patch { x: number; y: number; w: number; h: number; anchor: number; lead: number; hold: number; hx: number; hy: number }
export interface CardLayout {
  kind: 'card'; seed: number; T: number;
  cx: number; cy: number; w: number; h: number;
  frame: Sprite; flash: Sprite; glyphs: CardGlyph[]; units: number; timed: boolean; lineH: number; textX: number;
  icon?: { x: number; y: number; s: number };
}
interface HeroLayout {
  kind: 'hero'; seed: number; S: number; glyphs: HeroGlyph[];
  streaks: { x: number; y: number; w: number; h: number; v: number }[];
  icon?: { x: number; y: number; s: number };
  translation?: { sprite: Sprite; x: number; y: number };
  patches: Patch[];
}
type Layout = CardLayout | HeroLayout;

const glitchOf = (env: PvEnv) => Number(env.options.glitch ?? 0.7);
const accents = (env: PvEnv) => env.options.accent !== false;
const probe = () => document.createElement('canvas').getContext('2d');
/** `snap`: the PV's hard 30 fps cuts and the extra details of 晴空终端 II. */
export interface Variant { snap: boolean }
export const FRAME = 1000 / 30;
export const frameOf = (ms: number) => Math.floor(ms / FRAME);
const chromaOn = (variant: Variant, env: PvEnv) => variant.snap && env.motion && env.options.chroma !== false;
const slotsOn = (variant: Variant, env: PvEnv) => variant.snap && env.motion && env.options.slots !== false;
const burstOn = (variant: Variant, env: PvEnv) => variant.snap && env.motion && env.options.burst !== false;

/** Lime tile with a white halo arc: the style's recurring accent. */
export function haloTile(g: CanvasRenderingContext2D, x: number, y: number, s: number, alpha = 1) {
  if (alpha <= 0.001 || s <= 0) return;
  g.save(); g.globalAlpha *= alpha;
  g.fillStyle = 'rgba(8,38,92,0.25)'; g.fillRect(x - s / 2 + s * 0.06, y - s / 2 + s * 0.08, s, s);
  g.fillStyle = LIME; g.fillRect(x - s / 2, y - s / 2, s, s);
  g.strokeStyle = WHITE; g.lineCap = 'round'; g.lineWidth = s * 0.14;
  g.beginPath(); g.ellipse(x, y + s * 0.08, s * 0.28, s * 0.2, 0, Math.PI * 1.08, Math.PI * 1.92); g.stroke();
  g.strokeStyle = 'rgba(80,96,20,0.55)'; g.lineWidth = s * 0.05;
  g.beginPath(); g.ellipse(x, y + s * 0.16, s * 0.2, s * 0.08, 0, Math.PI * 0.1, Math.PI * 0.9); g.stroke();
  g.restore();
}
export const plus = (g: CanvasRenderingContext2D, x: number, y: number, r: number) => {
  g.fillRect(x - r, y - r * 0.16, r * 2, r * 0.32); g.fillRect(x - r * 0.16, y - r, r * 0.32, r * 2);
};

// ---------- Card (verse) ----------

// One short flash per freshly typed chunk: a single saturated colour (the next in
// the PV's order for each new chunk) for three frames, then ink. Never cycles.
export const CHROMA = ['#7a2cff', '#ff2142', '#25a8f0', '#2a3cf5', '#f01fd0'];
const FLASH_MS = 3 * FRAME, SELECT_MS = 2 * FRAME;
let scratch: HTMLCanvasElement | undefined;
/** Draws a sprite's alpha mask filled with one colour (via a shared scratch canvas). */
export function tinted(g: CanvasRenderingContext2D, s: Sprite, x: number, y: number, color: string) {
  const cw = s.canvas.width, ch = s.canvas.height;
  const canvas = scratch ??= document.createElement('canvas');
  if (canvas.width < cw || canvas.height < ch) { canvas.width = Math.max(canvas.width, cw); canvas.height = Math.max(canvas.height, ch); }
  const t = canvas.getContext('2d');
  if (!t) { blit(g, s, x, y); return; }
  t.globalCompositeOperation = 'source-over'; t.clearRect(0, 0, cw, ch);
  t.drawImage(s.canvas, 0, 0);
  t.globalCompositeOperation = 'source-in'; t.fillStyle = color; t.fillRect(0, 0, cw, ch);
  g.drawImage(canvas, 0, 0, cw, ch, x - s.ox, y - s.oy, s.w, s.h);
}

const inkGlyph = (text: string, size: number, k: number, face: Face) => {
  const w = size * 1.3, h = size * 1.4;
  return sprite(w, h, k, g => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = INK; g.fillText(text, w / 2, h / 2);
  });
};

export function cardLayout(g: CanvasRenderingContext2D, line: PvLine, env: PvEnv): CardLayout {
  const { width: W, height: H, dpr } = env;
  const random = rng(line.seed);
  const glyphs = line.glyphs.map(glyph => glyph === '\n' ? ' ' : glyph);
  const face = line.face('gothic', 900);
  const label = faceFor('gothic', 'latin', 'Lyrics No.0123456789+', 700);
  requestFonts([faceFont(label, 32)], 'Lyrics No.0123456789+');
  const translation = env.showTranslation ? line.translation : '';
  const tface = translation ? line.tface('gothic', 500) : undefined;

  // Metrics for text size T; shrunk once if the card would not fit the stage.
  const build = (T: number) => {
    g.font = faceFont(face, T);
    const advance = (i: number) => isSpace(glyphs[i]) ? T * 0.3 : g.measureText(glyphs[i]).width;
    const pad = T * 0.36, titleH = T * 0.52, ruleH = T * 0.66, lineH = T * 1.18;
    const maxText = Math.max(T * 4, W * 0.88 - pad * 2);
    const total = glyphs.reduce((sum, _, i) => sum + advance(i), 0);
    const rows = total > maxText ? (total > maxText * 2 ? 3 : 2) : 1;
    const parts = splitAt(glyphs.map((_, i) => i), breakRows(glyphs, rows, advance, line.starts));
    const widest = Math.max(...parts.map(part => part.reduce((sum, i) => sum + advance(i), 0)));
    const fit = Math.min(1, maxText / widest);
    const transT = T * 0.42, transH = translation ? transT * 1.6 : 0;
    const w = Math.max(widest * fit + pad * 2, T * 6.2);
    const h = titleH + ruleH + rows * lineH * fit + transH + pad * 0.9;
    return { T, advance, pad, titleH, ruleH, lineH: lineH * fit, fit, parts, w, h, transT, transH };
  };
  let m = build(env.size * 0.9);
  const room = H * 0.96;
  if (m.h > room) m = build(m.T * room / m.h);
  const { T, pad, titleH, ruleH, lineH, fit, parts, w, h, transT } = m;

  // Alternate sides like stacked windows; centred when the stage is narrow.
  const side = line.index >= 0 && line.index % 2 ? 1 : -1;
  const spread = Math.max(0, Math.min(W * 0.12, (W - w) / 2 - T * 0.4));
  const cx = W / 2 + side * spread;
  const cy = H / 2 - side * Math.max(0, Math.min(T * 0.2, (H - h) / 2 - T * 0.1));
  const shadow = T * 0.2, k = dpr * 1.05;

  const frame = sprite(w + shadow, h + shadow, k, gg => {
    // Offset sky block behind the window, then the window itself.
    gg.fillStyle = SKY; gg.fillRect(shadow, shadow, w, h);
    gg.fillStyle = WHITE; gg.fillRect(0, 0, w, h);
    gg.strokeStyle = RULE; gg.lineWidth = 1; gg.strokeRect(0.5, 0.5, w - 1, h - 1);
    // Title bar.
    gg.fillStyle = '#9aa5b1';
    for (let i = 0; i < 3; i++) { gg.beginPath(); gg.arc(pad * 0.7 + i * T * 0.16, titleH / 2, T * 0.04, 0, Math.PI * 2); gg.fill(); }
    gg.font = faceFont(label, T * 0.24); gg.textAlign = 'center'; gg.textBaseline = 'middle';
    gg.fillStyle = INK; gg.fillText('Lyrics', w / 2, titleH / 2);
    plus(gg, w - pad * 0.8, titleH / 2, T * 0.07);
    gg.fillStyle = RULE; gg.fillRect(0, titleH, w, 1);
    // Double rule with a small index label.
    const ry = titleH + T * 0.14;
    gg.fillStyle = INK; gg.fillRect(pad * 0.5, ry, w - pad, T * 0.1);
    gg.fillRect(pad * 0.5, ry + T * 0.17, w - pad, Math.max(1, T * 0.025));
    gg.font = faceFont(label, T * 0.15); gg.textAlign = 'left';
    gg.fillText(line.index >= 0 ? `No.${String(line.index + 1).padStart(3, '0')}` : 'No.---', pad * 0.5, ry + T * 0.33);
    plus(gg, w - pad * 0.7, ry + T * 0.33, T * 0.06);
    if (translation && tface) {
      gg.font = faceFont(tface, transT); gg.fillStyle = MUTED; gg.textAlign = 'left';
      const ty = titleH + ruleH + parts.length * lineH + transT * 0.8;
      let text = translation;
      while (text.length > 1 && gg.measureText(text).width > w - pad * 2) text = text.slice(0, -2) + '…';
      gg.fillText(text, pad, ty);
    }
    // Footer tick.
    gg.fillStyle = RULE; gg.fillRect(pad * 0.5, h - pad * 0.35, T * 0.5, 1);
  }, (w + shadow) / 2 - shadow / 2, (h + shadow) / 2 - shadow / 2);
  const flash = sprite(w, h, Math.max(0.25, dpr * 0.25), gg => {
    const gradient = gg.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, '#d9f1ff'); gradient.addColorStop(1, DEEP);
    gg.fillStyle = gradient; gg.fillRect(0, 0, w, h);
  });

  const glyphsOut: CardGlyph[] = [];
  // Word units from the segmenter: 今日 / も / また…, or whole Latin words.
  const unitOf: number[] = [];
  glyphs.forEach((_, i) => unitOf.push((unitOf[i - 1] ?? 0) + (i > 0 && line.starts.has(i) ? 1 : 0)));
  const textX = -w / 2 + pad;
  parts.forEach((part, r) => {
    let x = textX;
    const y = -h / 2 + titleH + ruleH + lineH * (r + 0.5);
    for (const i of part) {
      const advance = m.advance(i) * fit;
      if (!isSpace(glyphs[i])) glyphsOut.push({ sprite: inkGlyph(glyphs[i], T * fit, k, face), x: x + advance / 2, y, index: i, w: advance, unit: unitOf[i] });
      x += advance;
    }
  });
  const timed = line.wordOf.some(word => word >= 0);
  const icon = accents(env) && random() < 0.6 ? { x: side < 0 ? w / 2 - T * 0.1 : -w / 2 + T * 0.1, y: -h / 2 - T * 0.05, s: T * 0.62 } : undefined;
  return { kind: 'card', seed: line.seed, T, cx, cy, w, h, frame, flash, glyphs: glyphsOut, units: (unitOf[unitOf.length - 1] ?? 0) + 1, timed, lineH, textX, icon };
}

export function drawCard(g: CanvasRenderingContext2D, L: CardLayout, frame: PvFrame, env: PvEnv, variant: Variant) {
  const { t, exit } = frame, T = L.T, snap = variant.snap && env.motion;
  // II: the window cuts open in two frames instead of easing.
  const open = snap ? (t < 0 ? 0 : t < FRAME ? 0.4 : 1) : easeOutCubic(t / 170);
  if (open <= 0) return;
  const chroma = chromaOn(variant, env), offset = L.seed % CHROMA.length;
  // II types line-timed lyrics too: one word unit every 3 frames, the whole line within ~0.9 s.
  const per = Math.min(3 * FRAME, 900 / Math.max(1, L.units - 1));
  const typing = snap && !L.timed;
  const shownAt = (glyph: CardGlyph) => {
    const at = frame.wordAt(glyph.index);
    if (at !== undefined) return Math.max(0, at);
    return typing ? 2 * FRAME + glyph.unit * per : snap ? 2 * FRAME : 120;
  };
  const shown = (glyph: CardGlyph) => t >= shownAt(glyph);
  const content = () => {
    if (t < (snap ? 2 * FRAME : 70)) { blit(g, L.flash, 0, 0); return; }
    blit(g, L.frame, 0, 0);
    let last: CardGlyph | undefined, waiting = false, chunkAt = NaN, chunkPos = 0, chunk = -1;
    for (const glyph of L.glyphs) {
      if (!shown(glyph)) { waiting = true; continue; }
      const at = shownAt(glyph), age = t - at;
      // Glyphs revealed together form a chunk and share one colour.
      if (at !== chunkAt) { chunkAt = at; chunkPos = 0; chunk++; } else chunkPos++;
      if (chroma && chunkPos === 0 && age < SELECT_MS && L.glyphs.length > 1) {
        // Dark selection block behind the chunk's first glyph.
        g.fillStyle = 'rgba(30,34,44,0.82)'; g.fillRect(glyph.x - glyph.w / 2, glyph.y - L.lineH * 0.46, glyph.w, L.lineH * 0.92);
        blit(g, glyph.sprite, glyph.x, glyph.y);
      } else if (chroma && age < FLASH_MS) {
        tinted(g, glyph.sprite, glyph.x, glyph.y, CHROMA[(offset + chunk) % CHROMA.length]);
      } else blit(g, glyph.sprite, glyph.x, glyph.y);
      last = glyph;
    }
    // Block cursor while real word timing is still typing the line.
    if ((L.timed || typing) && waiting && Math.floor(t / 260) % 2 === 0) {
      const x = last ? last.x + last.w / 2 + T * 0.06 : L.textX;
      const y = last ? last.y : L.glyphs[0]?.y ?? 0;
      g.fillStyle = INK; g.fillRect(x, y - L.lineH * 0.36, T * 0.42, L.lineH * 0.72);
    }
    if (L.icon) {
      const pop = 1 + (easeOutBack((t - 160) / 280) - 1) * Math.min(1.5, env.amp);
      haloTile(g, L.icon.x, L.icon.y, L.icon.s * pop * (1 + 0.08 * frame.beat.pulse), clamp01((t - 160) / 120));
    }
  };
  // Window opens vertically and leaves by collapsing; both pass through sliced offsets.
  const sy = open * (1 - easeInCubic(exit));
  // II: two frames of hard slicing on entry.
  const amount = snap ? (t < 3 * FRAME ? 1.3 : 0) + exit * 1.6 : (1 - open) + exit * 1.4;
  if (sy <= 0.01) return;
  g.translate(L.cx, L.cy);
  const scale = (1 + 0.012 * frame.beat.pulse);
  if (amount < 0.03 || !env.motion) {
    g.save(); g.scale(scale, sy * scale); content(); g.restore();
    return;
  }
  const bands = 5, top = -L.h / 2 - T * 0.5, span = L.h + T * 0.8;
  const random = rng(L.seed ^ Math.floor(t / (snap ? FRAME : 45)) * 2654435761);
  g.globalAlpha *= 1 - exit * 0.6;
  for (let b = 0; b < bands; b++) {
    const dx = (random() - 0.5) * amount * T * 1.6 * Math.min(1, glitchOf(env) + 0.3) * env.amp;
    g.save();
    g.beginPath(); g.rect(-L.w, top + span * b / bands, L.w * 2, span / bands + 0.5); g.clip();
    g.translate(dx, 0); g.scale(scale, sy * scale); content();
    g.restore();
  }
}

// ---------- Hero (chorus) ----------

export const skyGlyph = (text: string, size: number, k: number, face: Face) => {
  const w = size * 1.4, h = size * 1.4;
  return sprite(w, h, k, (g, k) => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    // Blue offset edge, a dark rim for pale desktops, then the white face.
    g.shadowColor = 'rgba(16,92,190,0.7)'; g.shadowBlur = size * 0.1 * k;
    g.fillStyle = SKY; g.fillText(text, w / 2 + size * 0.035, h / 2 + size * 0.045);
    g.shadowBlur = 0;
    g.strokeStyle = RIM; g.lineWidth = Math.max(1.5, size * 0.055); g.strokeText(text, w / 2, h / 2);
    g.fillStyle = WHITE; g.fillText(text, w / 2, h / 2);
  });
};
/** Pixel-block version of a glyph: downsampled, then alpha-thresholded so blocks stay crisp. */
export const mosaicOf = (source: Sprite, block: number) => sprite(source.w, source.h, 1 / Math.max(1, block), gg => {
  gg.imageSmoothingEnabled = true; gg.imageSmoothingQuality = 'high';
  gg.drawImage(source.canvas, 0, 0, source.w, source.h);
  const canvas = gg.canvas, data = gg.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] > 70) { const lift = px[i] > 160 ? 255 : 0; px[i] = lift || 56; px[i + 1] = lift || 180; px[i + 2] = lift || 238; px[i + 3] = 255; }
    else px[i + 3] = 0;
  }
  gg.putImageData(data, 0, 0);
});

export const tLineSprite = (text: string, size: number, k: number, face: Face) => {
  const context = probe();
  if (context) context.font = faceFont(face, size);
  const w = (context?.measureText(text).width ?? size * text.length) + size, h = size * 1.7;
  return sprite(w, h, k, (g, k) => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    g.shadowColor = 'rgba(8,38,92,0.8)'; g.shadowBlur = size * 0.3 * k;
    g.strokeStyle = RIM; g.lineWidth = Math.max(1.5, size * 0.14); g.strokeText(text, w / 2, h / 2);
    g.shadowBlur = 0; g.fillStyle = WHITE; g.fillText(text, w / 2, h / 2);
  });
};

/**
 * White blocks that ignore glyph boundaries: a corner of three glyphs, the left
 * half of one, a thin strip across two, a block hanging off the line's edge.
 * Each is timed to one glyph of its span, so it lands just before that glyph.
 */
function patchesOf(glyphs: HeroGlyph[], S: number, random: () => number): Patch[] {
  const n = glyphs.length, out: Patch[] = [];
  if (!n) return out;
  const count = Math.min(n + 1, Math.max(2, Math.round(n * 0.45)));
  for (let p = 0; p < count; p++) {
    // The last patch always meets the line's final glyph, like the PV's closing window.
    const a = p === count - 1 ? Math.max(0, n - 1 - Math.floor(random() * 2)) : Math.floor(random() * n);
    let b = Math.min(n - 1, a + Math.floor(random() * 3));
    while (b > a && Math.abs(glyphs[b].y - glyphs[a].y) > S * 0.3) b--; // one row only
    const left = glyphs[a].x - glyphs[a].w / 2, right = glyphs[b].x + glyphs[b].w / 2;
    const top = glyphs[a].y - S * 0.5, W = right - left, H = S;
    const r = random();
    let x: number, y: number, w: number, h: number;
    if (r < 0.3) { // corner quadrant
      w = W * (0.4 + random() * 0.3); h = H * (0.4 + random() * 0.25);
      x = random() < 0.5 ? left - W * 0.05 : right - w + W * 0.05; y = random() < 0.5 ? top - H * 0.08 : top + H - h + H * 0.08;
    } else if (r < 0.52) { // left / right half, taller than the glyphs
      w = W * (0.38 + random() * 0.22); h = H * (0.9 + random() * 0.35);
      x = random() < 0.5 ? left - W * 0.04 : right - w + W * 0.04; y = top - (h - H) / 2;
    } else if (r < 0.7) { // strip across the span
      w = W * (0.7 + random() * 0.45); h = H * (0.2 + random() * 0.18);
      x = left + (W - w) * random(); y = top + H * (0.15 + random() * 0.6);
    } else if (r < 0.86) { // hanging off the span's edge
      w = Math.max(S * 0.7, W * (0.45 + random() * 0.3)); h = H * (0.55 + random() * 0.4);
      x = random() < 0.5 ? left - w * 0.6 : right - w * 0.4; y = top + (H - h) * random();
    } else { // centred block, a bit off the grid
      w = Math.min(W * 0.9, S * (0.8 + random() * 0.3)); h = w * (0.8 + random() * 0.3);
      x = left + (W - w) / 2 + (random() - 0.5) * S * 0.3; y = top + (H - h) / 2 + (random() - 0.5) * S * 0.25;
    }
    out.push({ x, y, w, h, anchor: a + Math.floor(random() * (b - a + 1)), lead: 1 + Math.floor(random() * 2), hold: 1 + Math.floor(random() * 3),
      hx: (random() < 0.5 ? -1 : 1) * S * (0.3 + random() * 0.6), hy: (random() - 0.5) * S * 0.5 });
  }
  return out;
}

function heroLayout(g: CanvasRenderingContext2D, line: PvLine, env: PvEnv): HeroLayout {
  const { width: W, height: H, dpr } = env;
  const random = rng(line.seed);
  const glyphs = line.glyphs.map(glyph => glyph === '\n' ? ' ' : glyph);
  const face = line.face('gothic', 900);
  const transH = env.showTranslation && line.translation ? env.size * 0.55 : 0;
  const avail = H - transH;
  let S = env.size * 1.6;
  g.font = faceFont(face, S);
  const scaleOf = (glyph: string) => isKana(glyph) ? 0.82 : isHan(glyph) ? 1 : 0.9;
  const advance = (i: number) => isSpace(glyphs[i]) ? S * 0.3 : g.measureText(glyphs[i]).width * scaleOf(glyphs[i]) + S * 0.03;
  const total = glyphs.reduce((sum, _, i) => sum + advance(i), 0);
  const rows = total > W * 0.86 ? 2 : 1;
  const parts = splitAt(glyphs.map((_, i) => i), breakRows(glyphs, rows, advance, line.starts));
  const widest = Math.max(...parts.map(part => part.reduce((sum, i) => sum + advance(i), 0)));
  // The second row steps right, like the PV's staggered chorus blocks.
  const stagger = rows > 1 ? S * 0.9 : 0;
  const fit = Math.min(1, (W * 0.92) / (widest + stagger), avail / (rows * S * 1.06 + S * 0.12));
  S *= fit;
  const lineH = S * 1.04, k = dpr * 1.12, block = Math.max(2, S * 0.085);
  const blockW = (widest + stagger) * fit;
  const x0 = (W - blockW) / 2, y0 = avail / 2 - (rows - 1) * lineH / 2;
  const glitch = glitchOf(env);
  const out: HeroGlyph[] = [];
  const colours = [WHITE, SKY, LIME, WHITE];
  // Separate stream so the slot frames never change the original style's layout.
  const slotRandom = rng(line.seed ^ 0x5bd1e995);
  parts.forEach((part, r) => {
    let x = x0 + (r === 1 ? stagger * fit : 0);
    for (const i of part) {
      const w = advance(i) * fit;
      if (!isSpace(glyphs[i])) {
        const solid = skyGlyph(glyphs[i], S * scaleOf(glyphs[i]), k, face);
        const debris = Array.from({ length: 5 }, () => ({ dx: (random() - 0.5) * S * 1.5, dy: (random() - 0.5) * S * 1.2, s: S * (0.04 + random() * 0.08), c: colours[Math.floor(random() * colours.length)] }));
        // A few glyphs keep a permanent sliced scar; strength follows the glitch option.
        const scar = random() < 0.28 * glitch ? (random() < 0.5 ? -1 : 1) * (0.25 + random() * 0.5) : 0;
        const slot = { dx: (slotRandom() - 0.5) * S * 0.14, dy: (slotRandom() - 0.5) * S * 0.1, bar: slotRandom() < 0.5 ? -1 : 1 };
        out.push({ sprite: solid, mosaic: mosaicOf(solid, block), x: x + w / 2, y: y0 + r * lineH + (random() - 0.5) * S * 0.05, index: i, w, scar, debris, slot });
      }
      x += w;
    }
  });
  const streaks = Array.from({ length: 6 }, () => ({
    x: random() * W, y: random() * Math.max(S * 0.3, y0 - S * 0.45), w: S * (0.8 + random() * 2.6), h: Math.max(2, S * 0.07), v: 0.006 + random() * 0.018,
  }));
  const result: HeroLayout = { kind: 'hero', seed: line.seed, S, glyphs: out, streaks, patches: patchesOf(out, S, slotRandom) };
  if (accents(env) && out.length) {
    const last = out[out.length - 1];
    if (last.x + S * 0.9 < W) result.icon = { x: last.x + last.w / 2 + S * 0.45, y: last.y - S * 0.32, s: S * 0.42 };
  }
  if (transH) result.translation = { sprite: tLineSprite(line.translation, env.size * 0.36, dpr, line.tface('gothic', 700)), x: W / 2, y: H - transH / 2 };
  return result;
}

// Chorus slot (II): a thin outline frame cuts open, some slots get a plain white
// window that hops into place, and the glyph cuts in as the window shrinks away.
// Everything moves on whole 30 fps frames.
const SLOT_MS = 4 * FRAME, SLOT_DECODE = 0.5;
function slotFrame(g: CanvasRenderingContext2D, glyph: HeroGlyph, S: number, step: number, alpha: number) {
  if (alpha <= 0.01 || step < 0) return;
  const w = glyph.w * 0.92 + S * 0.1, h = S * 0.98;
  const x = glyph.x + glyph.slot.dx, y = glyph.y + glyph.slot.dy;
  // Frame 0: a horizontal line; then the full box.
  const gw = w * (step === 0 ? 0.7 : 1), gh = step === 0 ? 1 : h;
  const line = Math.max(1, S * 0.014);
  g.save(); g.globalAlpha *= alpha; g.lineWidth = line;
  g.strokeStyle = 'rgba(8,38,92,0.35)'; g.strokeRect(x - gw / 2 + 1, y - gh / 2 + 1, gw, gh);
  g.strokeStyle = 'rgba(255,255,255,0.95)'; g.strokeRect(x - gw / 2, y - gh / 2, gw, gh);
  if (step >= 1) {
    const bw = w * 0.42, bx = glyph.slot.bar < 0 ? x - w / 2 + S * 0.06 : x + w / 2 - S * 0.06 - bw;
    g.fillStyle = SKY; g.fillRect(bx, y - h / 2 - S * 0.07, bw, Math.max(2, S * 0.04));
    g.fillStyle = 'rgba(255,255,255,0.95)';
    plus(g, x - w / 2, y + h / 2, S * 0.05); plus(g, x + w / 2, y - h / 2, S * 0.05);
  }
  g.restore();
}
/** A white block (II). `hop` 1 → 0 slides it in from its offset; `cut` > 0 slices it apart while it shrinks. */
function drawPatch(g: CanvasRenderingContext2D, P: Patch, S: number, size: number, hop: number, cut: number) {
  if (size <= 0) return;
  const w = P.w * size, h = P.h * size;
  const x = P.x + P.w / 2 + P.hx * hop - w / 2, y = P.y + P.h / 2 + P.hy * hop - h / 2;
  const bands = cut > 0 ? 3 : 1;
  for (let b = 0; b < bands; b++) {
    g.save();
    if (bands > 1) {
      g.beginPath(); g.rect(x - S, y + h * b / bands, w + S * 2, h / bands + 0.5); g.clip();
      g.translate((b - 1 || 0.7) * cut * S * 0.35, 0);
    }
    g.fillStyle = 'rgba(8,38,92,0.24)'; g.fillRect(x + S * 0.05, y + S * 0.06, w, h);
    g.fillStyle = WHITE; g.fillRect(x, y, w, h);
    g.strokeStyle = RULE; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    g.restore();
  }
}
/** Line entrance (II): white panels slam over the block for two frames, then clear. */
function burst(g: CanvasRenderingContext2D, L: HeroLayout, t: number, env: PvEnv) {
  const f = frameOf(t);
  if (f > 1 || !L.glyphs.length) return;
  const S = L.S;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const glyph of L.glyphs) { x0 = Math.min(x0, glyph.x - glyph.w / 2); x1 = Math.max(x1, glyph.x + glyph.w / 2); y0 = Math.min(y0, glyph.y - S * 0.55); y1 = Math.max(y1, glyph.y + S * 0.55); }
  const random = rng(L.seed ^ 0x2c1b3c6d);
  const w = x1 - x0, h = y1 - y0;
  const panels = [[-0.08, -0.12, 0.62, 1.1], [0.42, -0.04, 0.7, 0.95], [0.12, 0.3, 0.5, 0.8]];
  panels.forEach(([px, py, pw, ph], i) => {
    if (f === 1 && i === 2) return;
    const jitter = f * S * 0.3 * (random() - 0.5) * env.amp;
    const scale = f === 0 ? 1.08 : 0.7;
    const rx = x0 + w * px + jitter, ry = y0 + h * py, rw = w * pw * scale, rh = h * ph * scale;
    g.fillStyle = 'rgba(8,38,92,0.2)'; g.fillRect(rx + S * 0.06, ry + S * 0.06, rw, rh);
    g.fillStyle = f === 0 && i === 2 ? '#e4f4ff' : WHITE; g.fillRect(rx, ry, rw, rh);
    g.fillStyle = SKY; g.fillRect(rx + rw * 0.06, ry + S * 0.08, rw * 0.38, Math.max(2, S * 0.05));
  });
}

function drawHero(g: CanvasRenderingContext2D, L: HeroLayout, frame: PvFrame, env: PvEnv, variant: Variant) {
  const { t, exit } = frame, S = L.S, n = L.glyphs.length, W = env.width;
  const glitch = glitchOf(env), motion = env.motion, slots = slotsOn(variant, env), snap = variant.snap && motion, amp = env.amp;
  const step = Math.min(70, 1300 / Math.max(1, n));
  // Dash streaks drifting left behind the glyphs.
  const streakAlpha = clamp01(t / 300) * (1 - exit) * (0.45 + 0.3 * frame.beat.pulse);
  if (streakAlpha > 0) for (const bar of L.streaks) {
    const span = W + bar.w;
    const x = ((bar.x - (motion ? t * bar.v : 0)) % span + span) % span - bar.w;
    g.fillStyle = `rgba(23,103,214,${0.3 * streakAlpha})`; g.fillRect(x + 2, bar.y + 2, bar.w, bar.h);
    g.fillStyle = `rgba(255,255,255,${streakAlpha})`; g.fillRect(x, bar.y, bar.w, bar.h);
  }
  const kick = 1 + 0.05 * frame.beat.pulse;
  const starts: number[] = [];
  L.glyphs.forEach((glyph, i) => {
    const at = frame.wordAt(glyph.index);
    const base = at !== undefined ? Math.max(0, at) : (snap ? 3 * FRAME : 90) + i * step;
    // Slots open up to SLOT_MS before the word; with no lead time the glyph waits for part of it.
    const slotAt = Math.max(0, base - SLOT_MS);
    const start = slots ? Math.max(base, slotAt + SLOT_MS * SLOT_DECODE) : base;
    const gone = clamp01(exit * 1.7 - (i / Math.max(1, n)) * 0.7);
    if (gone >= 1) return;
    if (slots && t >= slotAt) {
      const f = frameOf(t - slotAt), after = frameOf(t - start);
      // The frame stays bright until the glyph lands, then drops to a faint guide.
      const linger = t < start ? 1 : after < 2 ? 0.8 : 0.3;
      slotFrame(g, glyph, S, f, linger * (1 - gone) * (1 - exit));
    }
    starts[i] = start;
    const p = (t - start) / 300;
    if (p <= 0) return;
    const random = rng(L.seed ^ (glyph.index + 1) * 40503 ^ Math.floor(t / 50) * 9973);
    if (gone > 0) {
      // Shatter: back to blocks, slices flung sideways.
      g.save(); g.imageSmoothingEnabled = false;
      const third = glyph.mosaic.h / 3;
      for (let b = 0; b < 3; b++) blitBand(g, glyph.mosaic, b * third, third + 0.5, glyph.x + (b - 1) * gone * S * 0.35 * amp * (glyph.scar < 0 ? -1 : 1), glyph.y - gone * S * 0.1 * amp, 1 - gone);
      g.restore();
      for (const bit of glyph.debris) { g.fillStyle = bit.c; g.globalAlpha = (1 - gone) * 0.9; g.fillRect(glyph.x + bit.dx * (0.6 + gone) * amp, glyph.y + bit.dy * (0.6 + gone) * amp, bit.s, bit.s); }
      g.globalAlpha = 1;
      return;
    }
    if (snap) {
      // II: one frame of pixel blocks thrown sideways, then the solid glyph punches in.
      const f = frameOf(t - start);
      if (f < 1) {
        g.save(); g.imageSmoothingEnabled = false;
        const third = glyph.mosaic.h / 3;
        for (let b = 0; b < 3; b++) blitBand(g, glyph.mosaic, b * third, third + 0.5, glyph.x + (random() - 0.5) * S * 0.5 * amp, glyph.y);
        g.restore();
      } else {
        const punch = f === 1 ? 1 + 0.14 * amp : 1;
        const twitch = random() < 0.035 * glitch ? (random() - 0.5) * S * 0.22 * amp : 0;
        const scar = glyph.scar * S * 0.08 + twitch;
        if (!scar || punch !== 1) blit(g, glyph.sprite, glyph.x, glyph.y, punch * kick);
        else {
          const h = glyph.sprite.h, cut = h * (0.38 + (glyph.index % 3) * 0.08), cutH = h * 0.12;
          blitBand(g, glyph.sprite, 0, cut, glyph.x, glyph.y);
          blitBand(g, glyph.sprite, cut, cutH, glyph.x + scar, glyph.y);
          blitBand(g, glyph.sprite, cut + cutH, h - cut - cutH, glyph.x, glyph.y);
          g.fillStyle = SKY; g.fillRect(glyph.x + scar + glyph.sprite.w * 0.18, glyph.y - glyph.sprite.oy + cut, S * 0.08, cutH * 0.7);
        }
      }
    } else if (p < 0.4 && motion) {
      // Decode: crisp pixel blocks with jittering slices.
      g.save(); g.imageSmoothingEnabled = false;
      const third = glyph.mosaic.h / 3;
      for (let b = 0; b < 3; b++) blitBand(g, glyph.mosaic, b * third, third + 0.5, glyph.x + (random() - 0.5) * S * 0.3 * amp * (1 - p), glyph.y, clamp01(p / 0.12));
      g.restore();
    } else {
      const settle = motion ? clamp01((p - 0.4) / 0.6) : 1;
      const scale = (1 + 0.06 * amp * (1 - easeOutCubic(settle))) * kick;
      // Occasional twitch on a slice while holding.
      const twitch = motion && random() < 0.035 * glitch ? (random() - 0.5) * S * 0.18 * amp : 0;
      const scar = glyph.scar * S * 0.08 + twitch;
      if (!scar || scale !== kick) blit(g, glyph.sprite, glyph.x, glyph.y, scale);
      else {
        const h = glyph.sprite.h, cut = h * (0.38 + (glyph.index % 3) * 0.08), cutH = h * 0.12;
        blitBand(g, glyph.sprite, 0, cut, glyph.x, glyph.y);
        blitBand(g, glyph.sprite, cut, cutH, glyph.x + scar, glyph.y);
        blitBand(g, glyph.sprite, cut + cutH, h - cut - cutH, glyph.x, glyph.y);
        g.fillStyle = SKY; g.fillRect(glyph.x + scar + glyph.sprite.w * 0.18, glyph.y - glyph.sprite.oy + cut, S * 0.08, cutH * 0.7);
      }
    }
    if (motion && p < 1) for (const bit of glyph.debris) {
      g.fillStyle = bit.c; g.globalAlpha = (1 - p) * 0.9;
      g.fillRect(glyph.x + bit.dx * p * amp, glyph.y + bit.dy * p * amp, bit.s, bit.s);
      g.globalAlpha = 1;
    }
  });
  // White blocks sit over the glyphs: they land a frame or three before their
  // anchor glyph, hop into place, hold briefly over the fresh text, then shrink away.
  if (slots && exit <= 0) for (const P of L.patches) {
    const at = starts[P.anchor];
    if (at === undefined) continue;
    const f = frameOf(t - (at - P.lead * FRAME));
    if (f < 0) continue;
    if (f === 0) drawPatch(g, P, S, 1 + 0.2 * amp, amp, 0);
    else if (f < 1 + P.lead + P.hold) drawPatch(g, P, S, 1, 0, 0);
    else { const k = f - (1 + P.lead + P.hold); if (k < 2) drawPatch(g, P, S, [0.7, 0.4][k], 0, (k + 1) / 2); }
  }
  if (burstOn(variant, env)) burst(g, L, t, env);
  if (L.icon) {
    const pop = easeOutBack((t - 220) / 320);
    haloTile(g, L.icon.x, L.icon.y, L.icon.s * pop * (1 + 0.1 * frame.beat.pulse), clamp01((t - 220) / 120) * (1 - exit));
  }
  if (L.translation) {
    const e = easeOutCubic((t - 260) / 300);
    blit(g, L.translation.sprite, L.translation.x, L.translation.y + (1 - e) * 6, 1, 0, e * (1 - exit));
  }
}

// ---------- HUD ----------

let hudFace: { title: string; face: Face } | undefined;
const pad2 = (value: number) => String(Math.floor(value)).padStart(2, '0');
export function backdrop(g: CanvasRenderingContext2D, { scene, current }: { scene: PvScene; current?: PvLine }, env: PvEnv) {
  if (env.options.hud === false || !current) return;
  const S = env.size, W = env.width, H = env.height;
  const title = scene.title.trim();
  g.textBaseline = 'middle'; g.lineJoin = 'round';
  g.shadowColor = 'rgba(8,38,92,0.95)'; g.shadowBlur = 4; g.strokeStyle = 'rgba(8,38,92,0.6)';
  if (title) {
    if (hudFace?.title !== title) {
      hudFace = { title, face: faceFor('gothic', 'latin', title, 700) };
      requestFonts([faceFont(hudFace.face, 32)], title);
    }
    const size = S * 0.26, text = `“${/[a-z]/i.test(title) ? title.toUpperCase() : title}”`;
    g.font = faceFont(hudFace.face, size); g.textAlign = 'right';
    const x = W - S * 0.55;
    g.lineWidth = Math.max(1.5, size * 0.18); g.strokeText(text, x, size * 0.6);
    g.fillStyle = 'rgba(255,255,255,0.92)'; g.fillText(text, x, size * 0.6);
    g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1.2;
    g.beginPath(); g.arc(x + size * 0.55, size * 0.75, size * 0.32, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(x + size * 0.55, size * 0.4); g.lineTo(x + size * 0.55, size * 1.1);
    g.moveTo(x + size * 0.2, size * 0.75); g.lineTo(x + size * 0.9, size * 0.75); g.stroke();
  }
  // Timecode hh:mm:ss:ff (30 fps), a pure function of the position.
  const ms = Math.max(0, scene.position), seconds = ms / 1000;
  const code = `${pad2(seconds / 3600)}:${pad2(seconds / 60 % 60)}:${pad2(seconds % 60)}:${pad2(ms % 1000 / 1000 * 30)}`;
  const mono = faceFor('mono', 'latin', code);
  g.font = faceFont(mono, S * 0.2); g.textAlign = 'right';
  g.lineWidth = Math.max(1.5, S * 0.035); g.strokeStyle = 'rgba(8,38,92,0.6)'; g.strokeText(code, W - S * 0.2, H - S * 0.12);
  g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillText(code, W - S * 0.2, H - S * 0.12);
  g.shadowBlur = 0;
}

const haloVariant = (id: string, variant: Variant): PvStyle<Layout> => ({
  id, exitMs: 320,
  fonts: [],
  height: (size, translation) => size * 3.1 + (translation ? size * 0.5 : 0),
  layout: (g, line, env) => { usePalette(env); return line.hero ? heroLayout(g, line, env) : cardLayout(g, line, env); },
  draw: (g, layout, frame, env) => { usePalette(env); if (layout.kind === 'hero') drawHero(g, layout, frame, env, variant); else drawCard(g, layout, frame, env, variant); },
  backdrop: (g, frame, env) => { usePalette(env); backdrop(g, frame, env); },
});
export const haloStyle = haloVariant('halo', { snap: false });
export const haloTypeStyle = haloVariant('halo2', { snap: true });
