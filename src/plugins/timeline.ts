import type { AppState, Timeline } from '../sdk/types';
import type { Plugin } from '../kernel/host';

export const timeline: Timeline = {
  position(state: AppState, nowMonoMs = performance.now()) {
    const sample = state.playback;
    const elapsed = Math.max(0, nowMonoMs - sample.observedAtMonoMs);
    // External stale samples stop extrapolating after five seconds; demo runs locally.
    const delta = state.adapterId === 'amll' ? Math.min(elapsed, 5000) : elapsed;
    const position = sample.positionMs + (sample.playing ? delta * sample.rate : 0);
    return Math.max(0, Math.min(position, state.track.durationMs ?? Number.MAX_SAFE_INTEGER));
  },
};
export const timelinePlugin: Plugin = {
  id: 'official.timeline.default', activate(ctx) { ctx.provide('timeline@1', timeline); },
};
