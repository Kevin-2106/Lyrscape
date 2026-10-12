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
  track: { title: string; artists: string[]; durationMs?: number };
  playback: { positionMs: number; playing: boolean; observedAtMonoMs: number; rate: number };
  lyrics: LyricDocument;
  connection: { status: 'stopped' | 'listening' | 'connected' | 'error'; clients: number; error?: string; port: number };
  adapterId: 'demo' | 'amll';
  overlay: { visible: boolean; clickthrough: boolean; alwaysOnTop: boolean };
  isDesktop: boolean;
  error?: string;
}
export interface Timeline { position(state: AppState, nowMonoMs?: number): number }
export interface Renderer { mount(root: HTMLElement, state: () => AppState, timeline: Timeline): () => void }
export type PlaybackSnapshot = Pick<AppState, 'track' | 'playback' | 'lyrics'>;
