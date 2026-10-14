import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { go } from './lib/nav.mjs';

// Native-only, isolated instance only (fixture port 11445): streams a synthetic
// 120 BPM kick as AMLL V2 PCM in real time and checks that the beat detector in
// both windows locks on and drives the PV renderer, then stops on pause / silence.
if (!process.env.LYRSCAPE_CDP) throw Error('Set LYRSCAPE_CDP to the isolated QA instance (never the everyday instance)');
const output = process.env.LYRSCAPE_QA_DIR ?? path.resolve('qa/beat');
await mkdir(output, { recursive: true });
const RATE = 48000, BLOCK = 4800, BPM = 120;
const browser = await chromium.connectOverCDP(process.env.LYRSCAPE_CDP);
const context = browser.contexts()[0];
const main = context.pages().find(page => !page.url().includes('surface=overlay'));
let ws, timer;
const send = value => ws.send(JSON.stringify({ type: 'state', value }));
let frame = 0, seed = 11;
/** One 100 ms V2 binary audio block (magic 0, u32 length, i16le stereo). */
const block = () => {
  const pcm = Buffer.alloc(BLOCK * 4), beat = 60 / BPM * RATE;
  for (let i = 0; i < BLOCK; i++, frame++) {
    const since = frame % beat, t = since / RATE;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const value = Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 18) * 0.8 + (since < 48 ? 0.45 : 0) + (seed / 0x7fffffff - 0.5) * 0.04;
    const sample = Math.round(Math.max(-1, Math.min(1, value)) * 32000);
    pcm.writeInt16LE(sample, i * 4); pcm.writeInt16LE(sample, i * 4 + 2);
  }
  const wire = Buffer.alloc(6 + pcm.length); wire.writeUInt16LE(0); wire.writeUInt32LE(pcm.length, 2); pcm.copy(wire, 6);
  return wire;
};
// Paced by the wall clock like a real player: Windows timers fire late, and a
// fixed interval would play the "song" ~10% slow.
const stream = on => {
  clearInterval(timer);
  if (!on) return;
  const start = Date.now() - 100; let sent = 0;
  timer = setInterval(() => { while (sent * BLOCK / RATE * 1000 <= Date.now() - start) { ws.send(block()); sent++; } }, 20);
};

try {
  await main.bringToFront();
  const overlayPage = async () => {
    await main.evaluate(() => window.__TAURI_INTERNALS__.invoke('overlay_update', { visible: true, clickThrough: false, alwaysOnTop: true }));
    await expect.poll(() => context.pages().some(page => page.url().includes('surface=overlay'))).toBe(true);
    return context.pages().find(page => page.url().includes('surface=overlay'));
  };
  const overlay = await overlayPage();
  await go(main, 'plugins');
  const use = main.locator('[data-plugin-id="official.renderer.pv-pop"] [data-plugin-use]');
  if (await use.isEnabled()) await use.click();
  await go(main, 'lyrics');
  await main.locator('[data-adapter="amll"]').click();
  // A previous run may have left the fixture listener up; only (re)start it when allowed.
  if (await main.locator('[data-connect]').isEnabled()) { await main.locator('[data-port]').fill('11445'); await main.locator('[data-connect]').click(); }
  ws = new WebSocket('ws://127.0.0.1:11445');
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.send(JSON.stringify({ type: 'initialize' }));
  await expect(main.locator('[data-connection-status]')).toHaveText('已连接');
  send({ update: 'setMusic', musicId: 'beat-qa', musicName: 'Beat fixture', albumId: '', albumName: '', artists: [{ id: 'qa', name: 'Fixture' }], duration: 120000 });
  send({ update: 'setLyric', format: 'structured', lines: [{ startTime: 0, endTime: 110000, words: [{ word: '鼓点に合わせて', startTime: 0, endTime: 110000 }] }] });
  send({ update: 'progress', progress: 500 }); send({ update: 'resumed' });
  const stages = [main.locator('#lyrics-preview'), overlay.locator('[data-pv-style]')];
  for (const stage of stages) await expect(stage).toHaveAttribute('data-pv-style', 'pop');
  await expect(stages[0]).toHaveAttribute('data-pv-beat', '');

  console.log('Streaming 120 BPM PCM…');
  const started = Date.now();
  stream(true);
  for (const stage of stages) {
    await expect.poll(async () => Number(await stage.getAttribute('data-pv-beat')), { timeout: 15000, message: 'beat locks to the PCM tempo' })
      .toBeGreaterThanOrEqual(BPM - 2);
    const bpm = Number(await stage.getAttribute('data-pv-beat'));
    expect(bpm).toBeLessThanOrEqual(BPM + 2);
  }
  console.log(`Locked in both windows after ${Date.now() - started} ms`);
  await overlay.waitForTimeout(3000); // confidence settles before effects reach full strength
  // Measure the beat in the pixels: the top edge of the painted glyphs should hop once per beat.
  const series = await overlay.locator('[data-pv-style] canvas').evaluate(canvas => new Promise(resolve => {
    const g = canvas.getContext('2d'), rows = [], t0 = performance.now();
    const step = () => {
      const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
      let top = canvas.height;
      for (let y = 0, found = false; y < canvas.height && !found; y++) for (let x = 0; x < canvas.width; x += 2) if (data[(y * canvas.width + x) * 4 + 3] > 200) { top = y; found = true; break; }
      rows.push([Math.round(performance.now() - t0), top]);
      if (performance.now() - t0 < 2000) requestAnimationFrame(step); else resolve(rows);
    };
    requestAnimationFrame(step);
  }));
  await writeFile(path.join(output, 'top-edge.json'), JSON.stringify(series));
  const tops = series.map(([, top]) => top), span = Math.max(...tops) - Math.min(...tops);
  // Hop onsets: rising crossings of half the travel, debounced so a hop's tail is not counted twice.
  const rest = Math.max(...tops), onsets = [];
  series.forEach(([time, top], i) => {
    const lifted = rest - top > span * 0.5, before = i > 0 && rest - series[i - 1][1] > span * 0.5;
    if (lifted && !before && (!onsets.length || time - onsets.at(-1) > 300)) onsets.push(time);
  });
  const gaps = onsets.slice(1).map((time, i) => time - onsets[i]);
  console.log(`Top edge moves ${span}px; hop onsets ${onsets.join(', ')} ms`);
  expect(span, 'beat visibly moves the glyphs').toBeGreaterThan(4);
  expect(onsets.length, '~4 hops in 2 s at 120 BPM').toBeGreaterThanOrEqual(3);
  for (const gap of gaps) expect(Math.abs(gap - 500), 'one hop per 500 ms beat').toBeLessThan(40);
  await overlay.locator('[data-pv-style]').screenshot({ path: path.join(output, 'beat.png'), omitBackground: true });

  // A player stops sending audio when paused; the host also resets the stream on 'paused'.
  stream(false); send({ update: 'paused' });
  for (const stage of stages) await expect(stage, 'pause stops beat effects').toHaveAttribute('data-pv-beat', '');
  // Track change without 'resumed' (seen with a real connector): audio alone re-enables the beat.
  send({ update: 'setMusic', musicId: 'beat-qa-2', musicName: 'Beat fixture 2', albumId: '', albumName: '', artists: [], duration: 120000 });
  send({ update: 'progress', progress: 500 }); stream(true);
  for (const stage of stages) await expect.poll(async () => Number(await stage.getAttribute('data-pv-beat')), { timeout: 15000, message: 'beat follows audio after a track change' }).toBeGreaterThan(0);
  stream(false);
  for (const stage of stages) await expect(stage, 'silence stops beat effects').toHaveAttribute('data-pv-beat', '', { timeout: 3000 });
  console.log('PASS: native AMLL V2 PCM → audio.pcm@1 → audio.beat@1 in main and overlay, ~120 BPM lock, glyphs hop once per beat in the overlay pixels, pause, track change without resume and silence.');
} finally {
  stream(false); ws?.close();
  await main.locator('[data-adapter="demo"]').click().catch(() => {});
  await browser.close();
}
