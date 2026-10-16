import { PluginHost, type Plugin } from './kernel/host';
import { Store } from './kernel/store';
import type { AppState, PlaybackSnapshot, PluginManagement, Renderer, Timeline, GlobalShortcuts } from './sdk/types';
import { pcmAudioPlugin } from './plugins/audio';
import { globalShortcutsPlugin } from './plugins/shortcuts';
import { manualReloadPlugin, type ManualReload } from './plugins/reload';
import { normalizeSettings, themePlugin } from './plugins/theme';
import { timelinePlugin } from './plugins/timeline';
import { rendererPlugin } from './plugins/renderer';
import { demoLyrics, demoPlugin } from './plugins/demo';
import type { AmllAdapter } from './plugins/amll';
import { overlaySurfacePlugin, type OverlaySurface } from './plugins/surface';
import { parseLyrics } from './plugins/parsers';
import { mountApp } from './ui/shell';
import type { UiContext } from './ui/context';
import pkg from '../package.json';
import { desktop, onEvent, sendOverlayEvent } from './platform';
import { catalog } from './plugins/catalog';
import { AMLL_ADAPTER, createPluginManagement, normalizePreferences, rendererSelectionPlugin, type PluginReloader } from './plugins/management';
import { sdkPlugin } from './plugins/sdk';
import { infoOf, PluginRegistry, surfacesOf, type RegistryEntry } from './plugins/registry';
import './ui/app.css';

const root = document.querySelector<HTMLElement>('#app')!;
const isOverlay = new URLSearchParams(location.search).get('surface') === 'overlay';
let persisted: unknown;
try { persisted = JSON.parse(localStorage.getItem('lyrscape.settings.v1') ?? 'null'); } catch { /* defaults recover malformed storage */ }
let persistedPlugins: unknown;
try { persistedPlugins = JSON.parse(localStorage.getItem('lyrscape.plugins.v1') ?? 'null'); } catch { /* independent recovery */ }
const initial: AppState = {
  plugins: normalizePreferences(persistedPlugins),
  settings: normalizeSettings(persisted), track: { title: '自己的风景', artists: ['Lyrscape 演示'], durationMs: 32000 },
  lyrics: demoLyrics, playback: { positionMs: 1600, playing: false, rate: 1, observedAtMonoMs: performance.now() },
  connection: { status: 'stopped', clients: 0, port: 11444 }, adapterId: 'demo',
  overlay: { visible: false, clickthrough: false, alwaysOnTop: true, borderVisible: false }, isDesktop: desktop,
};
const store = new Store(initial), host = new PluginHost(), registry = new PluginRegistry();
/** Built-in catalog plugins for this window, created against its own store. */
const builtin = (surface: 'control' | 'overlay') => catalog.filter(item => surfacesOf(item.manifest).includes(surface))
  .map((item): RegistryEntry => ({ info: infoOf(item.manifest), plugin: item.create(store), origin: 'builtin' }));

async function boot() {
  if (isOverlay) {
    const plugins = builtin('overlay');
    for (const entry of plugins) registry.set(entry);
    await host.start([pcmAudioPlugin, sdkPlugin, manualReloadPlugin(host, store, true, registry), themePlugin, timelinePlugin, rendererPlugin, ...plugins.map(entry => entry.plugin), rendererSelectionPlugin(host, registry), overlaySurfacePlugin(root, store, true)]);
    await host.service<ManualReload>('plugins.reload@1').ready();
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
  let management: PluginManagement;
  const api: UiContext = {
    get pluginManagement() { return management; },
    get globalShortcuts() { return host.service<GlobalShortcuts>('shortcuts.global@1'); },
    appVersion: pkg.version,
    mountPreview: el => host.service<Renderer>('renderer@1').mount(el, () => store.get(), host.service<Timeline>('timeline@1')),
    getState: () => store.get(), subscribe: fn => store.subscribe(fn),
    getPosition: () => timeline().position(store.get()),
    updateSettings: patch => store.update(s => {
      const settings = normalizeSettings({ ...s.settings, ...patch });
      try { localStorage.setItem('lyrscape.settings.v1', JSON.stringify(settings)); } catch { /* preview remains usable if storage unavailable */ }
      return { ...s, settings };
    }),
    resetSettings: () => api.updateSettings(normalizeSettings(undefined)),
    resetEverything: () => {
      try { localStorage.removeItem('lyrscape.settings.v1'); localStorage.removeItem('lyrscape.plugins.v1'); localStorage.removeItem('lyrscape.shortcuts.v1'); } catch { /* reload still applies defaults */ }
      location.reload();
    },
    selectAdapter: id => {
      if (id === 'amll' && !host.hasService('adapter.amll@1')) throw new Error('请先在插件管理中启用 AMLL 连接。');
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
      const next: Partial<AppState['overlay']> = {};
      if (action === 'show') next.visible = true;
      if (action === 'hide') next.visible = false;
      if (action === 'clickthrough') next.clickthrough = value ?? !previous.clickthrough;
      if (action === 'alwaysOnTop') next.alwaysOnTop = value ?? !previous.alwaysOnTop;
      if (action === 'borderVisible') next.borderVisible = value ?? !previous.borderVisible;
      await host.service<OverlaySurface>('surface.overlay@1').update(next);
    }),
  };
  const settingsPlugin: Plugin = {
    id: 'official.ui.settings', requires: ['renderer@1', 'timeline@1', 'parser@1', 'surface.overlay@1', 'plugins.management@1', 'shortcuts.global@1'],
    activate(ctx) { ctx.own(mountApp(root, api)); },
  };
  const managementPlugin: Plugin = { id: 'official.ui.plugin-management', activate(ctx) { ctx.provide('plugins.management@1', management); } };
  const entry = (plugin: Plugin, info: Omit<RegistryEntry['info'], 'id' | 'version'>): RegistryEntry => ({ plugin, info: { ...info, id: plugin.id, version: '0.1.0' }, origin: 'builtin' });
  const optional = new Map(builtin('control').map(item => [item.info.id, item]));
  /** Places a catalog plugin; ones the list below does not mention are appended after the renderers. */
  const take = (id: string) => { const item = optional.get(id); optional.delete(id); return item ? [item] : []; };
  const entries: RegistryEntry[] = [
    entry(manualReloadPlugin(host, store, false, registry), { name: '手动插件热重载', description: '手动应用已注册的可信源码或本地插件，失败恢复上一版并同步桌面视图。', category: 'settings', essential: true }),
    entry(pcmAudioPlugin, { name: '原始 PCM 音频', description: '独立音频流，保留来源 PCM 字节与格式，供效果插件自行分析。', category: 'audio-provider', essential: true }),
    ...take('official.audio.beat'),
    entry(globalShortcutsPlugin(store), { name: '全局快捷键', description: '显示桌面歌词、切换穿透和调整边框；注册冲突警告。', category: 'settings', essential: true }),
    entry(demoPlugin, { name: '本地演示', description: '原创演示与本地歌词播放，不需要外部播放器。', category: 'playback-adapter', essential: true }),
    ...take(AMLL_ADAPTER),
    entry(parserPlugin, { name: '基础歌词解析', description: 'LRC、增强 LRC、常用 TTML 与纯文本。', category: 'lyric-parser', essential: true }),
    entry(sdkPlugin, { name: '插件 SDK', description: '向动态加载的插件提供 DOM 渲染器构造、时间轴工具与 API 版本（sdk@1）。', category: 'settings', essential: true }),
    entry(timelinePlugin, { name: '共享时间轴', description: '采样插值、暂停与过期保护，所有视图共享时间基准。', category: 'timeline-provider', essential: true }),
    entry(rendererPlugin, { name: '普通文字', description: '干净的逐行、逐字与静态歌词；默认视觉基线。', category: 'renderer', rendererService: 'renderer.text@1', essential: true }),
    ...[...optional.values()],
    entry(themePlugin, { name: '基础文字主题', description: '字体、颜色、渐变、译文与下一行，共用于 DOM 渲染器。', category: 'theme', essential: true }),
    entry(overlaySurfacePlugin(root, store, false), { name: '透明桌面歌词', description: '置顶、拖动、鼠标穿透与内容高度自适应。', category: 'surface', essential: true }),
    entry(rendererSelectionPlugin(host, registry), { name: '渲染器选择', description: '为预览和桌面视图切换渲染器，并释放旧视图资源。', category: 'settings', essential: true }),
    entry(managementPlugin, { name: '插件管理', description: '分类、状态、依赖、启停与独立配置。', category: 'settings', essential: true }),
    entry(settingsPlugin, { name: '控制面板', description: '桌面应用外壳：歌词预览、播放来源、导入、样式、桌面歌词与插件管理。', category: 'settings', essential: true }),
  ];
  for (const item of entries) registry.set(item);
  management = createPluginManagement(host, store, registry, preferences => {
    try { localStorage.setItem('lyrscape.plugins.v1', JSON.stringify(preferences)); } catch { /* session remains usable */ }
  }, async id => {
    if (id === AMLL_ADAPTER) {
      if (store.get().adapterId === 'amll') api.selectAdapter('demo');
      await host.service<AmllAdapter>('adapter.amll@1').stop();
    }
  }, (() => {
    const reloader = () => host.service<ManualReload>('plugins.reload@1');
    return {
      supports: id => reloader().supports(id),
      reload: (id, source, previous) => reloader().reload(id, source, previous),
      canRescan: source => host.hasService('plugins.reload@1') && reloader().canRescan!(source),
      catalog: source => reloader().catalog!(source),
      add: (id, source) => reloader().add!(id, source),
      remove: id => reloader().remove!(id),
      get files() { return host.hasService('plugins.reload@1') ? reloader().files : undefined; },
      exportBundle: (id, origin) => reloader().exportBundle!(id, origin),
      exportable: (id, origin) => host.hasService('plugins.reload@1') && reloader().exportable!(id, origin),
    } satisfies PluginReloader;
  })());
  await host.start(entries.filter(({ info }) => info.essential || initial.plugins.enabled[info.id] !== false).map(({ plugin }) => plugin));
  await host.service<ManualReload>('plugins.reload@1').ready();
  // Installed plugins load on every start, and get back the renderer selection they had.
  if (management.canRescan('local')) {
    const wanted = (persistedPlugins as { rendererId?: unknown } | null)?.rendererId;
    await management.rescan('local').then(report => {
      for (const failure of report.failed) console.warn(`插件 ${failure.id} 未能加载：${failure.error}`);
      if (typeof wanted === 'string' && report.added.includes(wanted) && store.get().plugins.enabled[wanted] !== false) management.selectRenderer(wanted);
    }).catch(error => console.warn('已安装插件未能加载', error));
    await host.service<ManualReload>('plugins.reload@1').broadcast().catch(console.error);
  }
  store.update(state => ({ ...state }));
  let published: AppState | undefined;
  const publish = (force = false) => {
    const state = store.get();
    const anchor = { sampleAgeMs: Math.max(0, performance.now() - state.playback.observedAtMonoMs), sentAtEpochMs: Date.now() };
    const full = force || !published || (Object.keys(state) as (keyof AppState)[]).some(key => key !== 'playback' && state[key] !== published![key]);
    if (full) void sendOverlayEvent('lyrscape-state', { state, ...anchor }).catch(console.error);
    else void sendOverlayEvent('lyrscape-playback', { playback: state.playback, ...anchor }).catch(console.error);
    published = state;
  };
  const unsubscribe = store.subscribe(() => publish());
  const unrequest = await onEvent('lyrscape-state-request', () => publish(true));
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
  reset.onclick = () => { localStorage.removeItem('lyrscape.settings.v1'); localStorage.removeItem('lyrscape.plugins.v1'); localStorage.removeItem('lyrscape.shortcuts.v1'); location.reload(); };
  root.append(message, reset);
});
