import type { Plugin, PluginHost } from '../kernel/host';
import type { Store } from '../kernel/store';
import type { AppState, PluginManifest } from '../sdk/types';
import { desktop, native, onEvent, sendEvent } from '../platform';
import type { LoadedPlugin, PluginReloader, PreparedAddition } from './management';
import type { AmllAdapter } from './amll';
import { infoOf, PLUGIN_ID, surfacesOf, validateManifest, type PluginRegistry } from './registry';
import { pluginStorage } from './storage';
import { prepareLegacyPluginFonts } from './font-assets';

/** `added` marks plugins a rescan registered; `removed` tells a late overlay to drop one. */
type Bundle = { id: string; javascript?: string; css?: string; builtin?: boolean; added?: boolean; removed?: boolean };
type Phase = 'prepare' | 'commit' | 'rollback' | 'finish' | 'remove';
type Request = { transaction: string; phase: Phase; bundle: Bundle };
type Reply = { key: string; error?: string };
export interface ManualReload extends PluginReloader {
  ready(): Promise<void>;
  /** Replays this app session's committed code after rebuilding the control WebView. */
  restore(): Promise<void>;
  /** Control window: pushes every loaded bundle to the overlay (after the boot scan, when both windows start together). */
  broadcast(): Promise<void>;
}

/** Imports a bundle (default export: Plugin or factory; optional named export `manifest`). */
export async function importPluginBundle(bundle: Bundle, store: Store<AppState>): Promise<LoadedPlugin> {
  if (!PLUGIN_ID.test(bundle.id) || typeof bundle.javascript !== 'string' || bundle.javascript.length > 2 * 1024 * 1024 || (bundle.css?.length ?? 0) > 512 * 1024) throw Error('重载文件不符合插件接口或大小限制');
  await prepareLegacyPluginFonts(bundle.javascript);
  const url = URL.createObjectURL(new Blob([bundle.javascript], { type: 'text/javascript' }));
  let value: unknown, manifest: PluginManifest | undefined;
  try {
    const module = await import(/* @vite-ignore */ url);
    if (module.manifest !== undefined) manifest = validateManifest(module.manifest, bundle.id);
    value = typeof module.default === 'function' ? await module.default(store) : module.default;
  } finally { URL.revokeObjectURL(url); }
  const plugin = value as Plugin;
  if (!plugin || plugin.id !== bundle.id || typeof plugin.activate !== 'function' || (plugin.requires && (!Array.isArray(plugin.requires) || plugin.requires.some(id => typeof id !== 'string')))) throw Error('插件必须导出相同 ID 的 Plugin，或返回 Plugin 的默认工厂');
  return { manifest, plugin: { ...plugin, async activate(ctx) {
    if (bundle.css) {
      const style = document.createElement('style'); style.dataset.pluginStyle = plugin.id; style.textContent = bundle.css;
      document.head.append(style); ctx.own(() => style.remove());
    }
    await plugin.activate(ctx);
  } } };
}

/** Development server endpoints; they exist only under `npm run dev`. */
async function devJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? '源码构建失败');
  return result as T;
}

export function manualReloadPlugin(host: PluginHost, store: Store<AppState>, overlay: boolean, registry: PluginRegistry): Plugin {
  return { id: 'official.plugins.manual-reload', async activate(ctx) {
    const builtins = new Map<string, Plugin>(), committed = new Map<string, Bundle>();
    let savedBundles: Bundle[] = [];
    const checkpoint = async () => { if (desktop && !overlay) await native('session_bundles', { bundles: [...committed.values()] }); };
    const stages = new Map<string, { previous?: Plugin; candidate: LoadedPlugin; changed: boolean }>();
    const waiting = new Map<string, (reply: Reply) => void>();
    let ready = false, active = true;
    const supports = (id: string) => { const entry = registry.get(id); return Boolean(entry && !entry.info.essential); };
    const load = async (bundle: Bundle): Promise<LoadedPlugin> => {
      if (!ready || !PLUGIN_ID.test(bundle.id)) throw Error('插件重载入口尚未就绪');
      if (bundle.builtin) {
        const plugin = builtins.get(bundle.id); if (!plugin) throw Error('该插件没有内置版本'); return { plugin };
      }
      return importPluginBundle(bundle, store);
    };
    const fetchBundle = async (id: string, source: 'source' | 'local'): Promise<Bundle> => {
      if (source === 'local') {
        if (!pluginStorage) throw Error('当前环境没有本地插件存储');
        return pluginStorage.read(id);
      }
      if (import.meta.env.DEV) return devJson<Bundle>(`/__lyrscape/plugin-source/${encodeURIComponent(id)}`);
      return { id, builtin: true };
    };
    /** Overlay-side registration of a plugin it did not boot with. */
    const register = async (loaded: LoadedPlugin, enabled = true) => {
      if (!loaded.manifest) throw Error('新增插件需要导出 manifest');
      if (enabled) await host.start([loaded.plugin]);
      registry.set({ info: infoOf(loaded.manifest), plugin: loaded.plugin, origin: 'source' });
    };
    const unregister = (id: string) => {
      if (host.definition(id)) host.deactivate(id);
      registry.remove(id);
    };
    const peer = async (phase: Phase, bundle: Bundle, transaction: string, optional = false) => {
      // A not-yet-created overlay has no resources to transact against. It will
      // replay the committed bundles via plugin-reload-sync-request on first show.
      if (desktop && !await native<boolean>('overlay_exists')) return false;
      const key = `${transaction}:${phase}`;
      return new Promise<boolean>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          waiting.delete(key);
          if (phase === 'prepare') void sendEvent('plugin-reload-request', { transaction, phase: 'rollback', bundle } satisfies Request).catch(console.error);
          if (optional) resolve(false); else reject(Error('桌面歌词窗口未确认重载，操作已取消；请重新打开窗口后重试'));
        }, optional ? 500 : 8000);
        waiting.set(key, reply => {
          clearTimeout(timeout); waiting.delete(key);
          if (reply.error) reject(Error(`桌面歌词重载失败：${reply.error}`)); else resolve(true);
        });
        void sendEvent('plugin-reload-request', { transaction, phase, bundle } satisfies Request).catch(error => { clearTimeout(timeout); waiting.delete(key); reject(error); });
      });
    };
    ctx.own(() => { active = false; for (const reply of waiting.values()) reply({ key: '', error: '插件宿主已关闭' }); waiting.clear(); });
    ctx.own(await onEvent<Reply>('plugin-reload-reply', reply => { if (!overlay && active) waiting.get(reply.key)?.(reply); }));
    if (overlay) {
      let queue = Promise.resolve();
      ctx.own(await onEvent<Request>('plugin-reload-request', request => {
        if (!active || !request || !PLUGIN_ID.test(request.bundle?.id ?? '')) return;
        const task = queue.then(async () => {
          try {
            const { transaction, phase, bundle } = request;
            if (phase === 'prepare') {
              if (stages.size) throw Error('已有插件重载尚未完成');
              const candidate = await load(bundle), previous = host.definition(bundle.id);
              // An addition the overlay already runs (e.g. kept across a control-window reload) replaces it.
              if (!previous && !bundle.added) throw Error('请先启用桌面歌词中的对应插件');
              stages.set(transaction, { candidate, previous, changed: false });
            } else if (phase === 'remove') {
              unregister(bundle.id);
            } else {
              const stage = stages.get(transaction);
              if (phase === 'commit') {
                if (!stage) throw Error('重载准备已失效');
                if (stage.previous) {
                  await host.replace(bundle.id, stage.candidate.plugin);
                  registry.update(bundle.id, { plugin: stage.candidate.plugin, ...stage.candidate.manifest ? { info: infoOf(stage.candidate.manifest) } : {} });
                } else await register(stage.candidate);
                stage.changed = true;
              } else if (phase === 'rollback') {
                if (stage?.changed) {
                  if (stage.previous) { await host.replace(bundle.id, stage.previous); registry.update(bundle.id, { plugin: stage.previous }); }
                  else unregister(bundle.id);
                }
                stages.delete(transaction);
              } else if (phase === 'finish') { stages.delete(transaction); committed.set(bundle.id, bundle); }
            }
            await sendEvent('plugin-reload-reply', { key: `${request.transaction}:${request.phase}` });
          } catch (error) { await sendEvent('plugin-reload-reply', { key: `${request.transaction}:${request.phase}`, error: String(error) }); }
        });
        queue = task.catch(console.error);
      }));
      // A freshly started control window only knows built-ins; drop what earlier rescans added so both windows agree.
      ctx.own(await onEvent('plugin-catalog-reset', () => {
        if (!ready || !active) return;
        queue = queue.then(() => {
          for (const entry of registry.list()) if (entry.origin !== 'builtin') unregister(entry.info.id);
          for (const [id, bundle] of committed) if (bundle.added) committed.delete(id);
        }).catch(console.error);
      }));
      ctx.own(await onEvent<Bundle[]>('plugin-reload-sync', bundles => {
        if (!ready || !active || !Array.isArray(bundles)) return;
        queue = queue.then(async () => {
          for (const bundle of bundles) {
            if (bundle.removed) { unregister(bundle.id); continue; }
            if (bundle.id === 'official.adapter.amll') continue;
            const known = committed.get(bundle.id);
            if (known && known.javascript === bundle.javascript && known.css === bundle.css && host.definition(bundle.id)) continue;
            if (!host.definition(bundle.id)) {
              if (bundle.added) { await register(await load(bundle)); committed.set(bundle.id, bundle); }
              continue;
            }
            const loaded = await load(bundle);
            await host.replace(bundle.id, loaded.plugin); registry.update(bundle.id, { plugin: loaded.plugin });
            committed.set(bundle.id, bundle);
          }
        }).catch(error => { console.error(error); void sendEvent('plugin-reload-sync-error', String(error)); });
      }));
    } else {
      ctx.own(await onEvent('plugin-reload-sync-request', () => {
        if (active && ready) void sendEvent('plugin-reload-sync', [...committed.values()].filter(b => b.id !== 'official.adapter.amll')).catch(console.error);
      }));
      ctx.own(await onEvent<string>('plugin-reload-sync-error', error => { if (active) store.update(s => ({ ...s, error })); }));
    }

    const service: ManualReload = {
      supports,
      async ready() {
        for (const entry of registry.list()) if (!entry.info.essential && entry.origin === 'builtin') builtins.set(entry.info.id, entry.plugin);
        ready = true;
        if (overlay) {
          if (desktop && !(await native<{ controlActive: boolean }>('session_restore')).controlActive) {
            savedBundles = await native<Bundle[]>('session_bundles');
            await service.restore();
          }
          await sendEvent('plugin-reload-sync-request');
        }
        else {
          if (desktop) savedBundles = await native<Bundle[]>('session_bundles');
          const restored = desktop && (await native<{ snapshot: unknown }>('session_restore')).snapshot;
          if (!restored) await sendEvent('plugin-catalog-reset');
        }
      },
      async restore() {
        for (const bundle of savedBundles) {
          if (overlay && bundle.id === 'official.adapter.amll') continue;
          if (bundle.removed) { committed.set(bundle.id, bundle); continue; }
          const loaded = await load(bundle);
          if (overlay && !registry.get(bundle.id) && (!loaded.manifest || !surfacesOf(loaded.manifest).includes('overlay'))) continue;
          const previous = host.definition(bundle.id);
          if (previous) {
            await host.replace(bundle.id, loaded.plugin);
            registry.update(bundle.id, { plugin: loaded.plugin, ...loaded.manifest ? { info: infoOf(loaded.manifest) } : {} });
          } else if (registry.get(bundle.id)) {
            registry.update(bundle.id, { plugin: loaded.plugin, ...loaded.manifest ? { info: infoOf(loaded.manifest) } : {} });
          } else if (bundle.added) {
            await register(loaded, store.get().plugins.enabled[bundle.id] !== false);
          }
          committed.set(bundle.id, bundle);
        }
        savedBundles = [];
        await checkpoint();
      },
      async broadcast() {
        await checkpoint();
        if (!overlay && ready) await sendEvent('plugin-reload-sync', [...committed.values()].filter(b => b.id !== 'official.adapter.amll'));
      },
      async reload(id, source, previous) {
        if (overlay) throw Error('请在控制面板触发热重载');
        if (!builtins.has(id) && registry.get(id)?.origin === 'builtin') builtins.set(id, previous);
        const bundle = await fetchBundle(id, source);
        const candidate = await load(bundle), transaction = crypto.randomUUID();
        const current = registry.get(id)?.info;
        if (candidate.manifest && (candidate.manifest.rendererService ?? '') !== (current?.rendererService ?? '')) throw Error('rendererService 不能在运行中改名；请重启应用');
        // Plugins that run in both windows are prepared in the overlay with the same module.
        const both = current ? surfacesOf(current).includes('overlay') : false;
        let peerPrepared = false, changed = false;
        const reconnect = id === 'official.adapter.amll' && store.get().connection.status !== 'stopped';
        const port = store.get().connection.port;
        try {
          if (both) peerPrepared = await peer('prepare', bundle, transaction, !desktop);
          if (reconnect) await host.service<AmllAdapter>('adapter.amll@1').stop();
          await host.replace(id, candidate.plugin); changed = true;
          if (reconnect) await host.service<AmllAdapter>('adapter.amll@1').start(port);
          if (peerPrepared) await peer('commit', bundle, transaction);
          if (peerPrepared) await sendEvent('plugin-reload-request', { transaction, phase: 'finish', bundle } satisfies Request);
          committed.set(id, { ...bundle, added: committed.get(id)?.added });
          await checkpoint();
          return candidate;
        } catch (error) {
          const failures: string[] = [];
          if (peerPrepared) { try { await peer('rollback', bundle, transaction); } catch (restore) { failures.push(String(restore)); } }
          if (changed) { try { await host.replace(id, previous); } catch (restore) { failures.push(String(restore)); } }
          if (reconnect) { try { await host.service<AmllAdapter>('adapter.amll@1').start(port); } catch (restore) { failures.push(String(restore)); } }
          if (failures.length) throw Error(`重载失败：${String(error)}；恢复存在错误：${failures.join('；')}`);
          throw Error(`重载未应用，已保留或恢复上一版：${String(error)}`);
        }
      },
      canRescan: source => !overlay && (source === 'source' ? Boolean(import.meta.env.DEV) : Boolean(pluginStorage)),
      async catalog(source) {
        if (source === 'local') {
          const ids = await pluginStorage!.list();
          return ids.filter(id => PLUGIN_ID.test(id)).map(id => ({ id }));
        }
        if (!import.meta.env.DEV) throw Error('只有开发模式可以扫描源码目录');
        const { manifests } = await devJson<{ manifests: PluginManifest[] }>('/__lyrscape/plugin-catalog');
        return manifests.map(manifest => ({ id: manifest.id, manifest }));
      },
      async add(id, source): Promise<PreparedAddition> {
        const bundle: Bundle = { ...await fetchBundle(id, source), added: true };
        if (bundle.builtin) throw Error('该插件没有可加载的文件');
        const loaded = await load(bundle);
        if (!loaded.manifest) throw Error('新增插件需要导出 manifest（名称、说明、类别与配置）');
        const transaction = crypto.randomUUID();
        const peerPrepared = surfacesOf(loaded.manifest).includes('overlay') ? await peer('prepare', bundle, transaction, !desktop) : false;
        return { plugin: loaded.plugin, manifest: loaded.manifest,
          async commit() {
            if (peerPrepared) {
              await peer('commit', bundle, transaction);
              await sendEvent('plugin-reload-request', { transaction, phase: 'finish', bundle } satisfies Request);
            }
            committed.set(id, bundle);
            await checkpoint();
          },
          async abort() { if (peerPrepared) await peer('rollback', bundle, transaction); } };
      },
      async remove(id) {
        const bundle: Bundle = { id, removed: true };
        committed.set(id, bundle);
        await peer('remove', bundle, crypto.randomUUID(), !desktop);
        await checkpoint();
      },
      files: pluginStorage && !overlay ? {
        read: id => pluginStorage!.read(id).catch(() => undefined),
        write: files => pluginStorage!.write(files),
        remove: id => pluginStorage!.remove(id),
      } : undefined,
      // Installed plugins export their files; in development every catalog plugin can be bundled from source.
      exportable: (id, origin) => !overlay && (origin === 'local' ? Boolean(pluginStorage) : Boolean(import.meta.env.DEV) && supports(id)),
      async exportBundle(id, origin) {
        const bundle = await fetchBundle(id, origin === 'local' ? 'local' : 'source');
        if (bundle.builtin || typeof bundle.javascript !== 'string') throw Error('这个插件没有可导出的代码');
        return { javascript: bundle.javascript, css: bundle.css ?? '' };
      },
    };
    ctx.provide<ManualReload>('plugins.reload@1', service);
  } };
}
