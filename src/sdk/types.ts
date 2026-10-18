export interface LyricWord { text: string; startMs: number; endMs: number }
export interface LyricLine {
  id: string; text: string; startMs?: number; endMs?: number;
  words?: LyricWord[]; translation?: string; romanization?: string; isBackground?: boolean;
}
export interface LyricDocument {
  timingMode: 'none' | 'line' | 'word'; lines: LyricLine[]; source?: string;
}
export interface Settings {
  color: string; inactiveColor: string;
  gradientEnabled: boolean; gradientStart: string; gradientEnd: string; gradientAngle: number;
  fontFamily: string; fontSize: number; fontWeight: number;
  textAlign: 'left' | 'center' | 'right'; lineHeight: number; shadow: number;
  backgroundOpacity: number; showTranslation: boolean; showNextLine: boolean;
}
export interface AppState {
  settings: Settings;
  plugins: PluginPreferences;
  track: { title: string; artists: string[]; durationMs?: number };
  playback: { positionMs: number; playing: boolean; observedAtMonoMs: number; rate: number };
  lyrics: LyricDocument;
  connection: { status: 'stopped' | 'listening' | 'connected' | 'error'; clients: number; error?: string; port: number };
  adapterId: AdapterId;
  /** What the SMTC adapter reads and which online lyrics it found; set while it is the source. */
  media?: MediaSessionInfo;
  overlay: { visible: boolean; clickthrough: boolean; alwaysOnTop: boolean; borderVisible?: boolean };
  shortcuts?: GlobalShortcutBinding[];
  isDesktop: boolean;
  error?: string;
}
export type AdapterId = 'demo' | 'amll' | 'smtc';
/** A lyric search hit; `key` is `<provider>:<id>`. */
export interface OnlineLyricCandidate {
  key: string; provider: 'lrclib' | 'netease';
  title: string; artists: string[]; album?: string; durationMs?: number;
  /** Known to have time-synced lyrics (LRCLIB tells up front; NetEase after fetching). */
  synced?: boolean;
  /** 0..1 match against the playing track. */
  score: number;
}
export interface MediaSessionInfo {
  available: boolean;
  /** AppUserModelId of the session being read, e.g. `Spotify.exe`. */
  source: string;
  sessions: string[];
  /** Session chosen in the UI; undefined follows Windows' current session. */
  selected?: string;
  status: string;
  error?: string;
  lookup: {
    state: 'idle' | 'searching' | 'found' | 'none' | 'error';
    message?: string;
    /** The candidate whose lyrics are shown. */
    result?: OnlineLyricCandidate;
    candidates: OnlineLyricCandidate[];
    cached?: boolean;
  };
}
export interface Timeline { position(state: AppState, nowMonoMs?: number): number }
export interface Renderer { mount(root: HTMLElement, state: () => AppState, timeline: Timeline): () => void }
export type PlaybackSnapshot = Pick<AppState, 'track' | 'playback' | 'lyrics'>;

export type PluginCategory = 'playback-adapter' | 'audio-provider' | 'lyric-parser' | 'timeline-provider' | 'renderer' | 'theme' | 'effect' | 'surface' | 'settings';
export type ConfigValue = string | number | boolean;
export interface ConfigField {
  key: string; label: string; description?: string;
  /** `color` values are #rrggbb. */
  type: 'number' | 'select' | 'boolean' | 'color'; default: ConfigValue;
  min?: number; max?: number; step?: number; options?: { value: string; label: string }[];
  /** Inspector tab the option appears on (e.g. 构图 / 动效 / 颜色 / 字体); ungrouped options share one tab. */
  group?: string;
}
/**
 * Shared text settings a renderer follows besides the always-shown 字号 / 背景 / 译文:
 * `font` (font family, weight, line height, alignment), `color` (colours, gradient,
 * shadow) and `nextLine`. Omitted means all of them (the original contract).
 */
export type ThemeUse = 'font' | 'color' | 'nextLine';
export interface PluginPreferences {
  rendererId: string;
  enabled: Record<string, boolean>;
  configs: Record<string, Record<string, ConfigValue>>;
}
/** Optional authorship metadata shown in the plugin manager. */
export interface PluginCredits { author?: string; homepage?: string; license?: string; tags?: string[] }
export interface PluginInfo extends PluginCredits {
  id: string; name: string; description: string; version: string; category: PluginCategory;
  essential?: boolean; rendererService?: string; fields?: ConfigField[]; surfaces?: ('control' | 'overlay')[];
  theme?: ThemeUse[];
}
/**
 * Display and configuration metadata a plugin module carries with its code
 * (named export `manifest`). Required for plugins added by a catalog rescan;
 * optional when hot-reloading an already registered plugin.
 */
export interface PluginManifest extends PluginCredits {
  id: string; name: string; description: string; category: PluginCategory; version?: string;
  rendererService?: string; fields?: ConfigField[];
  /** Shared text settings the renderer uses (renderers only); omitted means all. */
  theme?: ThemeUse[];
  /** Windows that run the plugin; defaults to both for renderers and effects, otherwise the control window. */
  surfaces?: ('control' | 'overlay')[];
}
/** Where the running definition of a plugin came from. */
export type PluginOrigin = 'builtin' | 'source' | 'local';
export interface PluginStatus extends PluginInfo {
  active: boolean; busy: boolean; error?: string; requires: string[]; provides: string[];
  reloadable?: boolean; reloadSource?: 'source' | 'local'; reloadRevision?: number; origin: PluginOrigin;
  /** Code can be written out as a `.lyrx` package (installed plugins; every catalog plugin in development). */
  exportable?: boolean;
  /** Installed from a package or the plugins folder, so it can be uninstalled. */
  removable?: boolean;
}
/**
 * `.lyrx` plugin package: one UTF-8 JSON file carrying the manifest, the ES module
 * and its stylesheet. See docs/plugin-authoring.md.
 */
export interface PluginPackage {
  format: 'lyrscape.plugin'; formatVersion: 1;
  manifest: PluginManifest;
  javascript: string; css?: string;
  /** Configuration applied on install when this device has none stored for the plugin. */
  config?: Record<string, ConfigValue>;
  /** `sha256-<base64>` of UTF-8 javascript, a NUL byte, UTF-8 css. Checked when present. */
  integrity?: string;
  exportedAt?: string;
}
export interface InstallResult { id: string; action: 'installed' | 'updated' }
/** Result of rescanning the plugin catalog. */
export interface CatalogReport {
  added: string[]; updated: string[]; removed: string[];
  /** IDs present in the catalog that already run and only change through 热重载. */
  unchanged: string[];
  failed: { id: string; error: string }[];
}
/** Management of trusted plugin code: built-ins, the development source catalog and exe-side local files. Not a package installer. */
export interface PluginManagement {
  list(): PluginStatus[];
  subscribe(listener: () => void): () => void;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  selectRenderer(id: string): void;
  configure(id: string, patch: Record<string, ConfigValue>): void;
  resetConfig(id: string): void;
  reload(id: string, source?: 'source' | 'local'): Promise<void>;
  /** Re-reads the plugin catalog (development source or exe-side plugins folder) and applies additions, removals and metadata. */
  rescan(source?: 'source' | 'local'): Promise<CatalogReport>;
  /** Whether rescanning is available from `source` in this window. */
  canRescan(source: 'source' | 'local'): boolean;
  /** Writes a validated package to the plugin store and registers (or hot-reloads) it in both windows. */
  install(pkg: PluginPackage): Promise<InstallResult>;
  /** Stops an installed plugin in both windows and deletes its files. */
  uninstall(id: string): Promise<void>;
  /** The plugin's current code and configuration as a package. */
  exportPackage(id: string): Promise<PluginPackage>;
  canInstall(): boolean;
}

export type ShortcutAction = 'visibility' | 'clickthrough' | 'border';
export interface GlobalShortcutBinding { action: ShortcutAction; accelerator: string; registered: boolean; error?: string | null }
export interface GlobalShortcuts { set(action: ShortcutAction, accelerator: string): Promise<void>; list(): GlobalShortcutBinding[] }

/** The bytes supplied by the connector, without downmix, resampling, gain or FFT. */
export interface PcmFrame {
  sourceId: string; revision: number; sequence: number;
  receivedAtMonoMs: number; receivedAtEpochMs: number; droppedFrames: number;
  format: { sampleRate: 48000; channels: 2; sampleFormat: 'i16le'; interleaved: true; basis: 'amll-v1-spec' | 'amll-player-compat' };
  frameCount: number;
  /** Treat as immutable. Copy before processing in place. */
  data: Uint8Array;
}
export interface PcmAudio {
  /** Read the latest block; a stale block is not current sound. No stream history is retained. */
  read(maxAgeMs?: number): PcmFrame | undefined;
  subscribe(listener: (frame: PcmFrame | undefined) => void): () => void;
  /** Main window only. undefined detaches the current source. */
  selectSource(sourceId?: string): Promise<void>;
}

/** Beat state derived from PCM at a monotonic time. Everything is 0 without live audio. */
export interface BeatSample {
  /** Live audio is flowing and a tempo has been estimated. */
  active: boolean;
  bpm: number;
  /** 0..1 how periodic the recent onsets are; effects should scale by it. */
  confidence: number;
  /** 0 on the beat, rising to 1 just before the next one. */
  phase: number;
  /** Increments once per predicted beat; seeds per-beat variation. */
  index: number;
  /** 1 on the beat, decaying over ~150 ms, already scaled by confidence and loudness. */
  pulse: number;
  /** Smoothed loudness 0..1 (RMS against a slow running peak). */
  level: number;
}
/** Live spectrum features for visualisers; undefined without live audio. */
export interface AudioAnalysis {
  /** 12 pitch-class strengths (C, C#, … B), 0..1 relative to the strongest. */
  chroma: number[];
  /** 24 log-spaced band levels (≈60 Hz – 5.5 kHz), 0..1 against a slow running peak. */
  bands: number[];
  /** 128 recent mono samples, -1..1, oldest first (~85 ms). */
  wave: number[];
}
export interface BeatDetector {
  sample(atMonoMs?: number): BeatSample;
  /** Optional: detectors loaded from older plugin files may not provide it. */
  analysis?(atMonoMs?: number): AudioAnalysis | undefined;
}
