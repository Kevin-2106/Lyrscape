import { chromium, expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { go } from './lib/nav.mjs';

const output = path.resolve(process.env.LYRSCAPE_QA_DIR ?? 'qa');
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.LYRSCAPE_CDP ?? 'http://127.0.0.1:9229');
const pages = browser.contexts().flatMap(c => c.pages());
const main = pages.find(p => !p.url().includes('surface=overlay')), overlay = pages.find(p => p.url().includes('surface=overlay'));
if (!main || !overlay) throw Error('Both isolated native windows are required');
const native = (page, command, args) => page.evaluate(([command, args]) => window.__TAURI_INTERNALS__.invoke(command, args), [command, args]);
const press = key => promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/shortcut-fixture.ps1'), '-FunctionKey', String(key)]);
const wait = ms => new Promise(r => setTimeout(r, ms));
let ws, holder;
const ready = path.join(output, `shortcut-holder-${Date.now()}.ready`), stop = `${ready}.stop`;
try {
  await go(main, 'overlay');
  for (const [action, key] of [['visibility', 20], ['clickthrough', 21], ['border', 22]]) {
    await main.locator(`[data-shortcut="${action}"]`).fill(`Ctrl+Alt+Shift+F${key}`);
    await main.locator(`[data-shortcut-apply="${action}"]`).click();
    await expect(main.locator(`[data-shortcut-status="${action}"]`)).toHaveText(`已注册 · Ctrl+Alt+Shift+F${key}`);
  }
  // Actual Windows keystrokes, while another native process owns foreground focus.
  if (!process.env.LYRSCAPE_TEST_PID) throw Error('LYRSCAPE_TEST_PID must identify the isolated QA executable');
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/shortcut-fixture.ps1'), '-Mode', 'Minimize', '-WindowProcessId', process.env.LYRSCAPE_TEST_PID]);
  await expect.poll(() => native(main, 'plugin:window|is_minimized', { label: 'main' })).toBe(true);
  await native(main, 'overlay_update', { visible: false, clickThrough: false, borderVisible: false });
  await press(20); await expect.poll(async () => (await native(main, 'overlay_status')).visible).toBe(true);
  await press(21); await expect.poll(async () => (await native(main, 'overlay_status')).clickThrough).toBe(true);
  await press(22); await expect(overlay.locator('.overlay-adjustment-border')).toBeVisible();
  await expect(main.locator('[data-overlay="borderVisible"]')).toBeChecked();
  await press(21); await expect.poll(async () => (await native(main, 'overlay_status')).clickThrough).toBe(false);
  await expect(overlay.locator('.overlay-resize-handle').first()).toBeVisible();
  await press(20); await expect.poll(async () => (await native(main, 'overlay_status')).visible).toBe(false);
  await press(20); await expect.poll(async () => (await native(main, 'overlay_status')).visible).toBe(true);

  await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/shortcut-fixture.ps1'), '-Mode', 'Restore', '-WindowProcessId', process.env.LYRSCAPE_TEST_PID]);

  await main.locator('[data-shortcut="border"]').fill('Shift+Ctrl+Alt+F20');
  await main.locator('[data-shortcut-apply="border"]').click();
  await expect(main.locator('[data-toasts]')).toContainText('快捷键冲突');
  if (!(await native(main, 'shortcuts_status')).some(b => b.action === 'border' && b.accelerator === 'Ctrl+Alt+Shift+F22' && b.registered)) throw Error('Duplicate binding replaced the working key');
  holder = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/shortcut-fixture.ps1'), '-Mode', 'Hold', '-FunctionKey', '23', '-ReadyFile', ready, '-StopFile', stop], { windowsHide: true, stdio: 'ignore' });
  await expect.poll(async () => { try { await access(ready); return true; } catch { return false; } }).toBe(true);
  await main.locator('[data-shortcut="border"]').fill('Ctrl+Alt+Shift+F23');
  await main.locator('[data-shortcut-apply="border"]').click();
  await expect(main.locator('[data-toasts]')).toContainText('可能被其他程序或系统占用');
  await press(22); await expect(overlay.locator('.overlay-adjustment-border')).toBeHidden();
  await writeFile(stop, 'stop');
  await main.reload(); await go(main, 'overlay');
  await expect(main.locator('[data-shortcut="border"]')).toHaveValue('Ctrl+Alt+Shift+F22');
  await expect(main.locator('[data-shortcut-status="visibility"]')).toContainText('已注册');
  await main.locator('[data-shortcut="border"]').fill('');
  await main.locator('[data-shortcut-apply="border"]').click();
  await expect(main.locator('[data-shortcut-status="border"]')).toHaveText('未注册');
  await press(22); if ((await native(main, 'overlay_status')).borderVisible) throw Error('Unbound shortcut still triggered');
  await main.locator('[data-shortcut="border"]').fill('Ctrl+Alt+Shift+F22');
  await main.locator('[data-shortcut-apply="border"]').click();
  await expect(main.locator('[data-shortcut-status="border"]')).toHaveText('已注册 · Ctrl+Alt+Shift+F22');
  await press(22); await expect(overlay.locator('.overlay-adjustment-border')).toBeVisible();
  await main.screenshot({ path: path.join(output, 'audio-shortcuts-native-settings.png'), fullPage: true });
  await overlay.screenshot({ path: path.join(output, 'audio-shortcuts-native-border.png'), omitBackground: true });

  await go(main, 'lyrics');
  await main.locator('[data-adapter="amll"]').click();
  await main.locator('[data-port]').fill('11445'); await main.locator('[data-connect]').click();
  ws = new WebSocket('ws://127.0.0.1:11445');
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.send(JSON.stringify({ type: 'initialize' }));
  await expect(main.locator('[data-connection-status]')).toHaveText('已连接');
  // Probe the production native audio channel, independently of the state event bus.
  await main.evaluate(async () => {
    window.__pcmProbe = [];
    const id = window.__TAURI_INTERNALS__.transformCallback(raw => {
      let packet = raw.message;
      if (packet instanceof ArrayBuffer) {
        const view = new DataView(packet), sourceLength = view.getUint16(6, true);
        if (view.getUint32(0, true) !== 0x4d43504c || view.getUint8(4) !== 1) throw Error('Invalid LPCM envelope');
        packet = { type: 'pcm', protocolVersion: view.getUint8(5), sequence: Number(view.getBigUint64(16, true)),
          droppedFrames: Number(view.getBigUint64(32, true)), data: Array.from(new Uint8Array(packet, 40 + sourceLength)) };
      }
      if (packet) window.__pcmProbe.push(packet);
    });
    await window.__TAURI_INTERNALS__.invoke('amll_audio_subscribe', { onAudio: `__CHANNEL__:${id}` });
  });
  await expect.poll(() => main.evaluate(() => window.__pcmProbe.find(p => p.type === 'reset')?.connectionId)).toMatch(/^amll-/);
  const bytes = [0, 128, 255, 127, 1, 0, 255, 255];
  const wire = Buffer.alloc(6 + bytes.length); wire.writeUInt16LE(0); wire.writeUInt32LE(bytes.length, 2); Buffer.from(bytes).copy(wire, 6);
  ws.send(wire);
  await expect.poll(() => main.evaluate(() => window.__pcmProbe.filter(p => p.type === 'pcm').length)).toBe(1);
  const first = await main.evaluate(() => window.__pcmProbe.find(p => p.type === 'pcm'));
  expect(first.data).toEqual(bytes); expect(first.protocolVersion).toBe(2);
  for (let i = 0; i < 9; i++) ws.send(wire);
  await wait(250);
  expect(await main.evaluate(() => window.__pcmProbe.filter(p => p.type === 'pcm').length)).toBe(4);
  for (const packet of await main.evaluate(() => window.__pcmProbe.filter(p => p.type === 'pcm'))) await native(main, 'amll_audio_ack', { sequence: packet.sequence });
  ws.send(wire);
  await expect.poll(() => main.evaluate(() => window.__pcmProbe.filter(p => p.type === 'pcm').length)).toBe(5);
  expect(await main.evaluate(() => window.__pcmProbe.filter(p => p.type === 'pcm').at(-1).droppedFrames)).toBe(6);
  await main.locator('[data-adapter="demo"]').click();
  await expect.poll(() => main.evaluate(() => window.__pcmProbe.filter(p => p.type === 'reset').at(-1).connectionId)).toBeNull();
  ws.send(wire); await wait(100);
  expect(await main.evaluate(() => window.__pcmProbe.filter(p => p.type === 'pcm').length)).toBe(5);
  console.log('PASS: actual Windows global toggles, native/overlay state sync, adjustment border, duplicate + other-process registration conflicts, previous key retained, persistence/unbind, exact PCM byte transport, bounded pending blocks/drop counters and selected-source detachment.');
} finally {
  ws?.close(); await writeFile(stop, 'stop');
  await native(main, 'amll_stop').catch(() => {});
  await native(main, 'overlay_update', { visible: false, clickThrough: false, borderVisible: false }).catch(() => {});
  await browser.close();
}
