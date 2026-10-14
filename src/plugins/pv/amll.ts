import { clamp01, isSpace, lineBoundary } from './core';
import { AUTO_FAMILIES, type Face } from '../typeface';
import { blit, sprite, type Sprite } from './paint';
import { faceFont, type PvEnv, type PvFrame, type PvLine, type PvSceneApi, type PvStyle } from './stage';

// Apple Music-like scrolling list, after AMLL's lyric player (behaviour only,
// independently implemented): left-aligned bold lines, the current line near
// the top third, others dimmed, scaled down and blurred by distance; sung words
// sweep bright with a soft edge and float up; long words swell and glow per
// character; three breathing dots fill long interludes. Scrolling uses the
// closed-form response of AMLL's spring parameters, so every frame is still a
// pure function of the song position.

interface Token { sprite: Sprite; x: number; row: number; w: number; word: number; chars?: { sprite: Sprite; x: number }[] }
interface Layout {
  size: number; rowH: number; height: number; tokens: Token[]; timed: boolean;
  line: PvLine; translation?: { sprite: Sprite; y: number };
}

/** The theme font: an automatic preset follows the line's language, anything else is the user's own family. */
const themeFace = (setting: string, pick: (role: typeof AUTO_FAMILIES[string]['role'], weight: number) => Face, weight: number): Face => {
  const auto = AUTO_FAMILIES[setting];
  return auto ? pick(auto.role, weight) : { family: setting, weight, style: 'normal' };
};
const textSprite = (text: string, size: number, k: number, face: Face) => {
  const probe = document.createElement('canvas').getContext('2d');
  if (probe) probe.font = faceFont(face, size);
  const w = Math.max(1, probe?.measureText(text).width ?? size * text.length), pad = size * 0.3;
  return sprite(w + pad * 2, size * 1.5, k, (g, k) => {
    g.font = faceFont(face, size); g.textBaseline = 'middle'; g.fillStyle = '#ffffff';
    // A soft dark shadow keeps white text legible when the desktop behind is light.
    g.shadowColor = 'rgba(0,0,0,0.42)'; g.shadowBlur = size * 0.14 * k; g.shadowOffsetY = size * 0.02 * k;
    g.fillText(text, pad, size * 0.75);
  }, pad, size * 0.75);
};

function layout(g: CanvasRenderingContext2D, line: PvLine, env: PvEnv): Layout {
  const S = env.size, dpr = env.dpr, face = themeFace(env.fontFamily, line.face, 700);
  const timed = line.words.length > 0;
  // Tokens: real words when timed, otherwise word-segmenter chunks.
  const groups: number[][] = [];
  line.glyphs.forEach((glyph, i) => {
    const key = timed ? line.wordOf[i] : -1;
    const startNew = !groups.length || (timed ? line.wordOf[i - 1] !== key : line.starts.has(i) || isSpace(glyph) || isSpace(line.glyphs[i - 1]));
    if (startNew) groups.push([i]); else groups.at(-1)!.push(i);
  });
  g.font = faceFont(face, S);
  const maxW = env.width * 0.94, rowH = S * 1.3;
  const tokens: Token[] = [];
  let x = 0, row = 0;
  for (const group of groups) {
    const text = group.map(i => line.glyphs[i] === '\n' ? ' ' : line.glyphs[i]).join('');
    const w = g.measureText(text).width;
    if (x > 0 && x + w > maxW && text.trim()) { row++; x = 0; }
    if (!text.trim()) { x += w; continue; }
    const word = timed ? line.wordOf[group[0]] : -1;
    const token: Token = { sprite: textSprite(text, S, dpr * 1.12, face), x, row, w, word };
    const span = word >= 0 ? line.words[word] : undefined;
    // Emphasis is reserved for long-held short words, as in AMLL.
    if (span && span.end - span.start >= 1000 && group.length <= 7) {
      let cx = x;
      token.chars = group.map(i => {
        const char = line.glyphs[i], cw = g.measureText(char).width;
        const result = { sprite: textSprite(char, S, dpr * 1.25, face), x: cx };
        cx += cw;
        return result;
      });
    }
    tokens.push(token);
    x += w;
  }
  const rows = row + 1;
  let height = rows * rowH;
  const result: Layout = { size: S, rowH, height, tokens, timed, line };
  if (env.showTranslation && line.translation) {
    result.translation = { sprite: textSprite(line.translation, S * 0.5, dpr, themeFace(env.fontFamily, line.tface, 500)), y: height + S * 0.38 };
    height += S * 0.75;
  }
  result.height = height;
  return result;
}

/** Remaining displacement fraction of a spring released from rest at 1 (AMLL-style mass / stiffness / damping). */
function springRemaining(seconds: number, stiffness: number, damping: number, mass: number): number {
  if (seconds <= 0) return 1;
  const w0 = Math.sqrt(stiffness / mass), zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return Math.exp(-zeta * w0 * seconds) * (Math.cos(wd * seconds) + (zeta * w0 / wd) * Math.sin(wd * seconds));
  }
  if (zeta === 1) return (1 + w0 * seconds) * Math.exp(-w0 * seconds);
  const root = Math.sqrt(zeta * zeta - 1), r1 = -w0 * (zeta - root), r2 = -w0 * (zeta + root);
  return (r2 * Math.exp(r1 * seconds) - r1 * Math.exp(r2 * seconds)) / (r2 - r1);
}
/** AMLL scroll spring: snappier for lines that follow quickly, slow for the first line. */
function springFor(intervalMs: number | undefined) {
  if (intervalMs === undefined) return { k: 90, c: 15 };
  const ratio = (1 - (Math.min(800, Math.max(100, intervalMs)) - 100) / 700) ** 0.2;
  const k = 170 + ratio * 50;
  return { k, c: Math.sqrt(k) * 2.2 };
}

/** Bell-shaped swell used by emphasised characters. */
const swell = (x: number) => x <= 0 || x >= 1 ? 0 : Math.sin(Math.PI * Math.min(1, x * 1.25)) ** 2;

interface LineState { focus: number; blur: number; scale: number }

function drawLine(g: CanvasRenderingContext2D, item: Layout, position: number, state: LineState, env: PvEnv) {
  const S = item.size, line = item.line, active = state.focus;
  g.save();
  if (state.scale !== 1) g.scale(state.scale, state.scale);
  if (state.blur > 0.3 && env.motion) g.filter = `blur(${state.blur.toFixed(1)}px)`;
  // Inactive lines sit at 35 %; on the current line unsung text is 42 % and sung text is full white.
  const unsung = 0.35 + 0.07 * active, sungAlpha = 0.35 + 0.65 * active;
  for (const token of item.tokens) {
    const ty = token.row * item.rowH + item.rowH / 2;
    const span = token.word >= 0 ? line.words[token.word] : undefined;
    // Sweep progress: real word timing, or the whole line lit while it is current.
    const progress = active <= 0 ? 0 : span ? clamp01((position - span.start) / Math.max(1, span.end - span.start)) : 1;
    const float = span && env.motion ? -0.05 * S * (1 - (1 - clamp01((position - span.start) / Math.max(1000, span.end - span.start))) ** 2) * active : 0;
    if (token.chars && span && active > 0 && env.motion && progress > 0) {
      const du = Math.max(1000, span.end - span.start);
      let amount = du / 2000; amount = Math.min(1.2, (amount > 1 ? Math.sqrt(amount) : amount ** 3) * 0.6);
      let glow = du / 3000; glow = Math.min(0.8, (glow > 1 ? Math.sqrt(glow) : glow ** 3) * 0.5);
      const n = token.chars.length;
      token.chars.forEach((char, i) => {
        const e = swell((position - span.start - (du / 2.5 / n) * i) / du);
        const cx = char.x - e * 0.03 * amount * (n / 2 - i) * S, cy = ty + float - e * 0.025 * amount * S;
        const lit = clamp01(progress * n - i);
        blit(g, char.sprite, cx, cy, 1 + e * 0.1 * amount, 0, unsung + (sungAlpha - unsung) * lit);
        if (e * glow > 0.02) {
          g.save(); g.shadowColor = `rgba(255,255,255,${(e * glow).toFixed(3)})`; g.shadowBlur = Math.min(0.3, glow * 0.3) * S * env.dpr;
          blit(g, char.sprite, cx, cy, 1 + e * 0.1 * amount, 0, e * glow * 0.6); g.restore();
        }
      });
      continue;
    }
    blit(g, token.sprite, token.x, ty + float, 1, 0, progress >= 1 ? sungAlpha : unsung);
    if (progress <= 0 || progress >= 1) continue;
    // Soft-edged sweep: bright up to the edge, then fading over half a word-height in slices.
    const fade = S * 0.5, edge = token.x + (token.w + fade) * progress, slices = 6;
    for (let k = 0; k <= slices; k++) {
      const x0 = k === 0 ? token.x - S : edge - fade + (fade * (k - 1)) / slices, x1 = k === 0 ? edge - fade : edge - fade + (fade * k) / slices;
      if (x1 <= x0) continue;
      g.save(); g.beginPath(); g.rect(x0, ty - item.rowH, x1 - x0, item.rowH * 2); g.clip();
      blit(g, token.sprite, token.x, ty + float, 1, 0, (sungAlpha - unsung) * (k === 0 ? 1 : 1 - (k - 0.5) / slices));
      g.restore();
    }
  }
  if (item.translation) blit(g, item.translation.sprite, 0, item.translation.y, 1, 0, 0.3 + 0.2 * active);
  g.restore();
}

function scene(g: CanvasRenderingContext2D, api: PvSceneApi<Layout>, env: PvEnv) {
  const { lines, position } = api, H = env.height, gap = env.size * 0.32;
  const items: { index: number; start: number; end?: number; layout: Layout; background: boolean }[] = [];
  lines.forEach((line, index) => {
    const prepared = api.line(index);
    const layout = prepared && api.layout(index);
    if (!prepared || !layout || line.startMs === undefined) return;
    items.push({ index, start: line.startMs, end: lineBoundary(lines, index), layout, background: Boolean(line.isBackground) });
  });
  const main = items.filter(item => !item.background);
  if (!main.length) return;
  let focus = -1;
  for (let i = 0; i < main.length; i++) if (main[i].start <= position) focus = i;
  const anchor = H * Number(env.options.anchor ?? 0.3);
  // Interlude: three dots after a line once a long gap opens before the next one.
  const current = main[focus], next = main[focus + 1];
  const gapStart = current ? current.end ?? next?.start : undefined;
  const interlude = env.options.dots !== false && current && next && gapStart !== undefined && next.start - gapStart >= 4000 && position >= gapStart && position < next.start
    ? clamp01((position - gapStart) / 400) * clamp01((next.start - position) / 400) : 0;
  const dotsH = env.size * 0.8 * interlude;
  // Background vocals sit under their line while sung, taking room as they appear.
  const bgOf = new Map<number, { layout: Layout; vis: number }>();
  for (const item of items) if (item.background) {
    const owner = main.filter(m => m.index < item.index).at(-1);
    if (!owner) continue;
    const vis = clamp01((position - item.start) / 300) * (item.end === undefined ? 1 : clamp01((item.end - position) / 300));
    if (vis > 0) bgOf.set(owner.index, { layout: item.layout, vis });
  }
  const offsets: number[] = [];
  let acc = 0;
  main.forEach((item, i) => {
    offsets.push(acc);
    acc += item.layout.height + gap + (bgOf.get(item.index)?.vis ?? 0) * item.layout.size * 0.95;
    if (i === focus) acc += dotsH;
  });
  const focusOffset = focus >= 0 ? offsets[focus] : 0;
  // Recent focus changes still settling, each with its own spring.
  const transitions: { at: number; delta: number; spring: { k: number; c: number } }[] = [];
  for (let i = Math.max(1, focus - 4); i <= focus; i++) {
    if (position - main[i].start > 2500) continue;
    transitions.push({ at: main[i].start, delta: offsets[i] - offsets[i - 1], spring: springFor(main[i].start - main[i - 1].start) });
  }
  const sinceFocus = focus >= 0 ? position - main[focus].start : Infinity;
  const blend = env.motion ? clamp01(sinceFocus / 400) : 1;
  const top = focus >= 0 ? focus : 0;
  main.forEach((item, i) => {
    const rank = Math.max(0, i - (top - 1));
    let y = anchor + offsets[i] - focusOffset;
    if (env.motion) for (const move of transitions) {
      const delay = Math.min(300, rank * 50 * Math.pow(1 / 1.05, Math.max(0, i - top)));
      // Snap the sub-pixel tail so a settled list is truly static (no shimmering re-rasterisation).
      const rest = move.delta * springRemaining((position - move.at - delay) / 1000, move.spring.k, move.spring.c, 0.9);
      if (Math.abs(rest) > 0.2) y += rest;
    }
    if (y > H + env.size * 2 || y + item.layout.height < -env.size * 2) return;
    // Visual state eases from the previous focus to the current one (AMLL's 0.4 s transitions).
    const stateFor = (f: number) => {
      const isFocus = i === f && (f !== focus || position < (item.end ?? Infinity) || !interlude);
      const distance = i < f ? f - i + 1 : i - f;
      return { focus: isFocus ? 1 : 0, blur: isFocus || env.options.blur === false ? 0 : Math.min(5, 1 + distance) * env.size / 48, scale: isFocus ? 1 : 0.97 };
    };
    const now = stateFor(focus), before = stateFor(focus - 1);
    const mixed: LineState = { focus: now.focus * blend + before.focus * (1 - blend),
      blur: now.blur * blend + before.blur * (1 - blend), scale: now.scale * blend + before.scale * (1 - blend) };
    g.save(); g.translate(0, y); drawLine(g, item.layout, position, mixed, env); g.restore();
    const bg = bgOf.get(item.index);
    if (bg) {
      g.save(); g.translate(0, y + item.layout.height); g.scale(0.7, 0.7); g.globalAlpha = 0.4 * bg.vis;
      drawLine(g, bg.layout, position, { focus: 1, blur: 0, scale: 1 }, env); g.restore();
    }
    if (i === focus && interlude > 0) {
      const progress = clamp01((position - gapStart!) / (next!.start - gapStart!));
      const breathe = env.motion ? 1 + 0.08 * Math.sin(position / 1500 * Math.PI * 2) : 1;
      const r = env.size * 0.15 * breathe * interlude, cy = y + item.layout.height + gap / 2 + dotsH / 2;
      for (let d = 0; d < 3; d++) {
        g.globalAlpha = (0.25 + 0.75 * clamp01(progress * 3 - d)) * interlude;
        g.fillStyle = '#ffffff'; g.beginPath(); g.arc(env.size * 0.2 + d * r * 3.2, cy, r, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
    }
  });
}

export const amllStyle: PvStyle<Layout> = {
  id: 'amll', exitMs: 400,
  fonts: [],
  height: (size, translation, options) => Number(options.rows ?? 3) * size * (translation ? 2.0 : 1.62),
  layout,
  // Untimed text (no scene): every line shown plainly, fading in once.
  draw(g, layout, frame: PvFrame, env) {
    g.globalAlpha = clamp01(frame.t / 300) * (1 - frame.exit);
    g.translate(0, env.height * 0.1);
    drawLine(g, layout, 0, { focus: 1, blur: 0, scale: 1 }, env);
  },
  scene,
};
