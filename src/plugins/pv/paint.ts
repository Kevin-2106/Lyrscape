/** Offscreen sprites: styled glyphs are painted once per layout, then only transformed per frame. */
export interface Sprite { canvas: HTMLCanvasElement; w: number; h: number; ox: number; oy: number }
type Ctx = CanvasRenderingContext2D;
let allocationScope: Sprite[] | undefined;

/** Layouts own their textures. Dropping JS references alone leaves canvas/GPU
 * backing stores alive until the browser decides to run a major collection. */
export function captureSprites<T>(build: () => T): { value: T; sprites: Sprite[] } {
  const previous = allocationScope, sprites: Sprite[] = [];
  allocationScope = sprites;
  try { return { value: build(), sprites }; }
  catch (error) { releaseSprites(sprites); throw error; }
  finally { allocationScope = previous; }
}
export function releaseSprites(sprites: Iterable<Sprite>) {
  for (const { canvas } of sprites) { canvas.width = 0; canvas.height = 0; }
}

/**
 * `w`/`h` are CSS px; the backing store is scaled by `k` (device pixel ratio times
 * the largest scale the glyph is drawn at). Canvas shadowBlur ignores transforms,
 * so paint callbacks receive `k` to scale blur radii themselves.
 */
export function sprite(w: number, h: number, k: number, paint: (g: Ctx, k: number) => void, ox = w / 2, oy = h / 2): Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w * k)); canvas.height = Math.max(1, Math.ceil(h * k));
  const result = { canvas, w, h, ox, oy };
  allocationScope?.push(result);
  const g = canvas.getContext('2d');
  if (g) { g.scale(k, k); paint(g, k); }
  return result;
}
/** Draws a sprite with its origin at (x, y), scaled and rotated around that origin. */
export function blit(g: Ctx, s: Sprite, x: number, y: number, scale = 1, rotation = 0, alpha = 1) {
  if (alpha <= 0.001 || scale <= 0.001) return;
  g.save();
  g.globalAlpha *= Math.min(1, alpha);
  g.translate(x, y);
  if (rotation) g.rotate(rotation);
  if (scale !== 1) g.scale(scale, scale);
  g.drawImage(s.canvas, -s.ox, -s.oy, s.w, s.h);
  g.restore();
}
/** Draws a horizontal band [top, top+height) of a sprite (CSS px in sprite space). */
export function blitBand(g: Ctx, s: Sprite, top: number, height: number, x: number, y: number, alpha = 1) {
  if (alpha <= 0.001 || height <= 0) return;
  const k = s.canvas.width / s.w;
  const sy = Math.max(0, Math.floor(top * k)), sh = Math.min(s.canvas.height - sy, Math.ceil(height * k));
  if (sh <= 0) return;
  g.save(); g.globalAlpha *= Math.min(1, alpha);
  g.drawImage(s.canvas, 0, sy, s.canvas.width, sh, x - s.ox, y - s.oy + sy / k, s.w, sh / k);
  g.restore();
}

export const font = (weight: number | string, size: number, family: string, style = 'normal') =>
  `${style} ${weight} ${size.toFixed(2)}px ${family}`;
export function measure(g: Ctx, fontSpec: string, text: string): number {
  g.font = fontSpec; return g.measureText(text).width;
}

function parse(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = parse(a), [r2, g2, b2] = parse(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = parse(hex); return `rgba(${r},${g},${b},${alpha})`;
}

export function roundRect(g: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + radius, y);
  g.arcTo(x + w, y, x + w, y + h, radius); g.arcTo(x + w, y + h, x, y + h, radius);
  g.arcTo(x, y + h, x, y, radius); g.arcTo(x, y, x + w, y, radius);
  g.closePath();
}
/** Circle with a scalloped (cookie / badge) rim. */
export function scallopCircle(g: Ctx, cx: number, cy: number, r: number, bumps: number, depth: number) {
  g.beginPath();
  const steps = bumps * 12;
  for (let i = 0; i <= steps; i++) {
    const a = i / steps * Math.PI * 2;
    const rr = r - depth + depth * Math.abs(Math.cos(a * bumps / 2));
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.closePath();
}
/** Rounded five-point star. */
export function star(g: Ctx, cx: number, cy: number, r: number, inner = 0.5) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * inner : r;
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.closePath();
}
export function heart(g: Ctx, cx: number, cy: number, r: number) {
  g.beginPath();
  g.moveTo(cx, cy + r * 0.9);
  g.bezierCurveTo(cx - r * 1.3, cy + r * 0.1, cx - r * 0.9, cy - r * 1.1, cx, cy - r * 0.35);
  g.bezierCurveTo(cx + r * 0.9, cy - r * 1.1, cx + r * 1.3, cy + r * 0.1, cx, cy + r * 0.9);
  g.closePath();
}
