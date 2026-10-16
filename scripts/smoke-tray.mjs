import { chromium, expect } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { go, openPlugin } from './lib/nav.mjs';

const sourceExe = path.resolve(process.argv.find(arg => arg.startsWith('--exe='))?.slice(6) ?? 'src-tauri/target/release/lyrscape.exe');
const output = path.resolve(`qa/tray/${Date.now()}`), port = 9238;
await mkdir(output, { recursive: true });
const exe = path.join(output, 'lyrscape.exe');
await copyFile(sourceExe, exe);
try { await fetch(`http://127.0.0.1:${port}/json/version`); throw Error('CDP port occupied'); }
catch (error) { if (error.message === 'CDP port occupied') throw error; }
const app = spawn(exe, [], { stdio: 'ignore', windowsHide: true, env: { ...process.env,
  WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
const run = promisify(execFile), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = async action => console.log((await run('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/lib/tray-fixture.ps1'), '-AppProcessId', String(app.pid), '-Action', action], { windowsHide: true })).stdout.trim());
const invoke = (page, command, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
let browser, socket;
const samples = [], errors = [];
const processes = async () => JSON.parse((await run('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/lib/process-memory.ps1'), '-RootProcessId', String(app.pid)], { windowsHide: true })).stdout);
const waitForBrowserExit = async () => {
  await expect.poll(async () => (await processes()).filter(row => row.name === 'msedgewebview2.exe').length,
    { timeout: 30000, intervals: [1000, 2000, 3000], message: 'WebView2 exits after the last view is destroyed' }).toBe(0);
};
const attach = async (overlayOnly = false) => {
  await expect.poll(async () => {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); return true; } catch { return false; }
  }, { timeout: 20000 }).toBe(true);
  const context = browser.contexts()[0];
  const matches = page => page.url().startsWith('http://tauri.localhost') && page.url().includes('overlay') === overlayOnly;
  await expect.poll(() => context.pages().some(matches)).toBe(true);
  const main = context.pages().find(matches);
  main.on('pageerror', error => errors.push(error.message));
  if (!overlayOnly) {
    await expect(main.locator('[data-nav]').first()).toBeVisible();
    await expect.poll(async () => (await invoke(main, 'session_restore')).controlActive).toBe(true);
  }
  return main;
};
const sample = async phase => {
  await pause(3000);
  const rows = await processes();
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
  const item = { phase, processes: rows, privateMiB: rows.reduce((n, p) => n + p.privateBytes, 0) / 1048576, targets };
  samples.push(item); console.log(JSON.stringify({ phase, processes: rows.length, privateMiB: item.privateMiB, targets: targets.map(p => ({type:p.type,url:p.url})) }));
};
try {
  let main = await attach();
  await go(main, 'lyrics');
  await main.locator('[data-lyrics]').fill('[00:00.00]托盘保留本地歌词\n[00:20.00]继续播放');
  await main.locator('[data-import]').click();
  await expect(main.locator('.lyric-current').first()).toContainText('托盘保留');
  await sample('control-only');
  await fixture('CloseMain');
  await expect.poll(() => main.isClosed()).toBe(true);
  await sample('tray-no-webviews');
  await waitForBrowserExit();
  if (samples.at(-1).processes.some(row => row.name === 'msedgewebview2.exe')) await sample('tray-no-webviews-settled');
  expect(samples.at(-1).processes.some(row => row.name === 'msedgewebview2.exe')).toBe(false);
  await fixture('TrayOpen');
  main = await attach();
  await expect(main.locator('.lyric-current').first()).toContainText('托盘保留');
  await main.locator('[data-play]').click();
  await fixture('CloseMain');
  await expect.poll(() => main.isClosed()).toBe(true);
  await pause(2000);
  await fixture('TrayOpen');
  main = await attach();
  await expect(main.locator('[data-play]')).toHaveAttribute('aria-label', '暂停');
  expect((await invoke(main, 'session_restore')).snapshot.state.playback.positionMs).toBeGreaterThan(1000);
  await main.locator('[data-play]').click();
  // A real native listener and sender remain connected through destruction and re-creation.
  await main.locator('[data-adapter="amll"]').click();
  await main.locator('[data-port]').fill('12508');
  await main.locator('[data-connect]').click();
  await expect(main.locator('[data-connection-status]')).toHaveText('等待连接');
  socket = new WebSocket('ws://127.0.0.1:12508');
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const send = value => socket.send(JSON.stringify({ type: 'state', value }));
  socket.send(JSON.stringify({ type: 'initialize', value: { protocolVersion: 2 } }));
  send({ update: 'setMusic', musicId: 'tray', musicName: '托盘测试', artists: [], duration: 180000 });
  const lyric = text => ({ update: 'setLyric', format: 'structured', lines: [{ startTime: 0, endTime: 180000, words: [{ startTime: 0, endTime: 180000, word: text }] }] });
  send(lyric('主窗口显示中'));
  send({ update: 'progress', progress: 1200 }); send({ update: 'resumed' });
  await expect(main.locator('.lyric-current').first()).toContainText('主窗口显示中');
  await fixture('CloseMain');
  await expect.poll(() => main.isClosed()).toBe(true);
  send({ update: 'setMusic', musicId: 'no-view', musicName: '没有 WebView 的后台曲目', artists: [], duration: 180000 });
  send(lyric('没有 WebView 也保留新歌曲')); send({ update: 'progress', progress: 6000 }); send({ update: 'paused' });
  await sample('tray-native-amll');
  if (samples.at(-1).processes.some(row => row.name === 'msedgewebview2.exe')) {
    console.log('Waiting for WebView2 process shutdown after repeated control-window recreation…');
    await waitForBrowserExit(); await sample('tray-native-amll-settled');
  }
  expect(samples.at(-1).processes.some(row => row.name === 'msedgewebview2.exe')).toBe(false);
  expect(socket.readyState).toBe(WebSocket.OPEN);
  await fixture('TrayOpen');
  main = await attach();
  await expect(main.locator('.lyric-current').first()).toContainText('没有 WebView 也保留新歌曲');
  // Commit v2, then edit the file to v3 without applying it. Rebuilding views
  // must keep the committed version, including first overlay creation from tray.
  const id = 'qa.renderer.tray';
  const code = version => `export const manifest={id:'${id}',name:'Tray fixture',description:'Native lifecycle fixture',version:'1.0.0',category:'renderer',rendererService:'renderer.qa-tray@1',surfaces:['control','overlay']};export default {id:manifest.id,requires:['sdk@1'],activate(ctx){const sdk=ctx.service('sdk@1');ctx.provide(manifest.rendererService,sdk.ownRenderer(ctx,sdk.createDomRenderer({mount(root){root.dataset.qaTray='${version}';return()=>{delete root.dataset.qaTray}}})));}};`;
  await invoke(main, 'plugin_install', { id, javascript: code('v1'), css: '' });
  await go(main, 'plugins'); await main.locator('[data-plugin-rescan]').click();
  const detail = await openPlugin(main, id);
  await detail.locator('[data-plugin-use]').click();
  await invoke(main, 'plugin_install', { id, javascript: code('v2'), css: '' });
  await detail.locator('[data-plugin-reload-source]').selectOption('local');
  await detail.locator('[data-plugin-reload]').click();
  await expect(detail.locator('[data-plugin-reload]')).toHaveAttribute('title', /成功热重载/);
  await go(main, 'lyrics'); await expect(main.locator('[data-qa-tray="v2"]')).toBeVisible();
  await invoke(main, 'plugin_install', { id, javascript: code('v3'), css: '' });
  const legacyAmllPath = process.argv.find(arg => arg.startsWith('--legacy-amll='))?.slice(14);
  if (legacyAmllPath) {
    const bundles = await invoke(main, 'session_bundles');
    await invoke(main, 'session_bundles', { bundles: [...bundles.filter(bundle => bundle.id !== 'official.adapter.amll'),
      { id: 'official.adapter.amll', javascript: await readFile(legacyAmllPath, 'utf8'), css: '' }] });
    console.log('Included legacy editable AMLL bundle in the restore fixture.');
  }
  await fixture('CloseMain'); await expect.poll(() => main.isClosed()).toBe(true);
  await fixture('TrayOverlay');
  const overlay = await attach(true);
  overlay.on('pageerror', error => errors.push(error.message));
  await expect(overlay.locator('[data-qa-tray="v2"]')).toBeVisible();
  await expect(overlay.locator('.lyric-current')).toContainText('没有 WebView 也保留新歌曲');
  await fixture('TrayOpen'); main = await attach();
  await go(main, 'lyrics'); await expect(main.locator('[data-qa-tray="v2"]')).toBeVisible();
  await sample('both-windows');
  await fixture('CloseMain');
  await expect.poll(() => main.isClosed()).toBe(true);
  send(lyric('主窗口销毁后仍更新')); send({ update: 'progress', progress: 8500 });
  await expect(overlay.locator('.lyric-current')).toContainText('主窗口销毁后仍更新');
  expect(socket.readyState).toBe(WebSocket.OPEN);
  await overlay.evaluate(async () => {
    window.__trayPcm = [];
    const id = window.__TAURI_INTERNALS__.transformCallback(raw => {
      const packet = raw.message;
      if (!(packet instanceof ArrayBuffer)) return;
      const view = new DataView(packet), offset = 40 + view.getUint16(6, true);
      window.__trayPcm.push(Array.from(new Uint8Array(packet, offset)));
      void window.__TAURI_INTERNALS__.invoke('amll_audio_ack', { sequence: Number(view.getBigUint64(16, true)) });
    });
    await window.__TAURI_INTERNALS__.invoke('amll_audio_subscribe', { onAudio: `__CHANNEL__:${id}` });
  });
  const pcm = Buffer.from([0, 128, 255, 127, 1, 0, 255, 255]);
  const wire = Buffer.alloc(6 + pcm.length); wire.writeUInt16LE(0); wire.writeUInt32LE(pcm.length, 2); pcm.copy(wire, 6); socket.send(wire);
  await expect.poll(() => overlay.evaluate(() => window.__trayPcm[0])).toEqual([...pcm]);
  await overlay.screenshot({ path: path.join(output, 'tray-overlay.png'), omitBackground: true });
  await sample('tray-with-overlay');
  await fixture('TrayOpen');
  main = await attach();
  await expect(main.locator('.lyric-current').first()).toContainText('主窗口销毁后仍更新');
  await expect(main.locator('[data-connection-status]')).toHaveText('已连接');
  expect(socket.readyState).toBe(WebSocket.OPEN);
  await invoke(main, 'overlay_update', { visible: false });
  // A hidden overlay remains usable while the control window is absent.
  await fixture('CloseMain');
  send({ update: 'setMusic', musicId: 'next', musicName: '后台新曲目', artists: [], duration: 180000 });
  send(lyric('后台切换新歌曲')); send({ update: 'progress', progress: 42000 }); send({ update: 'paused' });
  await fixture('TrayOpen');
  main = await attach();
  await expect(main.locator('.lyric-current').first()).toContainText('后台切换新歌曲');
  await expect(main.locator('[data-connection-status]')).toHaveText('已连接');
  await go(main, 'settings');
  await main.locator('[data-reset-all]').click();
  await main.locator('dialog button[value="accept"]').click();
  await expect(main.locator('[data-nav]').first()).toBeVisible();
  await expect.poll(async () => (await invoke(main, 'session_restore')).snapshot.state.plugins.rendererId).toBe('official.renderer.text');
  await go(main, 'lyrics');
  await expect(main.locator('.lyric-current').first()).toContainText('后台切换新歌曲');
  await expect(main.locator('[data-connection-status]')).toHaveText('已连接');
  await fixture('TrayQuit');
  await expect.poll(() => app.exitCode !== null).toBe(true);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ samples, errors, complete: true }, null, 2));
  expect(errors).toEqual([]);
  console.log(`PASS: close destroys WebView, empty tray has no browser processes, native tray restores local lyrics/playback, AMLL continues, overlay updates and explicit quit exits. ${output}`);
} finally {
  socket?.close();
  await browser?.close().catch(() => {});
  if (app.exitCode === null) app.kill();
  await writeFile(path.join(output, 'partial.json'), JSON.stringify({ samples, errors }, null, 2));
}
