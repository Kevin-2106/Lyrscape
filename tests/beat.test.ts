import { expect, it } from 'vitest';
import type { PcmFrame } from '../src/sdk/types';
import { createBeatTracker } from '../src/plugins/beat';

const RATE = 48000, BLOCK = 4800; // 100 ms blocks

/** Kick drum (decaying 55 Hz thump + click) on every beat, quiet hi-hat noise between. */
function song(bpm: number, seconds: number, firstBeatMs = 0) {
  const total = Math.round(seconds * RATE), beat = 60 / bpm * RATE, first = firstBeatMs / 1000 * RATE;
  const samples = new Int16Array(total * 2);
  let seed = 7;
  for (let i = 0; i < total; i++) {
    const since = (i - first) % beat, t = since / RATE;
    const kick = i >= first ? Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 18) + (since < 48 ? 0.6 : 0) : 0;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const value = Math.max(-1, Math.min(1, kick * 0.8 + (seed / 0x7fffffff - 0.5) * 0.04));
    samples[i * 2] = samples[i * 2 + 1] = Math.round(value * 32000);
  }
  return samples;
}

function feed(tracker: ReturnType<typeof createBeatTracker>, samples: Int16Array, t0 = 1000, firstSequence = 0) {
  let sequence = firstSequence;
  for (let start = 0; start < samples.length / 2; start += BLOCK) {
    const frames = Math.min(BLOCK, samples.length / 2 - start);
    const data = new Uint8Array(samples.buffer, samples.byteOffset + start * 4, frames * 4);
    // Each block arrives when its last sample is due; the tracker anchors to that.
    tracker.push({ sourceId: 'amll-1', revision: 1, sequence: sequence++, droppedFrames: 0, frameCount: frames, data,
      receivedAtMonoMs: t0 + (start + frames) / RATE * 1000, receivedAtEpochMs: 0,
      format: { sampleRate: 48000, channels: 2, sampleFormat: 'i16le', interleaved: true, basis: 'amll-v1-spec' } } satisfies PcmFrame);
  }
  return t0 + samples.length / 2 / RATE * 1000;
}

for (const bpm of [92, 120, 150]) {
  it(`locks tempo and phase to a ${bpm} BPM kick`, () => {
    const tracker = createBeatTracker(), t0 = 1000, offset = 130;
    const end = feed(tracker, song(bpm, 12, offset), t0);
    const sample = tracker.sample(end);
    expect(sample.active).toBe(true);
    expect(Math.abs(sample.bpm - bpm)).toBeLessThan(bpm * 0.02);
    expect(sample.confidence).toBeGreaterThan(0.3);
    // Phase at a real kick (the last one in the stream) is within ~40 ms of the beat.
    const period = 60000 / bpm;
    const lastKick = t0 + offset + Math.floor((end - t0 - offset) / period) * period;
    const phase = tracker.sample(lastKick).phase;
    const error = Math.min(phase, 1 - phase) * period;
    expect(error).toBeLessThan(40);
    expect(tracker.sample(lastKick + 5).pulse).toBeGreaterThan(0.5);
    // ~150 ms decay: mostly gone 300 ms later (every tested period is longer than that).
    expect(tracker.sample(lastKick + 300).pulse).toBeLessThan(0.2);
  });
}

it('stays quiet without periodic audio, after a reset and when audio stops', () => {
  const noise = new Int16Array(RATE * 2 * 8);
  let seed = 3;
  for (let i = 0; i < noise.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noise[i] = (seed / 0x7fffffff - 0.5) * 20000; }
  const tracker = createBeatTracker();
  const end = feed(tracker, noise);
  expect(tracker.sample(end).pulse).toBeLessThan(0.2);

  const beats = createBeatTracker();
  const stop = feed(beats, song(120, 10));
  expect(beats.sample(stop).active).toBe(true);
  expect(beats.sample(stop + 800).active).toBe(false);
  beats.reset();
  expect(beats.sample(stop).active).toBe(false);
});

it('does not flip between half and double tempo when backbeats are as strong as kicks', () => {
  // Kick on beats 1/3 and an equally loud snare-like burst on 2/4: 85 and 170 BPM both fit.
  const kick = song(85, 24), snare = song(85, 24, 60000 / 170);
  const mix = new Int16Array(kick.length);
  for (let i = 0; i < mix.length; i++) mix[i] = Math.max(-32000, Math.min(32000, kick[i] + snare[i]));
  const tracker = createBeatTracker();
  const seen = new Set<number>();
  for (let second = 0; second < 24; second++) {
    const end = feed(tracker, mix.subarray(second * RATE * 2, (second + 1) * RATE * 2), 1000 + second * 1000, second * RATE / BLOCK);
    const sample = tracker.sample(end);
    if (second >= 6 && sample.active) seen.add(Math.round(sample.bpm / 5) * 5);
    if (process.env.BEAT_DEBUG) console.log(second, sample.active, sample.bpm.toFixed(1), sample.confidence.toFixed(2));
  }
  expect(seen.size).toBe(1);
  expect([85, 170]).toContain([...seen][0]);
});

it('derives pitch classes, bands and a waveform from live PCM', () => {
  const tone = (freqs: number[], seconds: number) => {
    const out = new Int16Array(Math.round(seconds * RATE) * 2);
    for (let i = 0; i < out.length / 2; i++) {
      const v = freqs.reduce((sum, f) => sum + Math.sin(2 * Math.PI * f * i / RATE), 0) / freqs.length;
      out[i * 2] = out[i * 2 + 1] = Math.round(v * 20000);
    }
    return out;
  };
  const lit = (chroma: number[]) => chroma.map((value, i) => [value, i]).filter(([value]) => value > 0.6).map(([, i]) => i).sort((a, b) => a - b);
  const a = createBeatTracker();
  const endA = feed(a, tone([440], 2));
  const analysis = a.analysis(endA)!;
  expect(lit(analysis.chroma)).toEqual([9]); // A
  expect(analysis.bands).toHaveLength(24);
  expect(analysis.wave).toHaveLength(128);
  expect(Math.max(...analysis.wave.map(Math.abs))).toBeGreaterThan(0.3);
  const c = createBeatTracker();
  const endC = feed(c, tone([261.63, 329.63, 392.0], 2));
  expect(lit(c.analysis(endC)!.chroma)).toEqual([0, 4, 7]); // C E G
  expect(c.analysis(endC + 800)).toBeUndefined();
});
