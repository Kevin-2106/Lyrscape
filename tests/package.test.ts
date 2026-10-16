import { describe, expect, it } from 'vitest';
import { PluginHost, type Plugin } from '../src/kernel/host';
import { Store } from '../src/kernel/store';
import { createPluginManagement, normalizePreferences, TEXT_RENDERER, type PluginReloader } from '../src/plugins/management';
import { createPackage, packageIntegrity, parsePackage, serializePackage, validatePackage } from '../src/plugins/package';
import { PluginRegistry } from '../src/plugins/registry';
import type { AppState, PluginManifest } from '../src/sdk/types';

const manifest = (id = 'me.renderer.wave', extra: Partial<PluginManifest> = {}): PluginManifest => ({
  id, name: 'Wave', description: 'A wave', category: 'renderer', version: '1.0.0', rendererService: `renderer.${id.split('.').pop()}@1`,
  fields: [{ key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 2, step: 0.5 }], author: 'Me', tags: ['demo'], ...extra,
});

describe('.lyrx packages', () => {
  it('round-trips through JSON with a matching integrity', async () => {
    const pkg = await createPackage(manifest(), 'export default {}', '.a{}', { speed: 2 });
    expect(pkg.integrity).toBe(await packageIntegrity('export default {}', '.a{}'));
    const parsed = await parsePackage(serializePackage(pkg));
    expect(parsed).toMatchObject({ format: 'lyrscape.plugin', formatVersion: 1, manifest: { id: 'me.renderer.wave', author: 'Me', tags: ['demo'] }, config: { speed: 2 } });
  });
  it('refuses tampering, unknown formats, oversize code and invalid manifests', async () => {
    const pkg = await createPackage(manifest(), 'export default {}');
    await expect(validatePackage({ ...pkg, javascript: 'export default 1' })).rejects.toThrow('校验失败');
    await expect(validatePackage({ ...pkg, formatVersion: 2 })).rejects.toThrow('不支持');
    await expect(validatePackage({ ...pkg, format: 'zip' })).rejects.toThrow('不是 Lyrscape');
    await expect(validatePackage({ ...pkg, integrity: undefined, javascript: 'x'.repeat(2 * 1024 * 1024 + 1) })).rejects.toThrow('2 MB');
    await expect(validatePackage({ ...pkg, manifest: { ...pkg.manifest, homepage: 'http://x' } })).rejects.toThrow('homepage');
    await expect(validatePackage({ ...pkg, config: { nested: { a: 1 } } })).rejects.toThrow('config');
    await expect(parsePackage('{not json')).rejects.toThrow('JSON');
  });
  it('accepts a package without integrity (hand-written) and strips unknown fields', async () => {
    const { integrity: _, ...bare } = await createPackage(manifest(), 'export default {}');
    const parsed = await validatePackage({ ...bare, extra: true });
    expect(parsed.integrity).toBeUndefined(); expect('extra' in parsed).toBe(false);
  });
});

describe('install / uninstall / export', () => {
  async function setup() {
    const host = new PluginHost(), files = new Map<string, { id: string; javascript: string; css: string }>(), events: string[] = [];
    const text: Plugin = { id: TEXT_RENDERER, activate(ctx) { ctx.provide('renderer.text@1', 'text'); } };
    const registry = new PluginRegistry([{ info: { id: TEXT_RENDERER, name: 'Text', description: '', version: '1', category: 'renderer', rendererService: 'renderer.text@1', essential: true }, plugin: text, origin: 'builtin' }]);
    await host.start([text]);
    const store = new Store({ plugins: normalizePreferences(null, []) } as AppState);
    // Code "loads" by evaluating the stored text as the provided value; 'throw' simulates a broken module.
    const load = (id: string) => {
      const source = files.get(id)!;
      if (source.javascript.includes('throw')) throw Error('broken module');
      const service = JSON.parse(source.javascript.replace('export default ', '')).service as string;
      return { plugin: { id, activate(ctx) { ctx.provide(service, source.javascript); } } as Plugin, manifest: manifest(id, { rendererService: service }) };
    };
    const reloader: PluginReloader = {
      supports: () => true, canRescan: () => true,
      reload: async (id, _source, _previous) => { events.push(`reload:${id}`); const loaded = load(id); await host.replace(id, loaded.plugin); return loaded; },
      catalog: async () => [...files.keys()].map(id => ({ id })),
      add: async id => { events.push(`add:${id}`); const loaded = load(id); return { ...loaded, commit: async () => {}, abort: async () => {} }; },
      remove: async id => { events.push(`remove:${id}`); },
      files: { read: async id => files.get(id), write: async f => { files.set(f.id, f); }, remove: async id => { files.delete(id); } },
      exportable: (_id, origin) => origin === 'local',
      exportBundle: async id => files.get(id)!,
    };
    const api = createPluginManagement(host, store, registry, () => {}, async () => {}, reloader);
    return { host, store, api, files, events };
  }
  const code = (service: string, tag = '') => `export default ${JSON.stringify({ service, tag })}`;

  it('installs, applies bundled config, updates in place keeping the selection, exports and uninstalls', async () => {
    const { host, store, api, files, events } = await setup();
    expect(api.canInstall()).toBe(true);
    const pkg = await createPackage(manifest(), code('renderer.wave@1'), '', { speed: 1.5 });
    expect(await api.install(pkg)).toEqual({ id: 'me.renderer.wave', action: 'installed' });
    expect(api.list().find(p => p.id === 'me.renderer.wave')).toMatchObject({ origin: 'local', removable: true, exportable: true, active: true, author: 'Me' });
    expect(store.get().plugins.configs['me.renderer.wave']).toEqual({ speed: 1.5 });
    api.selectRenderer('me.renderer.wave');

    const update = await createPackage(manifest(), code('renderer.wave@1', 'v2'), '', { speed: 0 });
    expect(await api.install(update)).toEqual({ id: 'me.renderer.wave', action: 'updated' });
    expect(events).toContain('reload:me.renderer.wave');
    expect(host.service('renderer.wave@1')).toContain('v2');
    expect(store.get().plugins.rendererId).toBe('me.renderer.wave');
    expect(store.get().plugins.configs['me.renderer.wave']).toEqual({ speed: 1.5 }); // existing config wins

    const exported = await api.exportPackage('me.renderer.wave');
    expect(exported.javascript).toContain('v2'); expect(exported.config).toEqual({ speed: 1.5 });
    expect(exported.integrity).toBe(await packageIntegrity(exported.javascript, exported.css));

    await api.uninstall('me.renderer.wave');
    expect(files.size).toBe(0); expect(host.hasService('renderer.wave@1')).toBe(false);
    expect(store.get().plugins.rendererId).toBe(TEXT_RENDERER);
    expect(store.get().plugins.configs['me.renderer.wave']).toBeUndefined();
  });

  it('rolls back a broken install or update and refuses id / service clashes and other categories', async () => {
    const { host, api, files } = await setup();
    await expect(api.install(await createPackage(manifest(), 'throw')).then(() => 0)).rejects.toThrow('broken');
    expect(files.size).toBe(0); expect(api.list().some(p => p.id === 'me.renderer.wave')).toBe(false);

    await api.install(await createPackage(manifest(), code('renderer.wave@1', 'v1')));
    await expect(api.install(await createPackage(manifest(), 'throw'))).rejects.toThrow('broken');
    expect(files.get('me.renderer.wave')!.javascript).toContain('v1');
    expect(host.service('renderer.wave@1')).toContain('v1');

    await expect(api.install(await createPackage(manifest(TEXT_RENDERER, { rendererService: 'renderer.plain@1' }), code('renderer.plain@1')))).rejects.toThrow('内置');
    await expect(api.install(await createPackage(manifest('me.renderer.copy', { rendererService: 'renderer.wave@1' }), code('renderer.wave@1')))).rejects.toThrow('已由');
    await expect(api.install(await createPackage(manifest('me.parser.x', { category: 'lyric-parser', rendererService: undefined, fields: undefined }), code('x@1')))).rejects.toThrow('渲染器或特效');
    await expect(api.uninstall(TEXT_RENDERER)).rejects.toThrow('只有已安装');
    await expect(api.exportPackage(TEXT_RENDERER)).rejects.toThrow('内置');
  });

  it('updating a disabled plugin replaces its code without starting it', async () => {
    const { host, api, store } = await setup();
    await api.install(await createPackage(manifest(), code('renderer.wave@1', 'v1')));
    await api.setEnabled('me.renderer.wave', false);
    await api.install(await createPackage(manifest(), code('renderer.wave@1', 'v2')));
    expect(host.hasService('renderer.wave@1')).toBe(false);
    expect(store.get().plugins.enabled['me.renderer.wave']).toBe(false);
    await api.setEnabled('me.renderer.wave', true);
    expect(host.service('renderer.wave@1')).toContain('v2');
  });
});
