import { describe, expect, it } from 'vitest';
import { PluginHost, type Plugin } from '../src/kernel/host';
import { Store } from '../src/kernel/store';
import { catalog } from '../src/plugins/catalog';
import { builtinManifests } from '../src/plugins/manifests';
import { createPluginManagement, normalizePreferences, TEXT_RENDERER, type PluginReloader, type PreparedAddition } from '../src/plugins/management';
import { infoOf, metadataKey, PluginRegistry, validateManifest } from '../src/plugins/registry';
import type { AppState, PluginManifest } from '../src/sdk/types';

const manifest = (id: string, extra: Partial<PluginManifest> = {}): PluginManifest => ({
  id, name: 'Style', description: 'A style', category: 'renderer', rendererService: `renderer.${id.split('.').pop()}@1`,
  fields: [{ key: 'size', label: 'Size', type: 'number', default: 1, min: 0, max: 2, step: 0.5 }], ...extra,
});
const renderer = (id: string, service: string, value = id): Plugin => ({ id, activate(ctx) { ctx.provide(service, value); } });

describe('plugin manifests', () => {
  it('every built-in catalog manifest has a factory producing the same id', () => {
    const store = new Store({ plugins: normalizePreferences(null) } as AppState);
    expect(catalog.map(item => item.manifest.id)).toEqual(builtinManifests.map(m => m.id));
    for (const item of catalog) {
      expect(item.create(store).id).toBe(item.manifest.id);
      expect(validateManifest(JSON.parse(JSON.stringify(item.manifest)), item.manifest.id)).toMatchObject({ id: item.manifest.id });
    }
  });
  it('a validated built-in manifest has the same metadata as the original', () => {
    for (const item of catalog) expect(metadataKey(infoOf(validateManifest(JSON.parse(JSON.stringify(item.manifest)), item.manifest.id)))).toBe(metadataKey(infoOf(item.manifest)));
  });
  it('rejects malformed or mismatched manifests', () => {
    const ok = manifest('local.renderer.neon');
    expect(validateManifest(ok, ok.id)).toMatchObject({ rendererService: 'renderer.neon@1' });
    expect(() => validateManifest(ok, 'local.renderer.other')).toThrow('相同');
    expect(() => validateManifest({ ...ok, id: '../x' }, '../x')).toThrow();
    expect(() => validateManifest({ ...ok, rendererService: 'neon' }, ok.id)).toThrow('rendererService');
    expect(() => validateManifest({ ...ok, category: 'effect' }, ok.id)).toThrow('只有渲染器');
    expect(() => validateManifest({ ...ok, fields: [{ key: 'a', label: 'A', type: 'number', default: 9, min: 0, max: 2 }] }, ok.id)).toThrow('范围');
    expect(() => validateManifest({ ...ok, fields: [{ key: 'a', label: 'A', type: 'select', default: 'z', options: [{ value: 'y', label: 'Y' }] }] }, ok.id)).toThrow('默认值');
    expect(() => validateManifest({ ...ok, fields: [ok.fields![0], ok.fields![0]] }, ok.id)).toThrow('重复');
    expect(() => validateManifest({ ...ok, surfaces: ['desktop'] }, ok.id)).toThrow('surfaces');
  });
  it('keeps settings of plugins that are not registered yet', () => {
    const prefs = normalizePreferences({ rendererId: 'local.renderer.neon', enabled: { 'local.renderer.neon': false },
      configs: { 'local.renderer.neon': { size: 1.5, nested: { no: 1 } }, 'official.renderer.aurora': { duration: 99999 } } });
    expect(prefs.rendererId).toBe(TEXT_RENDERER);
    expect(prefs.enabled['local.renderer.neon']).toBe(false);
    expect(prefs.configs['local.renderer.neon']).toEqual({ size: 1.5 });
    expect(prefs.configs['official.renderer.aurora'].duration).toBe(1800);
  });
});

describe('catalog rescan', () => {
  async function setup(listing: { id: string; manifest?: PluginManifest }[], loads: Record<string, { plugin: Plugin; manifest: PluginManifest }>, stored?: unknown) {
    const host = new PluginHost();
    const text = renderer(TEXT_RENDERER, 'renderer.text@1'), old = renderer('official.renderer.old', 'renderer.old@1');
    const kept = renderer('official.renderer.kept', 'renderer.kept@1');
    const registry = new PluginRegistry([
      { info: { id: TEXT_RENDERER, name: 'Text', description: '', version: '1', category: 'renderer', rendererService: 'renderer.text@1', essential: true }, plugin: text, origin: 'builtin' },
      { info: { id: old.id, name: 'Old', description: '', version: '1', category: 'renderer', rendererService: 'renderer.old@1' }, plugin: old, origin: 'builtin' },
      { info: { id: kept.id, name: 'Kept', description: 'before', version: '1', category: 'renderer', rendererService: 'renderer.kept@1', fields: [] }, plugin: kept, origin: 'builtin' },
    ]);
    await host.start([text, old, kept]);
    const known = registry.list().filter(entry => !entry.info.essential).map(entry => ({ id: entry.info.id, fields: entry.info.fields, rendererService: entry.info.rendererService }));
    const store = new Store({ plugins: normalizePreferences(stored ?? { rendererId: old.id }, known) } as AppState);
    const events: string[] = [];
    const reloader: PluginReloader = {
      supports: () => true, reload: async () => { throw Error('unused'); }, canRescan: () => true,
      catalog: async () => listing,
      async add(id): Promise<PreparedAddition> {
        const loaded = loads[id]; if (!loaded) throw Error(`missing ${id}`);
        events.push(`prepare:${id}`);
        return { ...loaded, commit: async () => { events.push(`commit:${id}`); if (id.includes('fail')) throw Error('overlay refused'); }, abort: async () => { events.push(`abort:${id}`); } };
      },
      async remove(id) { events.push(`remove:${id}`); },
    };
    const api = createPluginManagement(host, store, registry, () => {}, async () => {}, reloader);
    return { host, store, api, events, registry };
  }

  it('adds new plugins with preserved settings, updates metadata, and removes plugins gone from the source', async () => {
    const neon = manifest('official.renderer.neon');
    const { host, store, api, events } = await setup(
      [{ id: 'official.renderer.kept', manifest: manifest('official.renderer.kept', { description: 'after' }) }, { id: neon.id, manifest: neon }],
      { [neon.id]: { plugin: renderer(neon.id, 'renderer.neon@1'), manifest: neon } },
      { rendererId: 'official.renderer.old', configs: { [neon.id]: { size: 7 } } });
    const report = await api.rescan('source');
    expect(report).toMatchObject({ added: [neon.id], updated: ['official.renderer.kept'], removed: ['official.renderer.old'], failed: [] });
    expect(host.service('renderer.neon@1')).toBe(neon.id);
    expect(host.hasService('renderer.old@1')).toBe(false);
    expect(api.list().find(p => p.id === neon.id)).toMatchObject({ origin: 'source', active: true, name: 'Style' });
    expect(api.list().find(p => p.id === 'official.renderer.kept')).toMatchObject({ description: 'after' });
    // The stored out-of-range value from before registration is clamped by the new schema.
    expect(store.get().plugins.configs[neon.id]).toEqual({ size: 2 });
    expect(store.get().plugins.configs['official.renderer.kept']).toEqual({ size: 1 });
    expect(store.get().plugins.rendererId).toBe(TEXT_RENDERER);
    expect(events).toEqual([`prepare:${neon.id}`, `commit:${neon.id}`, 'remove:official.renderer.old']);
    api.selectRenderer(neon.id); expect(store.get().plugins.rendererId).toBe(neon.id);
  });

  it('reports failures and rolls back a half-added plugin', async () => {
    const clash = manifest('official.renderer.clash', { rendererService: 'renderer.kept@1' });
    const fail = manifest('official.renderer.fail');
    const parser = manifest('official.parser.extra', { category: 'lyric-parser', rendererService: undefined, fields: undefined });
    const listing = [clash, fail, parser].map(m => ({ id: m.id, manifest: m }));
    const { host, api, events } = await setup([...listing, { id: 'official.renderer.old' }, { id: 'official.renderer.kept' }], {
      [clash.id]: { plugin: renderer(clash.id, 'renderer.kept@1'), manifest: clash },
      [fail.id]: { plugin: renderer(fail.id, 'renderer.fail@1'), manifest: fail },
      [parser.id]: { plugin: { id: parser.id, activate() {} }, manifest: parser },
    });
    const report = await api.rescan('source');
    expect(report.added).toEqual([]);
    expect(report.failed.map(f => f.id)).toEqual([clash.id, fail.id, parser.id]);
    expect(report.failed[0].error).toContain('已由 official.renderer.kept 提供');
    expect(report.failed[1].error).toContain('overlay refused');
    expect(report.failed[2].error).toContain('只能新增渲染器或特效');
    expect(host.hasService('renderer.fail@1')).toBe(false);
    expect(api.list().some(p => p.id === fail.id)).toBe(false);
    expect(events).toContain(`abort:${fail.id}`);
    expect(report.removed).toEqual([]);
  });

  it('local scans only remove plugins that the plugins folder added', async () => {
    const { api } = await setup([], {});
    expect((await api.rescan('local')).removed).toEqual([]);
    expect(api.list().map(p => p.id)).toContain('official.renderer.old');
  });
});
