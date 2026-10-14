import type { AppState, PluginManagement, GlobalShortcuts } from '../sdk/types';

export type MaybeAsync = void | Promise<void>;

/** The control UI talks to the app only through this public state and command surface. */
export interface UiContext {
  pluginManagement: PluginManagement;
  globalShortcuts: GlobalShortcuts;
  appVersion: string;
  getState(): AppState;
  getPosition?(): number;
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

export type PageId = 'lyrics' | 'style' | 'overlay' | 'plugins' | 'about';
export type ToastKind = 'info' | 'success' | 'error';

/** Shell facilities shared by every page. */
export interface UiServices {
  ctx: UiContext;
  notify(text: string, kind?: ToastKind): void;
  /** Runs a command and reports failures as toasts. Resolves true on success. */
  perform(action: () => MaybeAsync, success?: string): Promise<boolean>;
  navigate(id: PageId): void;
  confirm(options: { title: string; body: string; accept: string; danger?: boolean }): Promise<boolean>;
}

export interface PageInstance {
  render(state: AppState): void;
  /** Called when the page becomes visible; heavy work (renderer mounts) belongs here. */
  activate?(): void;
  deactivate?(): void;
  /** Named actions the shell can trigger from shortcuts, e.g. `import`. */
  commands?: Record<string, () => void>;
  dispose(): void;
}

export interface PageDefinition {
  id: PageId;
  title: string;
  subtitle: string;
  icon: string;
  mount(root: HTMLElement, services: UiServices): PageInstance;
}
