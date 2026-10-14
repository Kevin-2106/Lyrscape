// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { AppState, PluginManagement } from '../src/sdk/types';
import { normalizePreferences } from '../src/plugins/management';
import { normalizeSettings } from '../src/plugins/theme';
import { createPvStage } from '../src/plugins/pv/stage';
import { sprite } from '../src/plugins/pv/paint';
import { mountPluginManager } from '../src/ui/plugin-manager';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('does not refresh the plugin catalog for playback-only state updates', () => {
  let state = { plugins: normalizePreferences(null) } as AppState;
  let update = () => {};
  const list = vi.fn(() => []);
  const api = { list, subscribe: () => () => {}, canRescan: () => false } as unknown as PluginManagement;
  const dispose = mountPluginManager(document.createElement('div'), api, () => state, fn => { update = fn; return () => {}; });
  const before = list.mock.calls.length;
  for (let i = 0; i < 100; i++) { state = { ...state, playback: { positionMs: i, playing: true, rate: 1, observedAtMonoMs: i } }; update(); }
  expect(list.mock.calls.length).toBe(before);
  state = { ...state, plugins: normalizePreferences({ rendererId: 'official.renderer.pv-pop' }) }; update();
  expect(list.mock.calls.length).toBe(before + 1); dispose();
});

it('releases offscreen textures on eviction, document replacement and unmount', () => {
  const gradient = { addColorStop() {} };
  const g = { save() {}, restore() {}, scale() {}, setTransform() {}, clearRect() {}, createLinearGradient: () => gradient,
    fillRect() {} } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g);
  let frame = () => {}, position = 0;
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { frame = fn; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  let state = { settings: normalizeSettings(null), plugins: normalizePreferences(null), playback: { playing: true }, track: {},
    lyrics: { timingMode: 'line', lines: Array.from({ length: 14 }, (_, i) => ({ id: String(i), text: `line ${i}`, startMs: i * 5000, endMs: (i + 1) * 5000 })) } } as AppState;
  const textures: HTMLCanvasElement[] = [];
  const renderer = createPvStage({ id: 'fixture', fonts: [], exitMs: 300, height: () => 100,
    layout() { const value = sprite(1024, 1024, 1, () => {}); textures.push(value.canvas); return value; }, draw() {} }, 'fixture', []);
  const root = document.createElement('div'), dispose = renderer.mount(root, () => state, { position: () => position });
  for (let i = 1; i < 14; i++) { position = i * 5000; frame(); }
  expect(textures.filter(canvas => canvas.width > 0).length).toBeLessThanOrEqual(8);
  expect(textures[0].width).toBe(0);
  const previous = [...textures]; state = { ...state, lyrics: { ...state.lyrics, lines: [{ id: 'new', text: 'new', startMs: 0 }] } }; frame();
  expect(previous.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
  const stage = root.querySelector('canvas')!; dispose();
  expect(stage.width).toBe(0); expect(textures.every(canvas => canvas.width === 0)).toBe(true);
});
