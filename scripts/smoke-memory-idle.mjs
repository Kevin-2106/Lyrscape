import { chromium, expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { go } from './lib/nav.mjs';

const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const label = arg('label', 'optimized');
if (!/^[a-z0-9-]+$/i.test(label)) throw Error('Invalid label');
const exe = path.resolve(arg('exe', 'src-tauri/target/release/lyrscape.exe'));
const output = path.resolve(`qa/memory-v2/${label}-${Date.now()}`);
const port = Number(arg('port', '9234'));
await mkdir(output, { recursive: true });
// Refuse to attach to a pre-existing browser or application.
try { await fetch(`http://127.0.0.1:${port}/json/version`); throw Error('CDP port is occupied'); }
catch (error) { if (error.message === 'CDP port is occupied') throw error; }
const app = spawn(exe, [], { stdio: 'ignore', windowsHide: true, env: { ...process.env,
  WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const samples = [], errors = [];
let browser;
const invoke = (page, command, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
try {
  for (let i = 0; i < 60; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await pause(250); }
  }
  if (!browser) throw Error('QA browser did not start');
  const context = browser.contexts()[0];
  await expect.poll(() => context.pages().some(page => page.url().startsWith('http://tauri.localhost') && !page.url().includes('overlay'))).toBe(true);
  const main = context.pages().find(page => page.url().startsWith('http://tauri.localhost') && !page.url().includes('overlay'));
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  for (const page of context.pages()) page.on('pageerror', error => errors.push(error.message));
  const sample = async phase => {
    await pause(4000);
    const processes = JSON.parse((await promisify(execFile)('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/lib/process-memory.ps1'), '-RootProcessId', String(app.pid)], { windowsHide: true })).stdout);
    const pages = context.pages().filter(page => !page.isClosed());
    const row = { phase, processes: processes.length,
      privateMB: processes.reduce((sum, row) => sum + row.privateBytes, 0) / 1048576,
      workingMB: processes.reduce((sum, row) => sum + row.workingBytes, 0) / 1048576,
      pages: await Promise.all(pages.map(async page => {
        const session = await context.newCDPSession(page);
        const heap = await session.send('Runtime.getHeapUsage'); await session.detach();
        return { overlay: page.url().includes('overlay'), ...heap,
          ...await page.evaluate(() => ({ fonts: document.fonts.size, loadedFonts: [...document.fonts].filter(face => face.status === 'loaded').length,
            canvases: document.querySelectorAll('canvas').length, fontsRegistered: [...document.querySelectorAll('[data-bundled-font]')].map(style => style.dataset.bundledFont) })) };
      })) };
    samples.push(row); console.log(JSON.stringify(row));
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ label, exe, samples, errors, complete: false }, null, 2));
  };
  await go(main, 'lyrics'); await sample('cold-preview');
  await go(main, 'plugins'); await sample('hidden-overlay');
  await invoke(main, 'overlay_update', { clickThrough: true, borderVisible: true });
  if (label === 'optimized' && await invoke(main, 'overlay_exists')) throw Error('Hidden settings created the overlay');
  await invoke(main, 'overlay_update', { visible: true });
  await expect.poll(() => context.pages().some(page => page.url().includes('overlay'))).toBe(true);
  const overlay = context.pages().find(page => page.url().includes('overlay'));
  await expect(overlay.locator('.lyric-current')).toContainText('让');
  const firstStatus = await invoke(main, 'overlay_status');
  if (!firstStatus.clickThrough || !firstStatus.borderVisible) throw Error('Pre-show overlay flags were lost');
  await overlay.screenshot({ path: path.join(output, 'first-show.png'), omitBackground: true });
  await sample('overlay-visible');
  await invoke(main, 'overlay_update', { visible: false });
  await sample('overlay-hidden-again');
  await invoke(main, 'overlay_update', { visible: true });
  await expect(overlay.locator('.lyric-current')).toContainText('让');
  await invoke(main, 'overlay_update', { visible: false });
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/lib/window-state.ps1'), '-AppProcessId', String(app.pid), '-Mode', 'Minimize'], { windowsHide: true });
  await sample('control-minimized');
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/lib/window-state.ps1'), '-AppProcessId', String(app.pid), '-Mode', 'Restore'], { windowsHide: true });
  await go(main, 'lyrics'); await expect(main.locator('.lyric-current').first()).toContainText('让');
  await sample('control-restored');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ label, exe, samples, errors, complete: true }, null, 2));
  if (errors.length) throw Error(errors.join('; '));
  console.log(`PASS: ${output}`);
} finally { await browser?.close(); app.kill(); }
