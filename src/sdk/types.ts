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
  adapterId: 'demo' | 'amll';
  overlay: { visible: boolean; clickthrough: boolean; alwaysOnTop: boolean; borderVisible?: boolean };
  shortcuts?: GlobalShortcutBinding[];
  isDesktop: boolean;
  error?: string;
}
export interface Timeline { position(state: AppState, nowMonoMs?: number): number }
export interface Renderer { mount(root: HTMLElement, state: () => AppState, timeline: Timeline): () => void }
export type PlaybackSnapshot = Pick<AppState, 'track' | 'playback' | 'lyrics'>;

export type PluginCategory = 'playback-adapter' | 'audio-provider' | 'lyric-parser' | 'timeline-provider' | 'renderer' | 'theme' | 'effect' | 'surface' | 'settings';
export type ConfigValue = string | number | boolean;
export interface ConfigField {
  key: string; label: string; description?: string;
  type: 'number' | 'select' | 'boolean'; default: ConfigValue;
  min?: number; max?: number; step?: number; options?: { value: string; label: string }[];
}
export interface PluginPreferences {
  rendererId: string;
  enabled: Record<string, boolean>;
  configs: Record<string, Record<string, ConfigValue>>;
}
export interface PluginInfo {
  id: string; name: string; description: string; version: string; category: PluginCategory;
  essential?: boolean; rendererService?: string; fields?: ConfigField[];
}
/**
 * Display and configuration metadata a plugin module carries with its code
 * (named export `manifest`). Required for plugins added by a catalog rescan;
 * optional when hot-reloading an already registered plugin.
 */
export interface PluginManifest {
  id: string; name: string; description: string; category: PluginCategory; version?: string;
  rendererService?: string; fields?: ConfigField[];
  /** Windows that run the plugin; defaults to both for renderers and effects, otherwise the control window. */
  surfaces?: ('control' | 'overlay')[];
}
/** Where the running definition of a plugin came from. */
export type PluginOrigin = 'builtin' | 'source' | 'local';
export interface PluginStatus extends PluginInfo {
  active: boolean; busy: boolean; error?: string; requires: string[]; provides: string[];
  reloadable?: boolean; reloadSource?: 'source' | 'local'; reloadRevision?: number; origin: PluginOrigin;
}
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
