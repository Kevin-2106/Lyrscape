import type { Face } from '../typeface';
import { sprite, type Sprite } from './paint';
import { faceFont } from './stage';

// Pixel glyphs: a lyric glyph rasterised onto a coarse cell grid (the bundled
// 12 px bitmap face renders crisply at 2×, so one font pixel is 2 × 2 cells),
// optionally emboldened, then painted back at stage size as square blocks or as
// blocks with softly rounded outer corners.

/** Cells per em; the grid is GRID + 8 cells wide so descenders and bold growth fit. */
export const GRID = 24;
const BOX = GRID + 8;
export interface PixelMask {
  cells: Uint8Array; n: number; /** Occupied cell bounds. */ x0: number; x1: number; y0: number; y1: number;
  /** Share of the occupied box that is filled: dense glyphs (鐘, 鳴) clog up if emboldened further. */
  density: number;
}

let raster: CanvasRenderingContext2D | null | undefined;
/** Rasterises one glyph to BOX × BOX cells; `bold` grows strokes by one cell right and down. */
export function pixelMask(text: string, face: Face, bold = 1): PixelMask {
  raster ??= Object.assign(document.createElement('canvas'), { width: BOX, height: BOX }).getContext('2d', { willReadFrequently: true });
  const cells = new Uint8Array(BOX * BOX);
  const mask: PixelMask = { cells, n: BOX, x0: BOX, x1: -1, y0: BOX, y1: -1, density: 0 };
  if (!raster) return mask;
  raster.clearRect(0, 0, BOX, BOX);
  raster.font = faceFont(face, GRID); raster.textAlign = 'center'; raster.textBaseline = 'middle'; raster.fillStyle = '#000';
  raster.fillText(text, BOX / 2, BOX / 2 + 1);
  const data = raster.getImageData(0, 0, BOX, BOX).data;
  for (let i = 0; i < cells.length; i++) cells[i] = data[i * 4 + 3] > 110 ? 1 : 0;
  for (let pass = 0; pass < bold; pass++) {
    const source = cells.slice();
    for (let y = 0; y < BOX; y++) for (let x = 0; x < BOX; x++) {
      if (source[y * BOX + x]) continue;
      if (x > 0 && source[y * BOX + x - 1] || y > 0 && source[(y - 1) * BOX + x]) cells[y * BOX + x] = 1;
    }
  }
  let filled = 0;
  for (let y = 0; y < BOX; y++) for (let x = 0; x < BOX; x++) if (cells[y * BOX + x]) {
    filled++;
    mask.x0 = Math.min(mask.x0, x); mask.x1 = Math.max(mask.x1, x); mask.y0 = Math.min(mask.y0, y); mask.y1 = Math.max(mask.y1, y);
  }
  mask.density = filled ? filled / ((mask.x1 - mask.x0 + 1) * (mask.y1 - mask.y0 + 1)) : 0;
  return mask;
}

const scratch = (w: number, h: number) => {
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  return { canvas, g: canvas.getContext('2d', { willReadFrequently: true }) };
};
const release = (canvas: HTMLCanvasElement) => { canvas.width = 0; canvas.height = 0; };

/** Draws every set cell (or those `keep` accepts) as a square of `cell` px. */
function fillCells(g: CanvasRenderingContext2D, mask: PixelMask, cell: number, keep?: (x: number, y: number) => boolean) {
  const { cells, n } = mask;
  for (let y = 0; y < n; y++) {
    // Merge horizontal runs so seams never show between neighbouring blocks.
    let run = -1;
    for (let x = 0; x <= n; x++) {
      const on = x < n && cells[y * n + x] === 1 && (!keep || keep(x, y));
      if (on && run < 0) run = x;
      else if (!on && run >= 0) { g.fillRect(run * cell, y * cell, (x - run) * cell, cell + 0.02); run = -1; }
    }
  }
}

export interface PixelStyle {
  fill: string;
  /** Rounds outer corners by this fraction of a cell (0 = square blocks). */
  round?: number;
  /** Soft drop shadow: colour, offset and blur in cells. */
  shadow?: { color: string; dx: number; dy: number; blur: number; alpha: number };
  /** Thin rim (in cells) for light desktops. */
  rim?: { color: string; width: number };
  /** Hard offset copies behind the glyph (retro two-colour drop shadows). */
  drops?: { color: string; dx: number; dy: number }[];
  /** Only these cells (e.g. an ordered-dither step of a dissolve). */
  keep?: (x: number, y: number) => boolean;
}

/**
 * Glyph sprite at `size` px per em. Square blocks stay crisp; `round` blurs the
 * block mask and re-thresholds it, which rounds outer corners and softly fills
 * inner ones like the PV's chunky pixel lettering.
 */
export function pixelSprite(mask: PixelMask, size: number, k: number, style: PixelStyle): Sprite {
  const cell = size / GRID, w = mask.n * cell;
  return sprite(w, w, k, g => {
    const pw = g.canvas.width, ph = g.canvas.height;
    const shape = scratch(pw, ph);
    if (!shape.g) return;
    shape.g.scale(k, k); shape.g.fillStyle = '#ffffff';
    fillCells(shape.g, mask, cell, style.keep);
    let source = shape.canvas;
    if (style.round) {
      const rounded = scratch(pw, ph);
      if (rounded.g) {
        rounded.g.filter = `blur(${(cell * style.round * k).toFixed(2)}px)`;
        rounded.g.drawImage(shape.canvas, 0, 0);
        const image = rounded.g.getImageData(0, 0, pw, ph), px = image.data;
        for (let i = 3; i < px.length; i += 4) { px[i - 3] = px[i - 2] = px[i - 1] = 255; px[i] = Math.max(0, Math.min(255, (px[i] - 112) * 4)); }
        rounded.g.putImageData(image, 0, 0);
        release(shape.canvas); source = rounded.canvas;
      }
    }
    const tint = (color: string) => {
      const layer = scratch(pw, ph);
      if (!layer.g) return layer.canvas;
      layer.g.drawImage(source, 0, 0);
      layer.g.globalCompositeOperation = 'source-in'; layer.g.fillStyle = color; layer.g.fillRect(0, 0, pw, ph);
      return layer.canvas;
    };
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    if (style.shadow) {
      const layer = tint(style.shadow.color);
      g.save(); g.globalAlpha = style.shadow.alpha; g.filter = `blur(${(style.shadow.blur * cell * k).toFixed(2)}px)`;
      g.drawImage(layer, style.shadow.dx * cell * k, style.shadow.dy * cell * k); g.restore();
      release(layer);
    }
    for (const drop of style.drops ?? []) {
      const layer = tint(drop.color);
      g.drawImage(layer, Math.round(drop.dx * cell * k), Math.round(drop.dy * cell * k));
      release(layer);
    }
    if (style.rim) {
      const layer = tint(style.rim.color), r = style.rim.width * cell * k;
      for (let a = 0; a < 8; a++) g.drawImage(layer, Math.cos(a * Math.PI / 4) * r, Math.sin(a * Math.PI / 4) * r);
      release(layer);
    }
    const face = tint(style.fill);
    g.drawImage(face, 0, 0); release(face);
    g.restore();
    release(source);
  });
}

/** Loose square blocks from part of a mask (checker / seeded subset): pixel trails and echoes. */
export function cellSprite(mask: PixelMask, size: number, k: number, color: string, keep: (x: number, y: number) => boolean): Sprite {
  const cell = size / GRID, w = mask.n * cell;
  return sprite(w, w, k, g => { g.fillStyle = color; fillCells(g, mask, cell, keep); });
}
