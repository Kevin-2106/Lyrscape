import { describe, it, expect } from 'vitest';
import { PluginHost } from '../src/kernel/host';
import { timeline } from '../src/plugins/timeline';
import { normalizeSettings } from '../src/plugins/theme';
import type { AppState } from '../src/sdk/types';

describe('plugin lifecycle', () => {
  it('resolves services out of order and tears down dependents first', async () => {
    const host = new PluginHost(), cleaned: string[] = [];
    await host.start([
      { id: 'consumer', requires: ['clock@1'], activate(c) { expect(c.service('clock@1')).toBe(42); c.own(() => cleaned.push('consumer')); } },
      { id: 'provider', activate(c) { c.provide('clock@1', 42); c.own(() => cleaned.push('provider')); } },
    ]);
    host.stop(); expect(cleaned).toEqual(['consumer', 'provider']);
    expect(() => host.service('clock@1')).toThrow();
  });
  it('rolls back partial activation and prior providers on failure', async () => {
    const host = new PluginHost(), disposed: string[] = [];
    await expect(host.start([
      { id: 'one', activate(c) { c.provide('one', true); c.own(() => disposed.push('one')); } },
      { id: 'bad', activate(c) { c.provide('bad', true); c.own(() => disposed.push('bad')); throw Error('failed'); } },
    ])).rejects.toThrow('failed');
    expect(disposed).toEqual(['bad', 'one']); expect(host.activePlugins).toEqual([]);
    expect(() => host.service('bad')).toThrow();
  });
  it('rejects unresolved dependency and duplicate identity without leaving services', async () => {
    const host = new PluginHost();
    await expect(host.start([{ id: 'a', requires: ['missing'], activate() {} }])).rejects.toThrow('缺少服务');
    await expect(host.start([{ id: 'a', activate() {} }, { id: 'a', activate() {} }])).rejects.toThrow('重复插件');
  });
});

describe('shared timeline and settings boundaries', () => {
  const state = { playback: { positionMs: 1000, playing: true, observedAtMonoMs: 2000, rate: 1 }, track: { durationMs: 20000 }, adapterId: 'amll' } as AppState;
  it('interpolates a fresh anchor but limits stale external samples', () => {
    expect(timeline.position(state, 2500)).toBe(1500); expect(timeline.position(state, 12000)).toBe(6000);
    expect(timeline.position({ ...state, playback: { ...state.playback, playing: false } }, 12000)).toBe(1000);
  });
  it('clamps duration and ignores negative elapsed time', () => {
    expect(timeline.position(state, 1000)).toBe(1000);
    expect(timeline.position({ ...state, track: { title: '', artists: [], durationMs: 1100 } }, 9000)).toBe(1100);
  });
  it('recovers malformed settings and clamps numeric values', () => {
    const s = normalizeSettings({ color: 'url(https://example.com)', fontSize: 9999, gradientAngle: -50, fontWeight: NaN, textAlign: 'oops' });
    expect(s.color).toBe('#f4f2ff'); expect(s.fontSize).toBe(100); expect(s.gradientAngle).toBe(0);
    expect(s.fontWeight).toBe(600); expect(s.textAlign).toBe('center');
  });
});
