import type { Plugin, PluginContext } from '../kernel/host';
import type { Store } from '../kernel/store';
import type { AppState, AudioAnalysis, BeatDetector, BeatSample, PcmAudio, PcmFrame } from '../sdk/types';
import { BEAT_DETECTOR, beatFields, normalizeConfig } from './management';

// Analysis runs on a 12 kHz mono downmix: 512-point frames, 128-sample hops
// (10.67 ms, 93.75 onset values per second).
const DECIMATE = 4, RATE = 48000 / DECIMATE, N = 512, HOP = 128;
const HOP_MS = HOP / RATE * 1000, ENV_HZ = RATE / HOP;
const HISTORY = 768;          // ~8.2 s of onset envelope for tempo
const PHASE_WINDOW = 384;     // ~4.1 s for phase alignment
const MIN_BPM = 60, MAX_BPM = 200;
const SILENT: BeatSample = { active: false, bpm: 0, confidence: 0, phase: 0, index: 0, pulse: 0, level: 0 };

/** In-place iterative radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array, cos: Float32Array, sin: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) for (let k = 0; k < half; k++) {
      const c = cos[k * step], s = sin[k * step], a = start + k, b = a + half;
      const tr = re[b] * c + im[b] * s, ti = im[b] * c - re[b] * s;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}

/**
 * Onset-envelope beat tracker. Spectral flux (log magnitude, bass weighted) feeds
 * an autocorrelation tempo estimate with a prior around 120 BPM; phase comes from
 * matching a pulse train against the recent envelope and is smoothed like a PLL,
 * so beats keep being predicted between bursty PCM blocks.
 */
export function createBeatTracker() {
  const window = new Float32Array(N), cos = new Float32Array(N / 2), sin = new Float32Array(N / 2);
  for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = Math.sin(2 * Math.PI * i / N); }
  const re = new Float32Array(N), im = new Float32Array(N);
  // Visualiser features: a long FFT for pitch classes, coarse bands, and a short waveform.
  const LONG = 4096, history = new Float32Array(LONG);
  const longRe = new Float32Array(LONG), longIm = new Float32Array(LONG);
  const longCos = new Float32Array(LONG / 2), longSin = new Float32Array(LONG / 2), longWindow = new Float32Array(LONG);
  for (let i = 0; i < LONG / 2; i++) { longCos[i] = Math.cos(2 * Math.PI * i / LONG); longSin[i] = Math.sin(2 * Math.PI * i / LONG); }
  for (let i = 0; i < LONG; i++) longWindow[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / LONG);
  // Pitch class of each long-FFT bin from 55 Hz to 4 kHz (-1 outside).
  const pitchOf = new Int8Array(LONG / 2).fill(-1);
  for (let k = 1; k < LONG / 2; k++) {
    const f = k * RATE / LONG;
    if (f >= 55 && f <= 4000) pitchOf[k] = ((Math.round(12 * Math.log2(f / 440)) + 9) % 12 + 12) % 12;
  }
  const BANDS = 24, bandEdges: number[] = [];
  for (let b = 0; b <= BANDS; b++) bandEdges.push(Math.max(1, Math.round(60 * (5500 / 60) ** (b / BANDS) * N / RATE)));
  const chroma = new Array<number>(12).fill(0), bands = new Array<number>(BANDS).fill(0);
  let historyAt = 0, bandPeak = 1e-3, sinceChroma = 0;
  const bins = 200; // up to ~4.7 kHz
  let previous = new Float32Array(bins), current = new Float32Array(bins);
  const samples = new Float32Array(N * 2);
  const envelope = new Float32Array(HISTORY);
  let filled = 0, envCount = 0, hops = 0, mean = 0, peak = 1e-3, level = 0, loudness = 0;
  let anchor = NaN, total = 0, carry = 0, carried = 0, lastReceived = -Infinity, lastSequence = -1;
  let period = 0, candidate = 0, confidence = 0, reference = NaN, sinceTempo = 0, sincePhase = 0;

  /** Monotonic time of the centre of hop `h` (12 kHz stream samples since the anchor). */
  const hopTime = (h: number) => anchor + (h * HOP + N / 2) / RATE * 1000;
  const env = (back: number) => envelope[((envCount - 1 - back) % HISTORY + HISTORY) % HISTORY];

  const clearSignal = () => {
    filled = 0; envCount = 0; hops = 0; mean = 0; total = 0; carry = 0; carried = 0; anchor = NaN; reference = NaN;
    previous.fill(0); sinceTempo = 0; sincePhase = 0;
    history.fill(0); chroma.fill(0); bands.fill(0); sinceChroma = 0;
  };

  function estimateTempo() {
    const length = Math.min(envCount, HISTORY);
    if (length < 256) return;
    const series = new Float32Array(length);
    let average = 0;
    // A light [1 2 1] blur lets fractional-hop periods (e.g. 150 BPM = 37.5 hops) correlate fully.
    for (let i = 0; i < length; i++) {
      const back = length - 1 - i;
      series[i] = (env(Math.min(length - 1, back + 1)) + 2 * env(back) + env(Math.max(0, back - 1))) / 4;
      average += series[i];
    }
    average /= length;
    for (let i = 0; i < length; i++) series[i] -= average;
    const ac = (lag: number) => {
      let sum = 0;
      for (let i = lag; i < length; i++) sum += series[i] * series[i - lag];
      return sum / (length - lag);
    };
    const zero = ac(0);
    if (zero <= 1e-9) return;
    const lo = Math.floor(ENV_HZ * 60 / MAX_BPM), hi = Math.ceil(ENV_HZ * 60 / MIN_BPM);
    const scores: number[] = [];
    let best = -1, bestScore = -Infinity;
    for (let lag = lo; lag <= hi; lag++) {
      const bpm = ENV_HZ * 60 / lag;
      const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.8) ** 2);
      const score = (ac(lag) + (lag * 2 < length / 2 ? 0.5 * ac(lag * 2) : 0)) / zero * prior;
      scores[lag] = score;
      if (score > bestScore) { bestScore = score; best = lag; }
    }
    if (best < 0) return;
    // Parabolic refinement between neighbouring lags.
    const a = scores[best - 1] ?? bestScore, c = scores[best + 1] ?? bestScore;
    const shift = a - 2 * bestScore + c < 0 ? 0.5 * (a - c) / (a - 2 * bestScore + c) : 0;
    let lagMs = (best + Math.max(-0.5, Math.min(0.5, shift))) * HOP_MS;
    // Octave hysteresis: kick-on-1 / snare-on-2 music scores half and double tempo
    // almost equally. Once a tempo is established, read an octave jump as agreement.
    if (period) for (const ratio of [2, 0.5]) if (Math.abs(lagMs * ratio - period) / period < 0.04) lagMs *= ratio;
    const strength = Math.max(0, Math.min(1, (ac(best) / zero - 0.04) * 3));
    confidence = confidence * 0.5 + strength * 0.5;
    if (!period || Math.abs(lagMs - period) / period < 0.04) { period = period ? period * 0.8 + lagMs * 0.2 : lagMs; candidate = 0; }
    // A different tempo must be seen twice in a row before replacing the current one.
    else if (candidate && Math.abs(lagMs - candidate) / candidate < 0.04) { period = lagMs; candidate = 0; reference = NaN; }
    else candidate = lagMs;
  }

  function estimatePhase() {
    if (!period) return;
    const p = period / HOP_MS, length = Math.min(envCount, PHASE_WINDOW);
    if (length < p * 2) return;
    let best = 0, bestScore = -Infinity;
    for (let offset = 0; offset < p; offset += 0.5) {
      let score = 0, weight = 1;
      for (let back = offset; back < length - 1; back += p, weight *= 0.85) {
        const i = Math.floor(back), f = back - i;
        score += weight * (env(i) * (1 - f) + env(i + 1) * f);
      }
      if (score > bestScore) { bestScore = score; best = offset; }
    }
    const measured = hopTime(hops - 1 - best);
    if (Number.isNaN(reference)) { reference = measured; return; }
    const k = Math.round((measured - reference) / period), predicted = reference + k * period;
    reference = predicted + 0.35 * (measured - predicted);
  }

  function updateChroma() {
    for (let i = 0; i < LONG; i++) { longRe[i] = history[(historyAt + i) % LONG] * longWindow[i]; longIm[i] = 0; }
    fft(longRe, longIm, longCos, longSin);
    const next = new Array<number>(12).fill(0);
    // Energy per pitch class: tonal peaks dominate, the many quiet bins between them do not.
    for (let k = 1; k < LONG / 2; k++) if (pitchOf[k] >= 0) next[pitchOf[k]] += longRe[k] * longRe[k] + longIm[k] * longIm[k];
    const top = Math.max(...next, 1e-12);
    for (let c = 0; c < 12; c++) chroma[c] += (Math.sqrt(next[c] / top) - chroma[c]) * 0.5;
  }

  function processHop() {
    for (let i = 0; i < N; i++) { re[i] = samples[i] * window[i]; im[i] = 0; }
    let energy = 0;
    for (let i = 0; i < N; i++) energy += samples[i] * samples[i];
    fft(re, im, cos, sin);
    for (let b = 0; b < BANDS; b++) {
      let sum = 0;
      for (let k = bandEdges[b]; k < Math.max(bandEdges[b] + 1, bandEdges[b + 1]); k++) sum += Math.hypot(re[k], im[k]);
      bands[b] = Math.log1p(sum);
    }
    bandPeak = Math.max(bandPeak * 0.9995, ...bands);
    if (++sinceChroma >= 8) { sinceChroma = 0; updateChroma(); }
    let flux = 0, bass = 0;
    for (let k = 1; k < bins; k++) {
      current[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const rise = Math.max(0, current[k] - previous[k]);
      flux += rise; if (k < 10) bass += rise;
    }
    [previous, current] = [current, previous];
    const onset = flux + bass * 4;
    // Remove the slow-moving mean so sustained loudness does not read as onsets.
    mean += (onset - mean) * 0.03;
    envelope[envCount % HISTORY] = Math.max(0, onset - mean);
    envCount++; hops++;
    const rms = Math.sqrt(energy / N);
    peak = Math.max(rms, peak * 0.9995, 1e-3);
    level += (Math.min(1, rms / peak) - level) * 0.1;
    // Slow loudness (~1.5 s) gates the pulse: quiet passages fade it out, gaps between kicks do not.
    loudness += (Math.min(1, rms / peak) - loudness) * 0.007;
    if (++sinceTempo >= 48) { sinceTempo = 0; estimateTempo(); }
    if (++sincePhase >= 12) { sincePhase = 0; estimatePhase(); }
  }

  return {
    push(frame: PcmFrame) {
      const frames = frame.frameCount, bytes = frame.data;
      // Lost blocks or a stalled stream break the sample clock; restart the signal but keep the tempo.
      if (frame.droppedFrames > 0 || frame.sequence !== lastSequence + 1 && lastSequence >= 0 || frame.receivedAtMonoMs - lastReceived > 1000) {
        clearSignal(); confidence *= 0.5;
      }
      lastSequence = frame.sequence;
      // The newest sample is heard no later than it arrives: anchor to the earliest
      // consistent arrival and let the anchor creep forward slowly for clock skew.
      const end = total + (carried + frames) / DECIMATE;
      const estimate = frame.receivedAtMonoMs - end / RATE * 1000;
      if (Number.isNaN(anchor) || estimate < anchor) anchor = estimate;
      else anchor += Math.min(estimate - anchor, 0.002 * Math.max(0, frame.receivedAtMonoMs - lastReceived));
      lastReceived = frame.receivedAtMonoMs;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      // Box-filter downmix; a partial group carries over to the next block.
      for (let i = 0; i < frames; i++) {
        carry += view.getInt16(i * 4, true) + view.getInt16(i * 4 + 2, true);
        if (++carried < DECIMATE) continue;
        samples[filled++] = carry / (DECIMATE * 2 * 32768);
        history[historyAt] = samples[filled - 1]; historyAt = (historyAt + 1) % LONG;
        carry = 0; carried = 0; total++;
        if (filled === N) { processHop(); samples.copyWithin(0, HOP, N); filled = N - HOP; }
      }
    },
    analysis(at: number): AudioAnalysis | undefined {
      if (at - lastReceived > 700 || !envCount) return undefined;
      const wave: number[] = [];
      for (let i = 0; i < 128; i++) wave.push(history[(historyAt - 1024 + i * 8 + LONG * 2) % LONG]);
      return { chroma: [...chroma], bands: bands.map(value => Math.min(1, value / bandPeak)), wave };
    },
    reset() { clearSignal(); lastSequence = -1; lastReceived = -Infinity; level = 0; loudness = 0; confidence *= 0.5; },
    sample(at: number, offsetMs = 0): BeatSample {
      if (!period || Number.isNaN(reference) || at - lastReceived > 700) return SILENT;
      const t = at - offsetMs, beats = (t - reference) / period, index = Math.floor(beats), phase = beats - index;
      const trust = Math.max(0, Math.min(1, (confidence - 0.12) / 0.4)) * Math.min(1, loudness * 5);
      return { active: true, bpm: 60000 / period, confidence, phase, index, level,
        pulse: Math.exp(-phase * period / 150) * trust };
    },
  };
}

/** The detector is optional and hot-reloadable, so consumers look it up per frame instead of requiring it. */
export const optionalBeat = (ctx: PluginContext) => (): BeatDetector | undefined => {
  try { return ctx.service<BeatDetector>('audio.beat@1'); } catch { return undefined; }
};

export function beatPlugin(store: Store<AppState>): Plugin {
  return {
    id: BEAT_DETECTOR, requires: ['audio.pcm@1'],
    activate(ctx) {
      const tracker = createBeatTracker();
      ctx.own(ctx.service<PcmAudio>('audio.pcm@1').subscribe(frame => frame ? tracker.push(frame) : tracker.reset()));
      ctx.provide<BeatDetector>('audio.beat@1', {
        sample(at = performance.now()) {
          const state = store.get();
          // The overlay hosts its own instance; honour the main window's enable switch.
          if (state.plugins.enabled[BEAT_DETECTOR] === false) return SILENT;
          return tracker.sample(at, Number(normalizeConfig(beatFields, state.plugins.configs[BEAT_DETECTOR]).offset));
        },
        analysis(at = performance.now()) {
          return store.get().plugins.enabled[BEAT_DETECTOR] === false ? undefined : tracker.analysis(at);
        },
      });
    },
  };
}
