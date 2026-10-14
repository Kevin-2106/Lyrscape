import { chromium, expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { go } from './lib/nav.mjs';

// Launches its own profile and never connects to the everyday instance.
// Example: node scripts/smoke-memory.mjs --exe=qa/memory/baseline.exe --label=baseline
const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const exe = path.resolve(arg('exe', 'src-tauri/target/release/lyrscape.exe'));
const label = arg('label', 'optimized'), seconds = Number(arg('seconds', '120'));
if (!/^[a-z0-9-]+$/i.test(label) || seconds < 30) throw Error('Invalid label or duration');
const output = path.resolve(`qa/memory/${label}-${Date.now()}`);
await mkdir(output, { recursive: true });
const port = Number(arg('cdp-port', '9231'));
const app = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
  WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
let browser, ws, timer;
const rows = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const invoke = (page, command, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
try {
  for (let i = 0; i < 40; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await wait(250); }
  }
  if (!browser) throw Error('QA WebView2 did not start');
  await expect.poll(() => browser.contexts()[0].pages().filter(p => p.url().startsWith('http://tauri.localhost')).length).toBe(2);
  const pages = browser.contexts()[0].pages();
  const main = pages.find(p => !p.url().includes('surface=overlay')), overlay = pages.find(p => p.url().includes('surface=overlay'));
  if (!main || !overlay) throw Error('Both windows required');
  const errors = [];
  for (const page of pages) page.on('pageerror', error => errors.push(error.message));
  await go(main, 'plugins');
  await main.locator('[data-plugin-id="official.renderer.pv-pop"] [data-plugin-use]').click();
  await invoke(main, 'overlay_update', { visible: true });
  await go(main, 'lyrics');
  await main.locator('[data-adapter="amll"]').click();
  await main.locator('[data-port]').fill('11445'); await main.locator('[data-connect]').click();
  ws = new WebSocket('ws://127.0.0.1:11445');
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.send(JSON.stringify({ type: 'initialize' }));
  const send = value => ws.send(JSON.stringify({ type: 'state', value }));
  send({ update: 'setMusic', musicId: 'memory-qa', musicName: 'Memory fixture', artists: [{ id: 'qa', name: 'Fixture' }], duration: 360000 });
  send({ update: 'setLyric', format: 'structured', lines: Array.from({ length: 60 }, (_, i) => ({
    startTime: i * 5000, endTime: (i + 1) * 5000,
    words: ['夜明けの', '鐘が鳴る', 'まで', '二人で', '走り出そう'].map((word, j) => ({ word, startTime: i * 5000 + j * 900, endTime: i * 5000 + (j + 1) * 900 })),
    translatedLyric: `Synthetic lyric line ${i + 1}`,
  })) });
  send({ update: 'resumed' });
  const pcm = Buffer.alloc(19206); pcm.writeUInt16LE(0); pcm.writeUInt32LE(19200, 2);
  for (let i = 0; i < 4800; i++) { const sample = Math.round(Math.sin(i / 48000 * Math.PI * 110) * 16000); pcm.writeInt16LE(sample, 6 + i * 4); pcm.writeInt16LE(sample, 8 + i * 4); }
  const started = Date.now(); let count = 0;
  timer = setInterval(() => { send({ update: 'progress', progress: Date.now() - started }); if (++count % 2 === 0) ws.send(pcm); }, 50);
  await expect(overlay.locator('[data-pv-style]')).toHaveAttribute('data-pv-style', 'pop');
  await expect.poll(() => overlay.locator('.pv-text').textContent()).toContain('夜明け');
  await go(main, 'plugins');
  const sessions = await Promise.all(pages.map(page => page.context().newCDPSession(page)));
  const processMemory = async () => JSON.parse((await promisify(execFile)('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/lib/process-memory.ps1'), '-RootProcessId', String(app.pid)], { windowsHide: true })).stdout);
  for (let elapsed = 0; elapsed <= seconds; elapsed += 15) {
    const processes = await processMemory();
    const sample = { elapsed: Date.now() - started,
      privateMB: processes.reduce((sum, p) => sum + p.privateBytes, 0) / 1048576,
      workingMB: processes.reduce((sum, p) => sum + p.workingBytes, 0) / 1048576,
      heaps: await Promise.all(sessions.map(async (session, i) => ({ overlay: pages[i] === overlay,
        ...await session.send('Runtime.getHeapUsage'), ...await session.send('Memory.getDOMCounters') }))) };
    rows.push(sample); console.log(JSON.stringify(sample));
    if (elapsed < seconds) await wait(15000);
  }
  // A hidden surface should release its renderer, then mount at the current lyric on show.
  await invoke(main, 'overlay_update', { visible: false }); await wait(250);
  const hiddenCanvases = await overlay.locator('canvas').count();
  await invoke(main, 'overlay_update', { visible: true });
  await expect(overlay.locator('[data-pv-style]')).toHaveAttribute('data-pv-style', 'pop');
  await overlay.screenshot({ path: path.join(output, 'overlay.png'), omitBackground: true });
  const painted = await overlay.locator('canvas').evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 20) count++; return count;
  });
  if (painted < 100) throw Error('Overlay did not paint the lyric fixture');
  if (label === 'optimized' && hiddenCanvases !== 0) throw Error('Hidden renderer still mounted');
  // Only after the natural-memory samples: retained memory distinguishes leaks from GC lag.
  const retained = await Promise.all(sessions.map(async (session, i) => { await session.send('HeapProfiler.collectGarbage'); return { overlay: pages[i] === overlay, ...await session.send('Runtime.getHeapUsage') }; }));
  const report = { label, exe, seconds, rows, retained, hiddenCanvases, painted, errors };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (errors.length) throw Error(`Page errors: ${errors.join('; ')}`);
  console.log(`PASS: ${label}; report ${path.join(output, 'report.json')}`);
} finally {
  clearInterval(timer); ws?.close(); await browser?.close(); app.kill();
}
