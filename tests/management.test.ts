import { describe, expect, it } from 'vitest';
import { PluginHost } from '../src/kernel/host';
import { Store } from '../src/kernel/store';
import { AURORA_RENDERER, TEXT_RENDERER, auroraFields, createPluginManagement, normalizeConfig, normalizePreferences, type RegisteredPlugin } from '../src/plugins/management';
import type { AppState } from '../src/sdk/types';

describe('trusted plugin management', () => {
  const fixture = async (fails = false) => {
    const host = new PluginHost(), cleaned: string[] = [], persisted: unknown[] = [];
    const entries: RegisteredPlugin[] = [
      { info: { id: TEXT_RENDERER, name: 'Text', description: 'Baseline', version: '1', category: 'renderer', essential: true, rendererService: 'text@1' },
        plugin: { id: TEXT_RENDERER, activate(c) { c.provide('text@1', {}); } } },
      { info: { id: AURORA_RENDERER, name: 'Aurora', description: 'Animated', version: '1', category: 'renderer', rendererService: 'aurora@1', fields: auroraFields },
        plugin: { id: AURORA_RENDERER, activate(c) { c.provide('aurora@1', {}); c.own(() => cleaned.push('aurora')); if (fails) throw Error('broken'); } } },
    ];
    await host.start([entries[0].plugin]);
    const store = new Store({ plugins: normalizePreferences({ enabled: { [AURORA_RENDERER]: false } }) } as AppState);
    const api = createPluginManagement(host, store, entries, value => persisted.push(value), async () => {});
    return { api, host, store, entries, cleaned, persisted };
  };

  it('switches independent renderer providers and falls back before a disabled renderer is reused', async () => {
    const { api, host, store, cleaned } = await fixture();
    expect(() => api.selectRenderer(AURORA_RENDERER)).toThrow('启用');
    await api.setEnabled(AURORA_RENDERER, true); api.selectRenderer(AURORA_RENDERER);
    expect(store.get().plugins.rendererId).toBe(AURORA_RENDERER);
    await api.setEnabled(AURORA_RENDERER, false);
    expect(store.get().plugins.rendererId).toBe(TEXT_RENDERER);
    expect(host.hasService('aurora@1')).toBe(false); expect(cleaned).toEqual(['aurora']);
    await api.setEnabled(AURORA_RENDERER, true); expect(host.hasService('aurora@1')).toBe(true);
  });
  it('keeps the working renderer and persisted preferences when activation rolls back', async () => {
    const { api, host, store, cleaned, persisted } = await fixture(true);
    await expect(api.setEnabled(AURORA_RENDERER, true)).rejects.toThrow('broken');
    expect(store.get().plugins.rendererId).toBe(TEXT_RENDERER);
    expect(store.get().plugins.enabled[AURORA_RENDERER]).toBe(false);
    expect(host.hasService('aurora@1')).toBe(false); expect(host.hasService('text@1')).toBe(true);
    expect(api.list()[1].error).toBe('broken'); expect(api.list()[1].busy).toBe(false);
    expect(persisted).toEqual([]); expect(cleaned).toEqual(['aurora']);
  });
  it('blocks disabling a provider with active dependents', async () => {
    const { host, entries } = await fixture();
    await host.start([entries[1].plugin, { id: 'effect', requires: ['aurora@1'], activate() {} }]);
    expect(() => host.deactivate(AURORA_RENDERER)).toThrow('effect');
    expect(host.hasService('aurora@1')).toBe(true);
    host.deactivate('effect'); host.deactivate(AURORA_RENDERER);
    expect(host.hasService('aurora@1')).toBe(false);
  });
  it('retains independent config while disabled and resets just that plugin', async () => {
    const { api, store } = await fixture();
    api.configure(AURORA_RENDERER, { entrance: 'orbit', duration: 1200, unknown: 'ignored' });
    expect(store.get().plugins.configs[AURORA_RENDERER]).toMatchObject({ entrance: 'orbit', duration: 1200 });
    expect(store.get().plugins.configs[AURORA_RENDERER]).not.toHaveProperty('unknown');
    await api.setEnabled(AURORA_RENDERER, true); await api.setEnabled(AURORA_RENDERER, false);
    expect(store.get().plugins.configs[AURORA_RENDERER].entrance).toBe('orbit');
    api.resetConfig(AURORA_RENDERER); expect(store.get().plugins.configs[AURORA_RENDERER].entrance).toBe('comet');
  });
  it('protects the recoverable baseline and rejects unknown plugins', async () => {
    const { api, host } = await fixture();
    await expect(api.setEnabled(TEXT_RENDERER, false)).rejects.toThrow('基础');
    expect(host.hasService('text@1')).toBe(true);
    expect(() => api.configure('unknown', {})).toThrow('未注册');
  });
  it('serializes toggles without duplicate service registration', async () => {
    const { api, host } = await fixture();
    await Promise.all([api.setEnabled(AURORA_RENDERER, true), api.setEnabled(AURORA_RENDERER, false), api.setEnabled(AURORA_RENDERER, true)]);
    expect(host.activePlugins).toEqual([TEXT_RENDERER, AURORA_RENDERER]);
  });
  it('normalizes malformed stored config and refuses a disabled selected renderer', () => {
    expect(normalizePreferences({ rendererId: AURORA_RENDERER, enabled: { [AURORA_RENDERER]: false } }).rendererId).toBe(TEXT_RENDERER);
    expect(normalizeConfig(auroraFields, { duration: 99999, stagger: -10, entrance: 'invalid', motion: 'yes', intensity: NaN })).toMatchObject({
      duration: 1800, stagger: 0, entrance: 'comet', motion: true, intensity: 1,
    });
    expect(normalizePreferences(null).rendererId).toBe(TEXT_RENDERER);
  });
});
