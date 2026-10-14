import type { Plugin, PluginHost } from '../kernel/host';
import type { Store } from '../kernel/store';
import type { AppState, CatalogReport, ConfigField, ConfigValue, PluginInfo, PluginManagement, PluginManifest, PluginPreferences, Renderer } from '../sdk/types';
import { builtinManifests, TEXT_RENDERER } from './manifests';
import { legacyPvIds } from './pv-presets';
import { ADDABLE_CATEGORIES, infoOf, metadataKey, PluginRegistry, validateManifest, type RegistryEntry } from './registry';

export { AMLL_ADAPTER, AURORA_RENDERER, BEAT_DETECTOR, TEXT_RENDERER, amllFields, auroraFields, beatFields } from './manifests';
export interface RegisteredPlugin { info: PluginInfo; plugin: Plugin }
/** A freshly loaded definition, with the manifest its module exported (if any). */
export interface LoadedPlugin { plugin: Plugin; manifest?: PluginManifest }
/** A plugin new to this window, loaded and prepared in the overlay but not yet running. */
export interface PreparedAddition { plugin: Plugin; manifest: PluginManifest; commit(): Promise<void>; abort(): Promise<void> }
export interface PluginReloader {
  supports(id: string): boolean;
  reload(id: string, source: 'source' | 'local', previous: Plugin): Promise<Plugin | LoadedPlugin>;
  canRescan?(source: 'source' | 'local'): boolean;
  /** Catalog listing: manifests from the development source, or bare IDs of exe-side files. */
  catalog?(source: 'source' | 'local'): Promise<{ id: string; manifest?: PluginManifest }[]>;
  add?(id: string, source: 'source' | 'local'): Promise<PreparedAddition>;
  /** Drops a removed plugin from the other window. */
  remove?(id: string): Promise<void>;
}

/** Renderer names for UI labels; the plain text renderer is always available. */
export function rendererName(management: PluginManagement | undefined, id: string): string | undefined {
  return management?.list().find(plugin => plugin.id === id && plugin.rendererService)?.name;
}

export function normalizeConfig(fields: ConfigField[], input: unknown): Record<string, ConfigValue> {
  const values = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return Object.fromEntries(fields.map(field => {
    const value = values[field.key];
    let normalized = field.default;
    if (field.type === 'boolean' && typeof value === 'boolean') normalized = value;
    if (field.type === 'select' && field.options?.some(option => option.value === value)) normalized = value as string;
    if (field.type === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      const min = field.min ?? 0, max = field.max ?? Number.MAX_SAFE_INTEGER, step = field.step ?? 1;
      normalized = Math.min(max, Math.max(min, min + Math.round((value - min) / step) * step));
      normalized = Number(Number(normalized).toFixed(4));
    }
    return [field.key, normalized];
  }));
}

/** Stored values of a plugin this window does not know yet: kept verbatim (primitives only) until a rescan registers it. */
function preserved(input: unknown): Record<string, ConfigValue> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const entries = Object.entries(input as Record<string, unknown>).filter(([key, value]) =>
    key.length <= 32 && (typeof value === 'boolean' || typeof value === 'string' && value.length <= 200 || typeof value === 'number' && Number.isFinite(value)));
  return entries.length ? Object.fromEntries(entries.slice(0, 40)) as Record<string, ConfigValue> : undefined;
}

/**
 * Normalises stored preferences against the known optional plugins. Settings of
 * plugins not registered right now (local files, newer source) survive so a later
 * rescan finds them; only the renderer selection falls back to plain text.
 */
export function normalizePreferences(input: unknown, known: Pick<PluginManifest, 'id' | 'fields' | 'rendererService'>[] = builtinManifests): PluginPreferences {
  const value = input && typeof input === 'object' ? input as Partial<PluginPreferences> : {};
  const ids = new Set(known.map(entry => entry.id));
  const enabled: Record<string, boolean> = {}, configs: PluginPreferences['configs'] = {};
  for (const [id, flag] of Object.entries(value.enabled ?? {})) if (!ids.has(id) && id !== TEXT_RENDERER && typeof flag === 'boolean') enabled[id] = flag;
  for (const [id, config] of Object.entries(value.configs ?? {})) {
    const kept = !ids.has(id) && id !== TEXT_RENDERER ? preserved(config) : undefined;
    if (kept) configs[id] = kept;
  }
  for (const entry of known) {
    enabled[entry.id] = value.enabled?.[entry.id] !== false;
    configs[entry.id] = normalizeConfig(entry.fields ?? [], value.configs?.[entry.id]);
  }
  const requested = value.rendererId ? legacyPvIds[value.rendererId] ?? value.rendererId : undefined;
  const selected = known.find(entry => entry.id === requested && entry.rendererService);
  return { rendererId: selected && enabled[selected.id] !== false ? selected.id : TEXT_RENDERER, enabled, configs };
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createPluginManagement(host: PluginHost, store: Store<AppState>, entries: RegisteredPlugin[] | PluginRegistry,
  persist: (preferences: PluginPreferences) => void, beforeDisable: (id: string) => Promise<void>, reloader?: PluginReloader): PluginManagement {
  const registry = entries instanceof PluginRegistry ? entries
    : new PluginRegistry(entries.map(entry => ({ ...entry, origin: 'builtin' as const })));
  const listeners = new Set<() => void>(), errors = new Map<string, string>();
  const pending = new Map<string, number>();
  let queue = Promise.resolve();
  const reloads = new Map<string, { source: 'source' | 'local'; revision: number }>();
  const notify = () => listeners.forEach(fn => fn());
  registry.subscribe(notify);
  host.subscribe(notify);
  const find = (id: string) => {
    const entry = registry.get(id);
    if (!entry) throw new Error(`插件未注册：${id}`);
    return entry;
  };
  const update = (preferences: PluginPreferences) => { persist(preferences); store.update(s => ({ ...s, plugins: preferences })); notify(); };
  /** Runs `task` in the serialized queue while `ids` show as busy. */
  const serialized = <T>(ids: string[], task: () => Promise<T>): Promise<T> => {
    for (const id of ids) pending.set(id, (pending.get(id) ?? 0) + 1);
    notify();
    const operation = queue.then(task).finally(() => {
      for (const id of ids) { const remaining = (pending.get(id) ?? 1) - 1; if (remaining) pending.set(id, remaining); else pending.delete(id); }
      notify();
    });
    queue = operation.then(() => {}, () => {});
    return operation;
  };
  /** New metadata for a registered plugin; stored configuration is re-normalised against the new fields. */
  const applyInfo = (entry: RegistryEntry, manifest: PluginManifest) => {
    const info = { ...infoOf(manifest, entry.info.essential), essential: entry.info.essential };
    if (!info.essential) delete info.essential;
    if ((info.rendererService ?? '') !== (entry.info.rendererService ?? '')) throw Error('rendererService 不能在运行中改名；请重启应用');
    if (metadataKey(info) === metadataKey(entry.info)) return false;
    registry.update(info.id, { info });
    const current = store.get().plugins;
    update({ ...current, configs: { ...current.configs, [info.id]: normalizeConfig(info.fields ?? [], current.configs[info.id]) } });
    return true;
  };
  const scanning = new Set<'source' | 'local'>();

  const management: PluginManagement = {
    list: () => registry.list().map(({ info, plugin, origin }) => ({ ...info, origin, active: host.activePlugins.includes(info.id),
      busy: pending.has(info.id), error: errors.get(info.id), requires: plugin.requires ?? [], provides: host.providedServices(info.id),
      reloadable: !info.essential && Boolean(reloader?.supports(info.id)), reloadSource: reloads.get(info.id)?.source, reloadRevision: reloads.get(info.id)?.revision })),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    setEnabled(id, enabled) {
      const { info } = find(id);
      if (info.essential) return Promise.reject(new Error('基础组合插件需保持启用，以保证管理与恢复入口可用。'));
      return serialized([id], async () => {
        try {
          errors.delete(id);
          const { plugin } = find(id);
          if (enabled && !host.activePlugins.includes(id)) await host.start([plugin]);
          if (!enabled && host.activePlugins.includes(id)) {
            await beforeDisable(id);
            host.deactivate(id);
          }
          const current = store.get().plugins;
          update({ ...current, rendererId: !enabled && current.rendererId === id ? TEXT_RENDERER : current.rendererId,
            enabled: { ...current.enabled, [id]: enabled } });
        } catch (error) { errors.set(id, message(error)); throw error; }
      });
    },
    selectRenderer(id) {
      const { info } = find(id);
      if (!info.rendererService || !host.hasService(info.rendererService)) throw new Error('请先启用这个渲染器。');
      update({ ...store.get().plugins, rendererId: id });
    },
    configure(id, patch) {
      const fields = find(id).info.fields ?? [], current = store.get().plugins;
      const configs = { ...current.configs, [id]: normalizeConfig(fields, { ...current.configs[id], ...patch }) };
      update({ ...current, configs });
    },
    resetConfig(id) {
      const current = store.get().plugins;
      update({ ...current, configs: { ...current.configs, [id]: normalizeConfig(find(id).info.fields ?? [], {}) } });
    },
    reload(id, source = 'source') {
      const entry = find(id);
      if (entry.info.essential || !reloader?.supports(id)) return Promise.reject(new Error('当前插件未开放手动热重载'));
      return serialized([id], async () => {
        try {
          errors.delete(id);
          if (!host.activePlugins.includes(id)) throw new Error('请先启用插件再热重载');
          const result = await reloader.reload(id, source, find(id).plugin);
          const loaded: LoadedPlugin = 'activate' in result ? { plugin: result } : result;
          registry.update(id, { plugin: loaded.plugin });
          if (loaded.manifest) applyInfo(find(id), loaded.manifest);
          reloads.set(id, { source, revision: (reloads.get(id)?.revision ?? 0) + 1 });
          // Selection/configuration are preserved; views observe the new service instance.
          store.update(s => ({ ...s }));
        } catch (error) { errors.set(id, message(error)); throw error; }
      });
    },
    canRescan: source => Boolean(reloader?.catalog && reloader.canRescan?.(source)),
    rescan(source = 'source') {
      if (!reloader?.catalog || !reloader.add || !reloader.canRescan?.(source)) return Promise.reject(new Error('当前环境没有可扫描的插件目录'));
      if (scanning.has(source)) return Promise.reject(new Error('正在扫描插件列表'));
      scanning.add(source);
      return serialized([], async () => {
        const report: CatalogReport = { added: [], updated: [], removed: [], unchanged: [], failed: [] };
        const listing = await reloader.catalog!(source);
        const listed = new Set(listing.map(item => item.id));
        for (const item of listing) {
          const existing = registry.get(item.id);
          try {
            if (existing) {
              if (existing.info.essential) throw Error('基础组合插件不能由目录替换');
              if (item.manifest && applyInfo(existing, validateManifest(item.manifest, item.id))) report.updated.push(item.id);
              else report.unchanged.push(item.id);
              continue;
            }
            const addition = await reloader.add!(item.id, source);
            const manifest = validateManifest(addition.manifest, item.id);
            try {
              if (!ADDABLE_CATEGORIES.includes(manifest.category)) throw Error('运行中只能新增渲染器或特效插件；其他类别需要重新构建应用');
              const owner = manifest.rendererService && registry.serviceOwner(manifest.rendererService);
              if (owner) throw Error(`服务 ${manifest.rendererService} 已由 ${owner} 提供`);
              const stored = store.get().plugins;
              const enabled = stored.enabled[item.id] !== false;
              if (enabled) await host.start([addition.plugin]);
              registry.set({ info: infoOf(manifest), plugin: addition.plugin, origin: source });
              update({ ...stored, enabled: { ...stored.enabled, [item.id]: enabled },
                configs: { ...stored.configs, [item.id]: normalizeConfig(manifest.fields ?? [], stored.configs[item.id]) } });
              await addition.commit();
            } catch (error) {
              if (registry.has(item.id)) registry.remove(item.id);
              if (host.activePlugins.includes(item.id)) host.deactivate(item.id);
              await addition.abort().catch(console.error);
              throw error;
            }
            report.added.push(item.id);
          } catch (error) { report.failed.push({ id: item.id, error: message(error) }); }
        }
        // The development source is authoritative for every catalog plugin; the exe folder only for the plugins it added.
        const removable = registry.list().filter(entry => !entry.info.essential && !listed.has(entry.info.id)
          && (source === 'source' ? entry.origin !== 'local' : entry.origin === 'local'));
        for (const entry of removable) {
          const id = entry.info.id;
          try {
            if (host.activePlugins.includes(id)) { await beforeDisable(id); host.deactivate(id); }
            await reloader.remove?.(id);
            registry.remove(id); errors.delete(id); reloads.delete(id);
            const current = store.get().plugins;
            if (current.rendererId === id) update({ ...current, rendererId: TEXT_RENDERER });
            report.removed.push(id);
          } catch (error) { report.failed.push({ id, error: message(error) }); }
        }
        store.update(s => ({ ...s }));
        return report;
      }).finally(() => { scanning.delete(source); notify(); });
    },
  };
  return management;
}

/** Selection is a product plugin. Each renderer owns its mount and disposal. */
export function rendererSelectionPlugin(host: PluginHost, registry: PluginRegistry): Plugin {
  return {
    id: 'official.renderer.selection', requires: ['renderer.text@1'],
    activate(ctx) {
      ctx.provide<Renderer>('renderer@1', {
        mount(root, getState, timeline) {
          let selected: Renderer | undefined, cleanup: (() => void) | undefined, raf = 0, disposed = false;
          const frame = () => {
            if (disposed) return;
            const state = getState();
            const service = registry.get(state.plugins.rendererId)?.info.rendererService;
            const usable = service && state.plugins.enabled[state.plugins.rendererId] !== false && host.hasService(service) ? service : 'renderer.text@1';
            const renderer = host.service<Renderer>(usable);
            if (selected !== renderer) {
              cleanup?.(); selected = renderer;
              cleanup = renderer.mount(root, getState, timeline);
            }
            raf = requestAnimationFrame(frame);
          };
          frame();
          return () => { disposed = true; cancelAnimationFrame(raf); cleanup?.(); };
        },
      });
    },
  };
}
