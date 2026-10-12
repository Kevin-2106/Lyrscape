import { PluginHost, type Plugin } from './kernel/host';
import { Store } from './kernel/store';
import type { AppState, PlaybackSnapshot, Renderer, Timeline } from './sdk/types';
import { normalizeSettings, themePlugin } from './plugins/theme';
import { timelinePlugin } from './plugins/timeline';
import { rendererPlugin } from './plugins/renderer';
import { demoLyrics, demoPlugin } from './plugins/demo';
import { amllPlugin, type AmllAdapter } from './plugins/amll';
import { overlaySurfacePlugin, type OverlaySurface } from './plugins/surface';
import { parseLyrics } from './plugins/parsers';
import { mountSettings, type SettingsUiContext } from './ui/settings';
import { desktop, onEvent, sendEvent } from './platform';
import './ui/app.css';

const root = document.querySelector<HTMLElement>('#app')!;
const isOverlay = new URLSearchParams(location.search).get('surface') === 'overlay';
let persisted: unknown;
try { persisted = JSON.parse(localStorage.getItem('lyrscape.settings.v1') ?? 'null'); } catch { /* defaults recover malformed storage */ }
const initial: AppState = {
  settings: normalizeSettings(persisted), track: { title: '自己的风景', artists: ['Lyrscape 演示'], durationMs: 32000 },
  lyrics: demoLyrics, playback: { positionMs: 1600, playing: false, rate: 1, observedAtMonoMs: performance.now() },
  connection: { status: 'stopped', clients: 0, port: 11444 }, adapterId: 'demo',
  overlay: { visible: false, clickthrough: false, alwaysOnTop: true }, isDesktop: desktop,
};
const store = new Store(initial), host = new PluginHost();

async function boot() {
  if (isOverlay) {
    await host.start([themePlugin, timelinePlugin, rendererPlugin, overlaySurfacePlugin(root, store, true)]);
    window.addEventListener('beforeunload', () => host.stop());
    return;
  }

  const parserPlugin: Plugin = { id: 'official.parser.baseline', activate: ctx => ctx.provide('parser@1', { parse: parseLyrics }) };
  let demoSnapshot: PlaybackSnapshot = { track: initial.track, lyrics: initial.lyrics, playback: initial.playback };
  const timeline = () => host.service<Timeline>('timeline@1');
  const guarded = (task: () => void | Promise<void>): Promise<void> =>
    Promise.resolve().then(task).catch(e => {
      store.update(s => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      throw e;
    });
  const api: SettingsUiContext = {
    getState: () => store.get(), subscribe: fn => store.subscribe(fn),
    getPosition: () => timeline().position(store.get()),
    updateSettings: patch => store.update(s => {
      const settings = normalizeSettings({ ...s.settings, ...patch });
      try { localStorage.setItem('lyrscape.settings.v1', JSON.stringify(settings)); } catch { /* preview remains usable if storage unavailable */ }
      return { ...s, settings };
    }),
    selectAdapter: id => {
      const current = store.get();
      if (current.adapterId === id) return;
      if (current.adapterId === 'demo') demoSnapshot = {
        track: current.track, lyrics: current.lyrics,
        playback: { ...current.playback, positionMs: timeline().position(current), playing: false, observedAtMonoMs: performance.now() },
      };
      const snapshot = id === 'demo' ? { ...demoSnapshot, playback: { ...demoSnapshot.playback, observedAtMonoMs: performance.now() } } : host.service<AmllAdapter>('adapter.amll@1').snapshot();
      store.update(s => ({ ...s, ...snapshot, adapterId: id, error: undefined }));
    },
    setPlaying: playing => {
      if (store.get().adapterId !== 'demo') return;
      store.update(s => ({ ...s, playback: { ...s.playback, positionMs: timeline().position(s), playing, observedAtMonoMs: performance.now() } }));
    },
    seek: positionMs => {
      if (store.get().adapterId !== 'demo') return;
      store.update(s => ({ ...s, playback: { ...s.playback, positionMs: Math.max(0, Math.min(positionMs, s.track.durationMs ?? positionMs)), observedAtMonoMs: performance.now() } }));
    },
    importLyrics: (text, name) => guarded(() => {
      const document = host.service<{ parse: typeof parseLyrics }>('parser@1').parse(text, name);
      const end = document.lines.reduce((n, l) => Math.max(n, l.endMs ?? l.startMs ?? 0), 0);
      store.update(s => ({ ...s, adapterId: 'demo', lyrics: document, error: undefined, track: { title: name ?? '自定义歌词', artists: ['本地导入'], durationMs: Math.max(32000, end + 3000) }, playback: { ...initial.playback, positionMs: 0, observedAtMonoMs: performance.now() } }));
      const current = store.get(); demoSnapshot = { track: current.track, lyrics: current.lyrics, playback: current.playback };
    }),
    startAmll: port => guarded(async () => { api.selectAdapter('amll'); await host.service<AmllAdapter>('adapter.amll@1').start(port); }),
    stopAmll: () => guarded(() => host.service<AmllAdapter>('adapter.amll@1').stop()),
    overlay: (action, value) => guarded(async () => {
      const previous = store.get().overlay;
      const next = { ...previous };
      if (action === 'show') next.visible = true;
      if (action === 'hide') next.visible = false;
      if (action === 'clickthrough') next.clickthrough = value ?? !previous.clickthrough;
      if (action === 'alwaysOnTop') next.alwaysOnTop = value ?? !previous.alwaysOnTop;
      await host.service<OverlaySurface>('surface.overlay@1').update(next);
      store.update(s => ({ ...s, overlay: next }));
    }),
  };
  const settingsPlugin: Plugin = {
    id: 'official.ui.settings', requires: ['renderer@1', 'timeline@1', 'parser@1', 'adapter.amll@1', 'surface.overlay@1'],
    activate(ctx) {
      ctx.own(mountSettings(root, api));
      const preview = root.querySelector<HTMLElement>('#lyrics-preview')!;
      ctx.own(ctx.service<Renderer>('renderer@1').mount(preview, () => store.get(), ctx.service<Timeline>('timeline@1')));
    },
  };
  await host.start([settingsPlugin, themePlugin, timelinePlugin, rendererPlugin, parserPlugin, demoPlugin, amllPlugin(store), overlaySurfacePlugin(root, store, false)]);
  const publish = () => {
    const state = store.get();
    void sendEvent('lyrscape-state', { state, sampleAgeMs: Math.max(0, performance.now() - state.playback.observedAtMonoMs), sentAtEpochMs: Date.now() }).catch(console.error);
  };
  const unsubscribe = store.subscribe(publish);
  const unrequest = await onEvent('lyrscape-state-request', publish);
  // Occasional fresh anchors prevent cross-realm drift; rendering remains local to each surface.
  const refresh = window.setInterval(() => {
    const state = store.get();
    if (state.adapterId === 'demo' && state.playback.playing && timeline().position(state) >= (state.track.durationMs ?? Infinity)) api.seek(0);
    publish();
  }, 1000);
  window.addEventListener('beforeunload', () => { clearInterval(refresh); unsubscribe(); unrequest(); host.stop(); });
}

void boot().catch(error => {
  console.error(error); root.replaceChildren();
  const message = document.createElement('pre'); message.textContent = `Lyrscape 启动失败\n${String(error)}`;
  const reset = document.createElement('button'); reset.textContent = '恢复默认设置并重启';
  reset.onclick = () => { localStorage.removeItem('lyrscape.settings.v1'); location.reload(); };
  root.append(message, reset);
});
