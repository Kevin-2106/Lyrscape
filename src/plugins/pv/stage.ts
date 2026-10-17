import type { AppState, AudioAnalysis, BeatDetector, ConfigField, ConfigValue, LyricDocument, LyricLine, Renderer } from '../../sdk/types';
import { normalizeConfig } from '../management';
import { activeLine, hasGranularWordTiming } from '../renderer';
import { chorusLines, clamp01, graphemes, hash, lineBoundary, repeatCount, wordStarts } from './core';
import { documentLangs, faceFor, langTag, lineLang, type Face, type Lang, type Role } from '../typeface';
import { fontsVersion, requestFonts } from './fonts';
import { captureSprites, font, releaseSprites, type Sprite } from './paint';

/** One lyric line prepared for a style; everything a layout may depend on is in `key`. */
export interface PvLine {
  key: string; id: string; text: string;
  /** Index in the document (-1 for untimed text), e.g. for alternating placements. */
  index: number; drawn: string; glyphs: string[];
  /** Word-timing index per glyph, or -1 when the source has no granular timing. */
  wordOf: number[]; words: { start: number; end: number }[];
  starts: Set<number>; hero: boolean; translation: string; seed: number;
  /** Languages of the lyric and its translation; each picks one CJK family for the whole text. */
  lang: Lang; translationLang: Lang;
  /** Face of `role` for this line's text (requests the font load for exactly this text). */
  face(role: Role, weight?: number, style?: string): Face;
  /** Face of `role` for the translation. */
  tface(role: Role, weight?: number, style?: string): Face;
}
/** Canvas font string for a face. */
export const faceFont = (face: Face, size: number) => font(face.weight, size, face.family, face.style);
/** Roles that only draw Latin HUD text; the 字体 option never replaces them. */
const LATIN_ROLES = new Set<Role>(['mono', 'script', 'serif', 'arcade']);
function faceRequester(text: string, lang: Lang, override?: Role) {
  const cache = new Map<string, Face>();
  return (requested: Role, weight = 400, style = 'normal') => {
    const role = override && !LATIN_ROLES.has(requested) ? override : requested;
    const key = `${role}\u0000${weight}\u0000${style}`;
    let face = cache.get(key);
    if (!face) { face = faceFor(role, lang, text, weight, style); cache.set(key, face); }
    requestFonts([faceFont(face, 32)], text);
    return face;
  };
}
export interface PvEnv {
  width: number; height: number; dpr: number; size: number;
  options: Record<string, ConfigValue>; motion: boolean; showTranslation: boolean;
  /** The theme's font family, for styles that follow the user's font. */
  fontFamily: string;
  /** 动效强度: scales entrance travel, overshoot, shake and particle spread (1 = the reference PV). */
  amp: number;
}
/** A style colour option (`#rrggbb`), or the reference colour when unset. */
export const hue = (env: PvEnv, key: string, fallback: string) => {
  const value = env.options[key];
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
};
export interface PvFrame {
  /** Milliseconds since the line started (huge when motion is off, so entrances are settled). */
  t: number;
  /** 0 while holding, rising to 1 as the line leaves. */
  exit: number;
  /** Progress 0..1 of the glyph's real sung word, or -1 without granular timing. */
  sung(glyph: number): number;
  /** Real word start relative to line start, or undefined without granular timing. */
  wordAt(glyph: number): number | undefined;
  /** Live beat, already scaled by the 跟随节拍 strength; pulse is 0 without audio or motion. */
  beat: { pulse: number; phase: number; index: number; level: number; bpm: number };
  scene: PvScene;
}
/** Song-level context shared by every line drawn in a frame. */
export interface PvScene {
  position: number; durationMs?: number; title: string;
  /** Milliseconds until the next foreground line starts; undefined when none follows. */
  nextIn?: number;
  /** Live spectrum for styles that declare `audio`; undefined without PCM. */
  audio?: AudioAnalysis;
}
/** Whole-list access for styles that lay out many lines themselves (scene mode). */
export interface PvSceneApi<L> {
  lines: LyricLine[]; position: number; active: number; scene: PvScene;
  beat: PvFrame['beat'];
  /** Prepared line, or undefined for empty / zero-length / untimed lines. */
  line(index: number): PvLine | undefined;
  layout(index: number): L | undefined;
  /** Same as PvFrame.sung for line `index`. */
  sung(index: number, glyph: number): number;
}
export interface PvStyle<L = unknown> {
  id: string;
  exitMs: number;
  /** Fixed (Latin / HUD) fonts to preload; line text fonts come from PvLine.face(). */
  fonts: string[];
  height(size: number, showTranslation: boolean, options: Record<string, ConfigValue>): number;
  layout(g: CanvasRenderingContext2D, line: PvLine, env: PvEnv): L;
  draw(g: CanvasRenderingContext2D, layout: L, frame: PvFrame, env: PvEnv): void;
  /** Reads the live spectrum (chroma, bands, waveform) into PvScene.audio. */
  audio?: boolean;
  /** Drawn once per frame beneath the lines (HUDs, ambient particles); `current` is the line being sung. */
  backdrop?(g: CanvasRenderingContext2D, frame: { scene: PvScene; beat: PvFrame['beat']; current?: PvLine; motion: boolean }, env: PvEnv): void;
  /** Drawn once per frame over the lines (e.g. scanlines composited onto what is already there). */
  overlay?(g: CanvasRenderingContext2D, frame: { scene: PvScene; beat: PvFrame['beat']; current?: PvLine; motion: boolean }, env: PvEnv): void;
  /** Scene mode: draws the whole timed document (e.g. a scrolling list) instead of `draw` per line. */
  scene?(g: CanvasRenderingContext2D, api: PvSceneApi<L>, env: PvEnv): void;
}

const GLYPH_BUDGET = 160;
interface Entry { line: PvLine; start: number; position: number; exit: number; absolute: { start: number; end: number }[] }

function prepare(doc: LyricDocument, index: number, text: string, layoutMode: ConfigValue, fontRole?: Role): Omit<PvLine, 'hero'> & { hero: boolean } {
  const line = doc.lines[index];
  const timed = Boolean(line && doc.timingMode === 'word' && hasGranularWordTiming(line));
  const source = timed ? line!.words!.map(word => word.text).join('') : text;
  const glyphs = graphemes(source);
  const wordOf: number[] = [];
  const words: { start: number; end: number }[] = [];
  if (timed) {
    line!.words!.forEach((word, w) => {
      words.push({ start: word.startMs, end: word.endMs });
      for (let i = graphemes(word.text).length; i > 0; i--) wordOf.push(w);
    });
  } else for (let i = 0; i < glyphs.length; i++) wordOf.push(-1);
  // Sprite budget: very long text is drawn truncated; the accessible label keeps it whole.
  if (glyphs.length > GLYPH_BUDGET) { glyphs.length = GLYPH_BUDGET - 1; glyphs.push('…'); wordOf.length = GLYPH_BUDGET - 1; wordOf.push(-1); }
  const count = glyphs.filter(glyph => glyph.trim()).length;
  // 'section' promotes whole chorus blocks; without a repeated block it behaves like 'auto'.
  const chorus = layoutMode === 'section' ? chorusLines(doc) : null;
  const hero = layoutMode === 'hero' ? true : layoutMode === 'caption' ? false
    : count > 0 && count <= 22 && (chorus ? chorus.has(index) : repeatCount(doc, source) >= 2 || count <= 7);
  const translation = line?.translation ?? line?.romanization ?? '';
  const song = documentLangs(doc), drawn = glyphs.join('');
  const lang = lineLang(source, song.lyrics), translationLang = lineLang(translation, song.translation);
  return { key: `${index}\u0000${source}\u0000${hero}\u0000${translation}`, id: line?.id ?? `static-${index}`, index, text: source, drawn,
    glyphs, wordOf, words, starts: wordStarts(source), hero, translation, seed: hash(`${line?.id ?? ''}:${source}`),
    lang, translationLang, face: faceRequester(drawn, lang, fontRole), tface: faceRequester(translation, translationLang) };
}

/** Fades whatever reaches the bleed margins to transparent instead of hard-cutting it at the window edge. */
function feather(g: CanvasRenderingContext2D, width: number, height: number, bx: number, by: number) {
  g.save();
  g.globalCompositeOperation = 'destination-out';
  const edge = (x0: number, y0: number, x1: number, y1: number, x: number, y: number, w: number, h: number) => {
    const gradient = g.createLinearGradient(x0, y0, x1, y1);
    gradient.addColorStop(0, 'rgba(0,0,0,1)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gradient; g.fillRect(x, y, w, h);
  };
  if (by > 0) { edge(0, 0, 0, by, 0, 0, width, by); edge(0, height, 0, height - by, 0, height - by, width, by); }
  if (bx > 0) { edge(0, 0, bx, 0, 0, 0, bx, height); edge(width, 0, width - bx, 0, width - bx, 0, bx, height); }
  g.restore();
}

/**
 * Canvas stage shared by every PV style. Each frame is a pure function of the
 * timeline position (or the mount's local clock for untimed text), so pause,
 * seek and cross-window sync never accumulate animation state.
 */
const NO_BEAT = { pulse: 0, phase: 0, index: 0, level: 0, bpm: 0 };

export function createPvStage(style: PvStyle, profileId: string, fields: ConfigField[], detector: () => BeatDetector | undefined = () => undefined): Renderer {
  return { mount(root, getState, timeline) {
    root.classList.add('pv-stage'); root.dataset.pvStyle = style.id;
    const canvas = document.createElement('canvas'); canvas.className = 'pv-canvas'; canvas.setAttribute('aria-hidden', 'true');
    const text = document.createElement('div'); text.className = 'pv-text';
    root.replaceChildren(canvas, text);
    let g: CanvasRenderingContext2D | null = null;
    try { g = canvas.getContext('2d'); } catch { g = null; }
    const media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
    const layouts = new Map<string, { layout: unknown; used: number; sprites: Sprite[]; bytes: number }>();
    let layoutBytes = 0;
    const clearLayouts = () => { for (const value of layouts.values()) releaseSprites(value.sprites); layouts.clear(); layoutBytes = 0; };
    const prepared = new Map<string, PvLine>();
    let stored: unknown, options = normalizeConfig(fields, undefined), optionsKey = '';
    let lastDoc: LyricDocument | undefined, staticStart = performance.now(), seenFonts = -1;
    let raf = 0, disposed = false, tick = 0;
    // 动效速度 stretches the visual clock of entrances and exits; word timing stays real.
    const speed = () => Math.min(3, Math.max(0.25, Number(options.speed ?? 1)));

    const line = (doc: LyricDocument, index: number, value: string) => {
      const cacheKey = `${index}\u0000${value}\u0000${options.layout}`;
      let result = prepared.get(cacheKey);
      const role = typeof options.font === 'string' && options.font !== 'auto' ? options.font as Role : undefined;
      if (!result) { result = prepare(doc, index, value, options.layout, role); prepared.set(cacheKey, result); }
      return result;
    };
    const schedule = (state: AppState, position: number): Entry[] => {
      const doc = state.lyrics, lines = doc.lines;
      const local = performance.now() - staticStart;
      if (doc.timingMode === 'none' || !lines.some(item => item.startMs !== undefined)) {
        const value = lines.length ? lines.map(item => item.text).join('\n') : '等待歌词';
        return [{ line: line(doc, -1, value), start: 0, position: local, exit: 0, absolute: [] }];
      }
      const entries: Entry[] = [];
      const main = activeLine(lines, position);
      for (let i = 0; i < lines.length; i++) {
        const item = lines[i];
        if (item.startMs === undefined || position < item.startMs || !item.text.trim()) continue;
        if (item.isBackground && i !== main) continue;
        const end = lineBoundary(lines, i);
        if (end !== undefined && end <= item.startMs) continue;
        let exit = 0;
        if (end !== undefined) {
          const exitMs = style.exitMs / speed();
          const lead = Math.min(exitMs * 0.5, (end - item.startMs) * 0.3);
          exit = clamp01((position - (end - lead)) / exitMs);
          if (exit >= 1) continue;
        }
        const prepared = line(doc, i, item.text);
        entries.push({ line: prepared, start: item.startMs, position, exit,
          absolute: prepared.words });
      }
      return entries.slice(-3);
    };

    const frame = () => {
      if (disposed) return;
      const state = getState(), settings = state.settings;
      const config = state.plugins.configs[profileId];
      if (config !== stored) {
        stored = config; options = normalizeConfig(fields, config);
        const key = JSON.stringify(options);
        if (key !== optionsKey) { optionsKey = key; clearLayouts(); prepared.clear(); }
      }
      if (lastDoc !== state.lyrics) { lastDoc = state.lyrics; staticStart = performance.now(); clearLayouts(); prepared.clear(); }
      if (seenFonts !== fontsVersion()) { seenFonts = fontsVersion(); clearLayouts(); }
      const size = settings.fontSize * Number(options.scale ?? 1);
      // Bleed margins give halos, blooms and particles room inside the overlay window;
      // compositions are laid out in the inner area and anything beyond fades at the edges.
      const width = root.clientWidth || 640;
      const by = Math.round(size * 0.4), bx = Math.round(Math.min(size * 0.35, width * 0.04));
      const inner = Math.round(style.height(size, settings.showTranslation, options));
      const height = inner + by * 2;
      if (root.style.height !== `${height}px`) root.style.height = `${height}px`;
      const dpr = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
      const motion = options.motion !== false && !media?.matches;
      const env: PvEnv = { width: width - bx * 2, height: inner, dpr, size, options, motion, showTranslation: settings.showTranslation, fontFamily: settings.fontFamily,
        amp: Math.max(0, Number(options.intensity ?? 1)) };
      const position = timeline.position(state);
      const entries = schedule(state, position);
      const amount = motion ? Number(options.beat ?? 0) : 0;
      // Gate on live PCM, not playback.playing: AMLL connectors may change tracks without a
      // 'resumed' message, while pausing always stops (and resets) the audio stream.
      const live = amount > 0 ? detector()?.sample() : undefined;
      const beat = live?.active ? { pulse: Math.min(1.5, live.pulse * amount), phase: live.phase, index: live.index, level: live.level, bpm: live.bpm } : NO_BEAT;
      const lines = state.lyrics.lines;
      const timed = state.lyrics.timingMode !== 'none' && lines.some(item => item.startMs !== undefined);
      const nextStart = timed ? lines.find(item => !item.isBackground && item.text.trim() && (item.startMs ?? -1) > position)?.startMs : undefined;
      const scene: PvScene = { position, durationMs: state.track?.durationMs, title: state.track?.title ?? '',
        nextIn: nextStart === undefined ? undefined : nextStart - position,
        audio: style.audio && motion ? detector()?.analysis?.() : undefined };
      const listMode = Boolean(style.scene) && timed;
      const active = listMode ? activeLine(lines, position) : -1;
      const current = listMode ? (active >= 0 && lines[active].text.trim() ? { line: line(state.lyrics, active, lines[active].text), exit: 0 } : undefined)
        : entries.filter(entry => entry.exit === 0).at(-1) ?? entries.at(-1);
      const label = current?.line.text ?? '';
      if (text.textContent !== label) text.textContent = label;
      const tag = current ? langTag(current.line.lang) : '';
      if (text.lang !== tag) text.lang = tag;
      root.dataset.pvLine = current?.line.id ?? '';
      // Every line drawn this frame (ids only), so overlapping lines are visible to QA.
      const drawn = listMode ? current?.line.id ?? '' : entries.map(entry => entry.line.id).join(' ');
      if (root.dataset.pvLines !== drawn) root.dataset.pvLines = drawn;
      root.dataset.pvMode = current ? (current.line.hero ? 'hero' : 'caption') : '';
      const bpm = live?.active ? String(Math.round(live.bpm)) : '';
      if (root.dataset.pvBeat !== bpm) root.dataset.pvBeat = bpm;
      if (g) {
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
          canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
        }
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, canvas.width, canvas.height);
        g.setTransform(dpr, 0, 0, dpr, bx * dpr, by * dpr);
        tick++;
        const layoutOf = (prepared: PvLine) => {
          const key = `${prepared.key}\u0000${width}\u0000${size}\u0000${dpr}\u0000${settings.showTranslation}\u0000${settings.fontFamily}`;
          let cached = layouts.get(key);
          if (!cached) {
            requestFonts(style.fonts, prepared.drawn + prepared.translation);
            g.save();
            try {
              const allocation = captureSprites(() => style.layout(g!, prepared, env));
              cached = { layout: allocation.value, used: tick, sprites: allocation.sprites,
                bytes: allocation.sprites.reduce((sum, sprite) => sum + sprite.canvas.width * sprite.canvas.height * 4, 0) };
            } finally { g.restore(); }
            layouts.set(key, cached);
            layoutBytes += cached.bytes;
          }
          cached.used = tick;
          return cached.layout;
        };
        if (style.backdrop) { g.save(); style.backdrop(g, { scene, beat, current: current?.line, motion }, env); g.restore(); }
        if (listMode) {
          const doc = state.lyrics;
          const usable = (index: number) => {
            const item = lines[index];
            if (!item || item.startMs === undefined || !item.text.trim()) return false;
            const end = lineBoundary(lines, index);
            return end === undefined || end > item.startMs || Boolean(item.isBackground);
          };
          const api: PvSceneApi<unknown> = { lines, position, active, scene, beat,
            line: index => usable(index) ? line(doc, index, lines[index].text) : undefined,
            layout: index => usable(index) ? layoutOf(line(doc, index, lines[index].text)) : undefined,
            sung: (index, glyph) => {
              const prepared = usable(index) ? line(doc, index, lines[index].text) : undefined;
              const word = prepared?.words[prepared.wordOf[glyph]];
              return word ? clamp01((position - word.start) / Math.max(1, word.end - word.start)) : -1;
            } };
          g.save(); style.scene!(g, api, env); g.restore();
        }
        for (const entry of listMode ? [] : entries) {
          const cached = { layout: layoutOf(entry.line) };
          const words = entry.absolute, wordOf = entry.line.wordOf;
          // 动效速度 scales the line's visual clock; word starts are scaled alike so a
          // word still appears exactly when it is sung.
          const rate = speed();
          const sample: PvFrame = {
            t: motion ? (entry.position - entry.start) * rate : 1e7,
            exit: motion ? entry.exit : entry.exit > 0 ? 1 : 0,
            beat, scene,
            sung: glyph => {
              const word = words[wordOf[glyph]];
              return word ? clamp01((position - word.start) / Math.max(1, word.end - word.start)) : -1;
            },
            wordAt: glyph => {
              const word = words[wordOf[glyph]];
              return word ? (word.start - entry.start) * rate : undefined;
            },
          };
          g.save(); style.draw(g, cached.layout, sample, env); g.restore();
        }
        if (style.overlay) { g.save(); style.overlay(g, { scene, beat, current: current?.line, motion }, env); g.restore(); }
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        feather(g, width, height, bx, by);
        if (settings.backgroundOpacity > 0) {
          g.globalCompositeOperation = 'destination-over';
          g.fillStyle = `rgba(12, 12, 16, ${settings.backgroundOpacity})`;
          g.beginPath(); g.roundRect?.(0, 0, width, height, 16); g.fill();
          g.globalCompositeOperation = 'source-over';
        }
        if (layouts.size > (listMode ? 40 : 8) || layoutBytes > 32 * 1024 * 1024) for (const [key, value] of [...layouts].sort((a, b) => a[1].used - b[1].used)) {
          if (value.used === tick) continue;
          if (layouts.size > (listMode ? 40 : 8) || layoutBytes > 32 * 1024 * 1024) {
            releaseSprites(value.sprites); layouts.delete(key); layoutBytes -= value.bytes;
          }
        }
        if (prepared.size > 400) prepared.clear();
      }
      raf = requestAnimationFrame(frame);
    };
    frame();
    return () => {
      if (disposed) return;
      disposed = true; cancelAnimationFrame(raf); clearLayouts(); prepared.clear();
      canvas.width = 0; canvas.height = 0;
      canvas.remove(); text.remove();
      root.classList.remove('pv-stage'); root.style.removeProperty('height');
      for (const key of ['pvStyle', 'pvLine', 'pvLines', 'pvMode', 'pvBeat'] as const) delete root.dataset[key];
    };
  } };
}
