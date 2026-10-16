import { expect, it } from 'vitest';
import type { AppState } from '../src/sdk/types';
import { restoreSession } from '../src/session';

it('restores a playing imported document across WebView clocks and wraps local playback', () => {
  const state = { adapterId: 'demo', lyrics: { lines: [{ text: '保留导入' }] }, track: { durationMs: 10000 },
    playback: { positionMs: 9000, playing: true, rate: 1, observedAtMonoMs: 900000 } } as AppState;
  const restored = restoreSession({ state, sampleAgeMs: 200, sentAtEpochMs: 1000 }, 100, 3000);
  expect(restored.lyrics).toBe(state.lyrics);
  expect(restored.playback.positionMs).toBe(1200);
  expect(restored.playback.observedAtMonoMs).toBe(100);
});

it('preserves paused positions and the age of an external sample without reusing an old clock', () => {
  const state = { adapterId: 'amll', track: {}, playback: { positionMs: 4200, playing: false, rate: 1, observedAtMonoMs: 900000 } } as AppState;
  const restored = restoreSession({ state, sampleAgeMs: 200, sentAtEpochMs: 1000 }, 100, 3000);
  expect(restored.playback.positionMs).toBe(4200);
  expect(restored.playback.observedAtMonoMs).toBe(-2100);
});
