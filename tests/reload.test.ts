import { describe, expect, it } from 'vitest';
import { PluginHost, type Plugin, type PluginContext } from '../src/kernel/host';
import { Store } from '../src/kernel/store';
import { AURORA_RENDERER, createPluginManagement, normalizePreferences, type RegisteredPlugin } from '../src/plugins/management';
import type { AppState } from '../src/sdk/types';

describe('plugin replacement and rollback', () => {
  it('waits for reverse-order async cleanup, rejects stale scopes, and publishes the new service', async () => {
    const host = new PluginHost(), order: string[] = []; let oldContext!: PluginContext;
    await host.start([{ id: 'feature', activate(ctx) {
      oldContext = ctx; ctx.provide('feature@1', 1);
      ctx.own(async () => { await Promise.resolve(); order.push('earlier'); });
      ctx.own(async () => { await Promise.resolve(); order.push('later'); });
    } }]);
    await host.replace('feature', { id: 'feature', activate(ctx) { order.push('new'); ctx.provide('feature@1', 2); } });
    expect(order).toEqual(['later', 'earlier', 'new']); expect(host.service('feature@1')).toBe(2);
    expect(() => oldContext.provide('late@1', true)).toThrow('已释放');
    expect(() => oldContext.service('feature@1')).toThrow('已释放');
  });
  it('restores the old provider if new activation fails or removes its established service', async () => {
    const host = new PluginHost(); let disposed = 0;
    const old: Plugin = { id: 'feature', activate(ctx) { ctx.provide('feature@1', 'working'); } };
    await host.start([old]);
    await expect(host.replace('feature', { id: 'feature', activate(ctx) { ctx.provide('partial@1', true); ctx.own(() => { disposed++; }); throw Error('new failed'); } })).rejects.toThrow('已恢复上一版');
    expect(host.service('feature@1')).toBe('working'); expect(host.hasService('partial@1')).toBe(false); expect(disposed).toBe(1);
    await expect(host.replace('feature', { id: 'feature', activate() {} })).rejects.toThrow('缺少原有服务');
    expect(host.service('feature@1')).toBe('working'); expect(host.definition('feature')).toBe(old);
  });
  it('validates identity and dependency protection before stopping the working provider', async () => {
    const host = new PluginHost(); let cleanup = 0;
    await host.start([{ id: 'feature', activate(ctx) { ctx.provide('feature@1', 1); ctx.own(() => { cleanup++; }); } },
      { id: 'consumer', requires: ['feature@1'], activate() {} }]);
    await expect(host.replace('feature', { id: 'wrong', activate() {} })).rejects.toThrow('ID');
    await expect(host.replace('feature', { id: 'feature', activate() {} })).rejects.toThrow('仍被依赖');
    expect(cleanup).toBe(0); expect(host.service('feature@1')).toBe(1);
  });
});

describe('manual reload management', () => {
  it('serializes reloads, preserves selected renderer/config, and reenables the newest definition', async () => {
    const host = new PluginHost(); let version = 0;
    const original: Plugin = { id: AURORA_RENDERER, activate(ctx) { ctx.provide('renderer.aurora@1', 0); } };
    const entries: RegisteredPlugin[] = [{ plugin: original, info: { id: original.id, name: 'Aurora', description: '', version: '1', category: 'renderer', rendererService: 'renderer.aurora@1' } }];
    await host.start([original]);
    const preferences = normalizePreferences({ rendererId: AURORA_RENDERER, configs: { [AURORA_RENDERER]: { duration: 1200 } } });
    const store = new Store({ plugins: preferences } as AppState);
    const api = createPluginManagement(host, store, entries, () => {}, async () => {}, {
      supports: () => true, async reload(id) {
        const current = ++version, next: Plugin = { id, activate(ctx) { ctx.provide('renderer.aurora@1', current); } };
        await host.replace(id, next); return next;
      },
    });
    await Promise.all([api.reload(original.id), api.reload(original.id, 'local')]);
    expect(host.service('renderer.aurora@1')).toBe(2); expect(api.list()[0]).toMatchObject({ busy: false, reloadRevision: 2, reloadSource: 'local' });
    expect(store.get().plugins).toBe(preferences);
    await api.setEnabled(original.id, false); await api.setEnabled(original.id, true);
    expect(host.service('renderer.aurora@1')).toBe(2);
  });
  it('records loader failures without replacing the active plugin or saving a revision', async () => {
    const host = new PluginHost(), plugin: Plugin = { id: AURORA_RENDERER, activate(ctx) { ctx.provide('renderer.aurora@1', 1); } };
    await host.start([plugin]);
    const entries: RegisteredPlugin[] = [{ plugin, info: { id: plugin.id, name: '', description: '', version: '1', category: 'renderer' } }];
    const store = new Store({ plugins: normalizePreferences(null) } as AppState);
    const api = createPluginManagement(host, store, entries, () => {}, async () => {}, { supports: () => true, async reload() { throw Error('syntax error'); } });
    await expect(api.reload(plugin.id)).rejects.toThrow('syntax error');
    expect(api.list()[0]).toMatchObject({ active: true, busy: false, error: 'syntax error' });
    expect(api.list()[0].reloadRevision).toBeUndefined(); expect(host.service('renderer.aurora@1')).toBe(1);
  });
});
