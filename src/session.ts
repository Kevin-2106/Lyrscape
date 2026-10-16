import type { AppState, PlaybackSnapshot } from './sdk/types';

export interface SessionSnapshot {
  state: AppState;
  sampleAgeMs: number;
  sentAtEpochMs: number;
  demoSnapshot?: PlaybackSnapshot;
}

/** Monotonic clocks belong to a WebView; only the age crosses its lifetime boundary. */
export function restoreSession(snapshot: SessionSnapshot, now = performance.now(), epoch = Date.now()): AppState {
  const age = Math.max(0, snapshot.sampleAgeMs) + Math.max(0, epoch - snapshot.sentAtEpochMs);
  const state = snapshot.state;
  let playback = { ...state.playback, observedAtMonoMs: now - age };
  if (state.adapterId === 'demo' && playback.playing && state.track.durationMs && state.track.durationMs > 0) {
    playback = { ...playback, positionMs: (playback.positionMs + age * playback.rate) % state.track.durationMs, observedAtMonoMs: now };
  }
  return { ...state, playback };
}
