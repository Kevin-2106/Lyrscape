import { breakRows, clamp01, easeOutCubic, hash, isSpace, rng, splitAt } from './core';
import { detectLang, faceFor, type Face } from '../typeface';
import { requestFonts } from './fonts';
import { blit, font, mix, rgba, sprite, type Sprite } from './paint';
import { faceFont, hue, type PvEnv, type PvFrame, type PvLine, type PvScene, type PvStyle } from './stage';

// Synthesis: a music-theory HUD. A code-like header names the section, a
// countdown runs to the next line, the lyric types in with a cursor, and the
// bottom row lights the pitch classes actually sounding (live PCM chroma).
// Spectrum bars and an oscilloscope frame the edges; colour shards drift by.
// 文字 / 光晕 options; set before each layout and backdrop (option changes rebuild layouts).
let INK = '#f3f0ff', LAVENDER = '#b7a6ff', GLOW = 'rgba(150,128,255,0.95)';
const SHADE = 'rgba(12,8,36,0.8)';
function usePalette(env: PvEnv) {
  INK = hue(env, 'ink', '#f3f0ff');
  const glow = hue(env, 'glow', '#9680ff');
  GLOW = rgba(glow, 0.95); LAVENDER = mix(glow, '#ffffff', 0.35);
}
const SHARDS = ['#ff3b6b', '#ffb02e', '#3be8ff', '#8a5cff', '#ff6bd6', '#5cff9d', '#ffe14a'];
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SCRAMBLE = '01<>/\\{}[]=+*#%';
const MONO = faceFor('mono', 'latin', '').family;
let titleFace: { title: string; face: Face } | undefined;
/** HUD title face: Latin mono, or the code face of the title's own language when it has CJK. */
function titleFont(title: string, size: number) {
  if (titleFace?.title !== title) {
    titleFace = { title, face: faceFor('mono', detectLang([title]), title) };
    requestFonts([faceFont(titleFace.face, 32)], title);
  }
  return faceFont(titleFace.face, size);
}

interface Glyph { sprite: Sprite; x: number; y: number; index: number; w: number }
interface Layout {
  size: number; glyphs: Glyph[]; seed: number; hero: boolean;
  cursorH: number; translation?: { sprite: Sprite; x: number; y: number };
}

/** Vertical bands of the composition, shared by layout and backdrop. */
const bands = (env: PvEnv) => {
  const S = env.size, H = env.height;
  const translation = env.showTranslation ? S * 0.45 : 0;
  return { header: S * 0.32, next: S * 0.68, lyric: S * 0.95 + (H - translation - S * 1.6) / 2, notes: H - S * 0.28, translationY: H - S * 0.85,
    side: env.width > S * 14 ? S * 1.15 : 0 };
};

const glyphSprite = (text: string, size: number, k: number, face: Face) => {
  const w = size * 1.3, h = size * 1.6;
  return sprite(w, h, k, (g, k) => {
    g.font = faceFont(face, size); g.textAlign = 'center'; g.textBaseline = 'middle';
    // Dark under-shadow for light desktops, then the lavender glow.
    g.shadowColor = SHADE; g.shadowBlur = size * 0.12 * k; g.fillStyle = INK; g.fillText(text, w / 2, h / 2);
    g.shadowColor = GLOW; g.shadowBlur = size * 0.32 * k;
    g.fillStyle = INK; g.fillText(text, w / 2, h / 2);
    g.shadowBlur = size * 0.08 * k; g.fillText(text, w / 2, h / 2);
  });
};

function layout(g: CanvasRenderingContext2D, line: PvLine, env: PvEnv): Layout {
  const { width: W, dpr } = env, b = bands(env);
  const glyphs = line.glyphs.map(glyph => glyph === '\n' ? ' ' : glyph);
  let S = env.size * (line.hero ? 1.12 : 0.9);
  const face = line.face('code', 500);
  g.font = faceFont(face, S);
  const advance = (i: number) => isSpace(glyphs[i]) ? S * 0.5 : g.measureText(glyphs[i]).width + S * 0.06;
  const usable = W - b.side * 2 - env.size;
  const total = glyphs.reduce((sum, _, i) => sum + advance(i), 0);
  const rows = total > usable ? 2 : 1;
  const parts = splitAt(glyphs.map((_, i) => i), breakRows(glyphs, rows, advance, line.starts));
  const widest = Math.max(...parts.map(part => part.reduce((sum, i) => sum + advance(i), 0)));
  const fit = Math.min(1, usable / widest, rows > 1 ? 0.82 : 1);
  S *= fit;
  const lineH = S * 1.25, k = dpr * 1.1;
  const glyphsOut: Glyph[] = [];
  parts.forEach((part, r) => {
    const rowW = part.reduce((sum, i) => sum + advance(i), 0) * fit;
    let x = (W - rowW) / 2;
    for (const i of part) {
      const w = advance(i) * fit;
      if (!isSpace(glyphs[i])) glyphsOut.push({ sprite: glyphSprite(glyphs[i], S, k, face), x: x + w / 2, y: b.lyric + (r - (rows - 1) / 2) * lineH, index: i, w });
      x += w;
    }
  });
  const result: Layout = { size: S, glyphs: glyphsOut, seed: line.seed, hero: line.hero, cursorH: S * 1.05 };
  if (env.showTranslation && line.translation) {
    const T = env.size * 0.34, tface = line.tface('code', 300);
    const w = line.translation.length * T + T;
    result.translation = { sprite: sprite(w, T * 1.6, dpr, g => {
      g.font = faceFont(tface, T); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = LAVENDER; g.fillText(line.translation, w / 2, T * 0.8);
    }), x: W / 2, y: b.translationY };
  }
  return result;
}

function draw(g: CanvasRenderingContext2D, layout: Layout, frame: PvFrame, env: PvEnv) {
  const { t, exit } = frame, n = layout.glyphs.length, S = layout.size;
  const pace = Math.min(42, 1000 / Math.max(1, n));
  let typed = -1, lastX = layout.glyphs[0]?.x ?? 0, lastY = layout.glyphs[0]?.y ?? 0;
  layout.glyphs.forEach((glyph, i) => {
    const at = frame.wordAt(glyph.index);
    const appear = at !== undefined ? Math.max(0, at) : 60 + i * pace;
    const tg = t - appear;
    if (tg < 0) return;
    typed = i; lastX = glyph.x + glyph.w / 2; lastY = glyph.y;
    // Spread apart and fade on exit, like a buffer being cleared.
    const spread = (i - (n - 1) / 2) * exit * S * 0.12 * env.amp;
    const alpha = 1 - exit;
    if (tg < 70 * Math.min(2, env.amp) && env.motion) {
      // Two frames of scrambled code before the character settles.
      const r = rng(hash(`${layout.seed}:${i}:${Math.floor(tg / 35)}`))();
      g.save(); g.globalAlpha = alpha * 0.8; g.font = font(400, S * 0.9, MONO); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = LAVENDER; g.fillText(SCRAMBLE[Math.floor(r * SCRAMBLE.length)], glyph.x + spread, glyph.y); g.restore();
      return;
    }
    const sung = frame.sung(glyph.index);
    const bright = sung < 0 ? 1 : 0.5 + 0.5 * clamp01(sung * 3);
    blit(g, glyph.sprite, glyph.x + spread, glyph.y, 1 + 0.04 * frame.beat.pulse, 0, alpha * bright * clamp01((tg - 70 * Math.min(2, env.amp)) / 90 + 0.4));
  });
  // Block cursor after the last typed character; it blinks once typing has finished.
  const done = typed === n - 1 && t > 60 + n * pace + 200;
  if (exit === 0 && n && (!done || Math.floor(t / 530) % 2 === 0) && env.motion) {
    g.fillStyle = INK; g.globalAlpha = 0.85;
    g.fillRect(lastX + S * 0.08, lastY - layout.cursorH / 2, S * 0.42, layout.cursorH);
    g.globalAlpha = 1;
  }
  if (layout.translation) blit(g, layout.translation.sprite, layout.translation.x, layout.translation.y, 1, 0, easeOutCubic((t - 300) / 400) * (1 - exit));
}

const clock = (ms: number) => {
  const total = Math.max(0, ms) / 1000, m = Math.floor(total / 60), s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

function backdrop(g: CanvasRenderingContext2D, frame: { scene: PvScene; beat: PvFrame['beat']; current?: PvLine; motion: boolean }, env: PvEnv) {
  const { scene, beat, current } = frame, { width: W, height: H, size: S, options } = env, b = bands(env);
  const audio = scene.audio;
  if (options.shards !== false) {
    // Shards and notes drift up-right along the diagonal, driven by song position (pause-safe).
    const random = rng(hash(scene.title || 'synthesis'));
    const travel = frame.motion ? scene.position / 1000 : 0;
    for (let i = 0; i < 16; i++) {
      const speed = S * (0.6 + random() * 1.4), span = W + S * 4;
      const x = ((random() * span + travel * speed) % span) - S * 2;
      const y = H * (0.1 + random() * 0.8) - (x / W) * H * 0.35;
      const size = S * (0.12 + random() * 0.22), color = SHARDS[Math.floor(random() * SHARDS.length)];
      g.save(); g.translate(x, y); g.rotate(-0.55 + random() * 0.3); g.globalAlpha = 0.5 + 0.3 * random();
      if (i % 5 === 4) {
        g.font = font(400, size * 2.6, MONO); g.fillStyle = '#ffc94a'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(i % 10 === 4 ? '♪' : '♫', 0, 0);
      } else {
        g.fillStyle = color; g.beginPath(); g.moveTo(-size, 0); g.lineTo(0, -size * 0.45); g.lineTo(size, 0); g.lineTo(0, size * 0.45); g.closePath(); g.fill();
      }
      g.restore();
    }
  }
  g.textBaseline = 'middle';
  if (options.hud !== false) {
    g.shadowColor = SHADE; g.shadowBlur = S * 0.12 * env.dpr;
    g.fillStyle = INK; g.textAlign = 'center';
    const title = (scene.title || 'Lyric').replace(/\s+/g, '').slice(0, 24);
    g.font = titleFont(title, S * 0.42);
    g.fillText(`${title}.${current?.hero ? 'chorus' : current ? 'verse' : 'interlude'}()`, W / 2, b.header);
    g.font = font(400, S * 0.27, MONO); g.fillStyle = LAVENDER;
    g.fillText(`Next line in: ${scene.nextIn === undefined ? '--.--' : (Math.min(99990, scene.nextIn) / 1000).toFixed(2).padStart(5, '0')}s`, W / 2, b.next);
    if (scene.durationMs) {
      g.textAlign = 'right'; g.font = font(400, S * 0.4, MONO); g.fillStyle = INK;
      g.fillText(clock(scene.durationMs - scene.position), W - b.side - S * 0.2, b.header);
    }
    if (beat.bpm) {
      g.textAlign = 'left'; g.font = font(400, S * 0.26, MONO); g.fillStyle = LAVENDER;
      g.fillText(`♩=${Math.round(beat.bpm)}`, S * 0.1, b.notes);
    }
    g.shadowBlur = 0;
  }
  if (options.notes !== false) {
    // Pitch classes sounding right now; without audio the row rests dim.
    const span = Math.min(W * 0.62, S * 22), x0 = (W - span) / 2;
    g.font = font(400, S * 0.46, MONO); g.textAlign = 'center';
    g.fillStyle = INK; g.globalAlpha = 0.85; g.shadowColor = SHADE; g.shadowBlur = S * 0.1 * env.dpr;
    g.fillText('[', x0, b.notes); g.fillText(']', x0 + span, b.notes);
    NOTES.forEach((note, i) => {
      const level = audio ? audio.chroma[i] : 0;
      const lit = audio ? clamp01((level - 0.45) / 0.35) : 0;
      g.globalAlpha = audio ? lit : 0.14;
      if (g.globalAlpha < 0.02) return;
      g.shadowColor = lit > 0.05 ? GLOW : SHADE; g.shadowBlur = (lit > 0.05 ? lit * 0.25 : 0.1) * S * env.dpr;
      g.fillText(note, x0 + span * (i + 1) / 13, b.notes);
    });
    g.globalAlpha = 1; g.shadowBlur = 0;
  }
  if (options.scopes !== false && b.side) {
    // Left: mirrored spectrum bars; right: vertical oscilloscope.
    const top = S * 0.2, bottom = H - S * 0.2, cx = b.side / 2;
    g.fillStyle = LAVENDER; g.globalAlpha = 0.75;
    const count = 24;
    for (let i = 0; i < count; i++) {
      const level = audio ? audio.bands[Math.abs(i - count / 2) * 2 % count] : 0;
      const w = Math.max(S * 0.04, level * b.side * 0.9);
      const y = top + (bottom - top) * (i + 0.5) / count;
      g.fillRect(cx - w / 2, y - 0.75, w, 1.5);
    }
    g.strokeStyle = LAVENDER; g.lineWidth = 1.2; g.beginPath();
    const rx = W - b.side / 2;
    const wave = audio?.wave;
    for (let i = 0; i < 64; i++) {
      const v = wave ? wave[i * 2] : 0;
      const x = rx + Math.max(-1, Math.min(1, v * 2.5)) * b.side * 0.45, y = top + (bottom - top) * i / 63;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke(); g.globalAlpha = 1;
  }
}

export const synthStyle: PvStyle<Layout> = {
  id: 'synth', exitMs: 320, audio: true,
  fonts: [font(400, 32, MONO)],
  height: (size, translation) => size * 3.3 + (translation ? size * 0.45 : 0),
  layout: (g, line, env) => { usePalette(env); return layout(g, line, env); },
  draw,
  backdrop: (g, frame, env) => { usePalette(env); backdrop(g, frame, env); },
};
