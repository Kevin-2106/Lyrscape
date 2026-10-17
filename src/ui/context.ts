import type { AppState, BeatDetector, LyricDocument, PcmFrame, PluginManagement, GlobalShortcuts } from '../sdk/types';
import type { DebugJournal } from '../plugins/debug';
import type { ConfirmOptions } from './kit/dialog';

export type MaybeAsync = void | Promise<void>;

/** The control UI talks to the app only through this public state and command surface. */
export interface UiContext {
  pluginManagement: PluginManagement;
  globalShortcuts: GlobalShortcuts;
  appVersion: string;
  getState(): AppState;
  getPosition?(): number;
  /** Read-only views for the 调试 page (available in release builds too). */
  debug?: {
    journal: DebugJournal;
    beat(): BeatDetector | undefined;
    /** The latest PCM frame (if one arrived within a second). */
    pcm(): PcmFrame | undefined;
    /** Parses lyric text without importing it. Throws like an import would. */
    parse(text: string, name?: string): LyricDocument;
  };
  subscribe(listener: (state: AppState) => void): () => void;
  /** Mounts the active renderer into `root`; the returned function releases it. */
  mountPreview(root: HTMLElement): () => void;
  updateSettings(settings: Partial<AppState['settings']>): MaybeAsync;
  resetSettings(): MaybeAsync;
  selectAdapter(id: 'demo' | 'amll'): MaybeAsync;
  setPlaying(playing: boolean): MaybeAsync;
  seek(positionMs: number): MaybeAsync;
  importLyrics(text: string, name?: string): MaybeAsync;
  overlay(action: 'show' | 'hide' | 'clickthrough' | 'alwaysOnTop' | 'borderVisible', value?: boolean): MaybeAsync;
  startAmll(port: number): MaybeAsync;
  stopAmll(): MaybeAsync;
  resetEverything(): void;
}

export type PageId = 'lyrics' | 'renderers' | 'effects' | 'plugins' | 'settings' | 'debug';
export type ToastKind = 'info' | 'success' | 'error';

/** Shell facilities shared by every page. */
export interface UiServices {
  ctx: UiContext;
  notify(text: string, kind?: ToastKind): void;
  /** Runs a command and reports failures as toasts. Resolves true on success. */
  perform(action: () => MaybeAsync, success?: string): Promise<boolean>;
  /** Opens a page; `target` lets the page reveal a part of itself (an inspector tab, a plugin). */
  navigate(id: PageId, target?: string): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
}

export interface PageInstance {
  render(state: AppState): void;
  /** Called when the page becomes visible; heavy work (renderer mounts) belongs here. */
  activate?(): void;
  deactivate?(): void;
  /** Named actions the shell can trigger from shortcuts, e.g. `import`. */
  commands?: Record<string, () => void>;
  /** Shows a part of the page named by `navigate(id, target)`. */
  reveal?(target: string): void;
  dispose(): void;
}

export interface PageDefinition {
  id: PageId;
  /** First-level menu the page sits under; pages with the same group are listed together. */
  group: string;
  title: string;
  subtitle: string;
  icon: string;
  mount(root: HTMLElement, services: UiServices): PageInstance;
}
