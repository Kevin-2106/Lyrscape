import { clamp01, easeInOutSine, easeOutCubic, hash, isHan, isKana, isSpace, rng } from './core';
import type { Face } from '../typeface';
import { blit, blitBand, sprite, type Sprite } from './paint';
import { faceFont, type PvEnv, type PvFrame, type PvLine, type PvStyle } from './stage';

// Underwater elegy: small gothic words scattered on hairlines with little wave
// bumps, decoded in and dissolved out by pixel glitches, a giant outlined
// mincho kanji drifting behind, and serif microtext.
const THEMES = {
  foam: { ink: '#eafff8', shade: 'rgba(6,14,36,0.75)', faint: 'rgba(234,255,248,' },
  abyss: { ink: '#17132b', shade: 'rgba(255,255,255,0.75)', faint: 'rgba(23,19,43,' },
};
const punct = /^[\p{P}\p{S}]$/u;

interface Chunk { sprite: Sprite; x: number; y: number; w: number; first: number; order: number }
interface Link { x0: number; x1: number; y: number; bump: number; at: number; kind: number; to: number }
interface Layout {
  size: number; chunks: Chunk[]; links: Link[]; color: typeof THEMES.foam; seed: number;
  kanji?: { sprite: Sprite; x: number; y: number };
  micro?: { sprite: Sprite; x: number; y: number };
  dashes: { x: number; y: number; w: number }[];
}

/** Groups word segments into 1-5 phrase chunks; particles and punctuation stay with what they follow. */
export function elegyChunks(glyphs: string[], starts: Set<number>): number[][] {
  const words: number[][] = [];
  glyphs.forEach((glyph, i) => {
    if (isSpace(glyph)) { if (words.at(-1)?.length) words.push([]); return; }
    const attach = punct.test(glyph) || (words.length && !starts.has(i) && words.at(-1)!.length);
    if (attach || !words.length) { if (!words.length) words.push([]); words.at(-1)!.push(i); }
    else words.push([i]);
  });
  let chunks = words.filter(word => word.length);
  // Short kana-only words (particles) join the preceding word: 言葉 + の.
  chunks = chunks.reduce<number[][]>((out, word) => {
    const kana = word.every(i => isKana(glyphs[i]) || punct.test(glyphs[i]));
    if (out.length && kana && word.length <= 2) out.at(-1)!.push(...word); else out.push([...word]);
    return out;
  }, []);
  const count = glyphs.filter(glyph => glyph.trim()).length;
  const target = Math.max(1, Math.min(5, Math.round(count / 3.2)));
  while (chunks.length > target) {
    let best = 0, score = Infinity;
    for (let i = 0; i < chunks.length - 1; i++) {
      const s = chunks[i].length + chunks[i + 1].length;
      if (s < score) { score = s; best = i; }
    }
    chunks.splice(best, 2, [...chunks[best], ...chunks[best + 1]]);
  }
  return chunks;
}

const textSprite = (text: string, size: number, k: number, color: typeof THEMES.foam, face: Face) => {
  const probe = sprite(1, 1, 1, () => {});
  const g0 = probe.canvas.getContext('2d');
  if (g0) g0.font = faceFont(face, size);
  const w = (g0?.measureText(text).width ?? size * text.length) + size * 0.5, h = size * 1.6;
  return sprite(w, h, k, (g, k) => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = color.shade; g.shadowBlur = Math.max(2, size * 0.14) * k;
    g.fillStyle = color.ink; g.fillText(text, w / 2, h / 2); g.fillText(text, w / 2, h / 2);
  });
};

function layout(g: CanvasRenderingContext2D, line: PvLine, env: PvEnv): Layout {
  const { width: W, height: H, dpr } = env;
  const color = env.options.theme === 'abyss' ? THEMES.abyss : THEMES.foam;
  const random = rng(line.seed);
  const glyphs = line.glyphs.map(glyph => glyph === '\n' ? ' ' : glyph);
  const chunks = elegyChunks(glyphs, line.starts);
  let size = env.size * (line.hero ? 0.78 : 0.64);
  const k = dpr * 1.05;
  const face = line.face('gothic', 500);
  g.font = faceFont(face, size);
  const texts = chunks.map(chunk => chunk.map(i => glyphs[i]).join(''));
  let widths = texts.map(text => g.measureText(text).width);
  const minGap = size * 1.1;
  const span = Math.min(W * 0.88, env.size * 24);
  const need = widths.reduce((a, b) => a + b, 0) + minGap * Math.max(0, chunks.length - 1);
  // Up to two levels: overflow drops later chunks to a lower hairline.
  const twoLevel = need > span || (chunks.length >= 3 && random() < 0.45);
  const levels = chunks.map((_, c) => (twoLevel && c >= Math.ceil(chunks.length / 2) ? 1 : 0));
  const levelWidth = (level: number) => chunks.reduce((sum, _, c) => sum + (levels[c] === level ? widths[c] + minGap : 0), -minGap);
  const widest = Math.max(levelWidth(0), levelWidth(1));
  const translation = env.showTranslation && line.translation;
  const usable = H - (translation ? env.size * 0.42 : env.size * 0.15);
  const rowsH = (twoLevel ? 2.25 : 1.2) * size;
  const fit = Math.min(1, span / Math.max(1, widest), usable * 0.86 / rowsH);
  if (fit < 1) { size *= fit; widths = widths.map(w => w * fit); }
  const y0 = (usable - (twoLevel ? size * 1.15 : 0)) / 2;
  const out: Chunk[] = [], links: Link[] = [];
  for (const level of [0, 1]) {
    const members = chunks.map((_, c) => c).filter(c => levels[c] === level);
    if (!members.length) continue;
    const total = members.reduce((sum, c) => sum + widths[c], 0);
    const free = Math.max(0, span - total);
    const weights = members.slice(1).map(() => 0.4 + random());
    const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
    // Lone chunks sit off-centre with a hairline trailing into the empty side.
    let x = members.length === 1 ? W / 2 - widths[members[0]] / 2 + (random() - 0.5) * free * 0.6 : (W - span) / 2;
    const y = y0 + level * size * 1.15 + (level ? size * 0.1 : 0);
    members.forEach((c, m) => {
      out.push({ sprite: textSprite(texts[c], size, k, color, face), x: x + widths[c] / 2, y, w: widths[c], first: chunks[c][0], order: c });
      const end = x + widths[c];
      if (m < members.length - 1) {
        const gap = Math.max(minGap * fit, free * weights[m] / weightSum);
        links.push({ x0: end + size * 0.18, x1: end + gap - size * 0.18, y: y + size * 0.28, bump: 0.3 + random() * 0.4, at: 0, kind: Math.floor(random() * 3), to: members[m + 1] });
        x = end + gap;
      } else if (members.length === 1) {
        const room = (random() < 0.5 ? -1 : 1);
        const length = Math.min(span * 0.3, (room > 0 ? (W + span) / 2 - end : x - (W - span) / 2));
        if (length > size * 2) {
          if (room > 0) links.push({ x0: end + size * 0.18, x1: end + length, y: y + size * 0.28, bump: 0.6, at: 0, kind: 2, to: -1 });
          else links.push({ x0: x - length, x1: x - size * 0.18, y: y + size * 0.28, bump: 0.35, at: 0, kind: 2, to: -1 });
        }
      }
    });
  }
  const result: Layout = { size, chunks: out.sort((a, b) => a.order - b.order), links, color, seed: line.seed, dashes: [] };
  // Giant outlined kanji: the densest one, so it reads as a shape rather than two bars (二).
  const mincho = line.face('mincho', 700);
  const kanji = densest(glyphs.filter(isHan), mincho);
  if (kanji && env.options.kanji !== false) {
    const ks = H * 0.98;
    const side = random() < 0.5;
    result.kanji = {
      sprite: sprite(ks * 1.2, ks * 1.2, dpr * 0.75, g => {
        g.font = faceFont(mincho, ks); g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = `${color.faint}0.07)`; g.fillText(kanji, ks * 0.6, ks * 0.6);
        g.strokeStyle = `${color.faint}0.32)`; g.lineWidth = Math.max(1, ks * 0.008); g.strokeText(kanji, ks * 0.6, ks * 0.6);
      }),
      x: side ? (W - span) / 2 + ks * 0.35 : (W + span) / 2 - ks * 0.35, y: H / 2,
    };
  }
  if (translation) {
    const ts = Math.max(11, env.size * 0.3);
    const s = textSprite(line.translation, ts, dpr * 1.2, color, line.tface('serif', 400, 'italic'));
    result.micro = { sprite: s, x: Math.min(Math.max(s.w / 2 + 8, W / 2 + (random() - 0.5) * span * 0.3), W - s.w / 2 - 8), y: H - env.size * 0.25 };
  } else if (env.options.micro !== false) {
    // Unreadable microtext rows, like the PV's tiny serif annotations.
    const anchor = out[Math.floor(random() * out.length)];
    if (anchor) for (let r = 0; r < 3; r++) {
      let x = anchor.x - anchor.w / 2;
      const y = anchor.y + size * 0.85 + r * Math.max(3, size * 0.16);
      for (let d = 0; d < 6 && x < anchor.x + anchor.w * 0.9; d++) {
        const w = size * (0.12 + random() * 0.4);
        result.dashes.push({ x, y, w }); x += w + size * 0.08;
      }
    }
  }
  return result;
}

function densest(candidates: string[], face: Face): string | undefined {
  let best: string | undefined, score = -1;
  for (const glyph of new Set(candidates)) {
    const probe = sprite(24, 24, 1, p => {
      p.font = faceFont(face, 22); p.textAlign = 'center'; p.textBaseline = 'middle'; p.fillStyle = '#000'; p.fillText(glyph, 12, 12);
    });
    const data = probe.canvas.getContext('2d')?.getImageData(0, 0, 24, 24).data;
    let ink = 0;
    if (data) for (let i = 3; i < data.length; i += 4) ink += data[i];
    if (ink > score) { score = ink; best = glyph; }
  }
  return best;
}

/** Deterministic pixel-glitch: mosaic blocks plus horizontally displaced bands. */
function glitch(g: CanvasRenderingContext2D, chunk: Chunk, amount: number, step: number, seed: number, layout: Layout, intensity: number, alpha: number) {
  const s = chunk.sprite;
  const random = rng(hash(`${seed}:${chunk.order}:${step}`));
  const bands = 5;
  const bandH = s.h / bands;
  for (let b = 0; b < bands; b++) {
    const shift = random() < 0.6 * amount ? (random() - 0.5) * layout.size * 1.6 * amount * intensity : 0;
    if (random() < amount * 0.45) continue;
    blitBand(g, s, b * bandH, bandH + 0.5, chunk.x + shift, chunk.y, alpha);
  }
  g.fillStyle = layout.color.ink;
  const cell = Math.max(2, layout.size * 0.2);
  const cols = Math.ceil(chunk.w / cell), rows = Math.ceil(layout.size * 1.05 / cell);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (random() > 0.32 * amount * intensity) continue;
    g.globalAlpha = alpha * (0.6 + random() * 0.4);
    g.fillRect(Math.round(chunk.x - chunk.w / 2 + c * cell), Math.round(chunk.y - layout.size * 0.52 + r * cell), Math.ceil(cell * (random() < 0.3 ? 2 : 1)), Math.ceil(cell));
  }
  g.globalAlpha = 1;
}

function draw(g: CanvasRenderingContext2D, layout: Layout, frame: PvFrame, env: PvEnv) {
  const { t, exit } = frame, S = layout.size;
  const intensity = env.motion ? Number(env.options.glitch ?? 1) : 0;
  const step = Math.floor(t / 45);
  const count = layout.chunks.length;
  const pace = Math.min(320, 1100 / Math.max(1, count));
  const appear = new Map<number, number>();
  for (const chunk of layout.chunks) {
    const at = frame.wordAt(chunk.first);
    appear.set(chunk.order, at !== undefined ? Math.max(0, at) : chunk.order * pace);
  }
  if (layout.kanji) {
    const e = easeOutCubic(t / 700);
    const drift = env.motion ? 1 + 0.04 * clamp01(t / 6000) : 1;
    blit(g, layout.kanji.sprite, layout.kanji.x, layout.kanji.y + (1 - e) * S * 0.4, drift, 0, e * (1 - exit));
    // Beat: the giant outline kanji throbs.
    if (frame.beat.pulse > 0.02) blit(g, layout.kanji.sprite, layout.kanji.x, layout.kanji.y + (1 - e) * S * 0.4, drift * (1 + 0.035 * frame.beat.pulse), 0, Math.min(1, frame.beat.pulse) * 0.7 * e * (1 - exit));
  }
  g.lineWidth = 1 + 0.8 * frame.beat.pulse; g.strokeStyle = `${layout.color.faint}0.85)`; g.lineCap = 'round';
  g.shadowColor = layout.color.shade; g.shadowBlur = 2 * env.dpr;
  for (const link of layout.links) {
    const target = link.to >= 0 ? appear.get(link.to) ?? 0 : (appear.get(layout.chunks[0]?.order ?? 0) ?? 0) + 200;
    const grow = env.motion ? easeInOutSine((t - (target - 260)) / 260) : 1;
    const shrink = 1 - easeOutCubic(exit * 1.4);
    const len = (link.x1 - link.x0) * grow * shrink;
    if (len <= 0.5) continue;
    const x1 = link.x0 + len;
    const bx = link.x0 + (link.x1 - link.x0) * link.bump, r = S * 0.16;
    g.beginPath(); g.moveTo(link.x0, link.y);
    if (x1 > bx + r && link.kind !== 2) {
      g.lineTo(bx - r, link.y);
      if (link.kind === 0) g.arc(bx, link.y, r, Math.PI, 0, true); // ︶ wave dip
      else { g.lineTo(bx, link.y - r * 1.3); g.lineTo(bx + r, link.y); } // ^ peak
      g.lineTo(x1, link.y);
    } else g.lineTo(x1, link.y);
    g.stroke();
  }
  g.shadowBlur = 0;
  for (const chunk of layout.chunks) {
    const tc = t - (appear.get(chunk.order) ?? 0);
    if (tc <= 0) continue;
    const decode = 220;
    if (intensity > 0 && tc < decode) {
      glitch(g, chunk, 1 - tc / decode, step, layout.seed, layout, intensity, 1);
      continue;
    }
    const flickerSlot = Math.floor(t / 2300);
    const flicker = intensity > 0 && exit === 0 && rng(hash(`${layout.seed}:${chunk.order}:${flickerSlot}`))() < 0.35 && t % 2300 < 80;
    if (exit > 0 && intensity > 0) {
      const p = clamp01(exit * 1.3 - chunk.order * 0.08);
      glitch(g, chunk, p, step, layout.seed, layout, intensity, 1 - p * p);
    } else if (flicker) glitch(g, chunk, 0.35, step, layout.seed, layout, intensity, 1);
    // Beat: strong beats scramble a seeded subset of the phrases for a moment.
    else if (intensity > 0 && frame.beat.pulse > 0.45 && rng(hash(`${layout.seed}:${chunk.order}:beat${frame.beat.index}`))() < 0.4)
      glitch(g, chunk, 0.3 * Math.min(1, frame.beat.pulse), step + frame.beat.index * 7, layout.seed, layout, intensity, 1);
    else blit(g, chunk.sprite, chunk.x, chunk.y, 1, 0, intensity > 0 ? 1 : clamp01(tc / 200) * (1 - exit));
  }
  const tail = easeOutCubic((t - 300) / 500) * (1 - exit);
  if (layout.micro) blit(g, layout.micro.sprite, layout.micro.x, layout.micro.y, 1, 0, tail);
  if (layout.dashes.length && tail > 0) {
    g.globalAlpha = tail * 0.5; g.fillStyle = layout.color.ink;
    const h = Math.max(1, S * 0.05);
    for (const dash of layout.dashes) g.fillRect(dash.x, dash.y, dash.w, h);
    g.globalAlpha = 1;
  }
}

export const elegyStyle: PvStyle<Layout> = {
  id: 'elegy', exitMs: 380,
  fonts: [],
  height: (size, translation) => size * 2.5 + (translation ? size * 0.4 : 0),
  layout, draw,
};
