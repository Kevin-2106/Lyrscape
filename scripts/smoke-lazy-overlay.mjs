import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { go, openPlugin } from './lib/nav.mjs';

if (!process.env.LYRSCAPE_CDP) throw Error('Set the isolated native QA endpoint');
const browser = await chromium.connectOverCDP(process.env.LYRSCAPE_CDP);
try {
  const context = browser.contexts()[0], main = context.pages().find(page => !page.url().includes('overlay'));
  const invoke = (command, args) => main.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
  await expect(main.locator('[data-nav]').first()).toBeVisible();
  expect(await invoke('overlay_exists')).toBe(false);
  await invoke('overlay_update', { clickThrough: true, borderVisible: true });
  expect(await invoke('overlay_exists')).toBe(false);
  // Reloading before the overlay exists must commit locally, without an 8s peer timeout.
  const detail = await openPlugin(main, 'official.renderer.aurora');
  await detail.locator('[data-plugin-reload-source]').selectOption('source');
  await detail.locator('[data-plugin-reload]').click();
  await expect(detail.locator('[data-plugin-reload]')).toHaveAttribute('title', /已成功热重载 1 次/);
  expect(await invoke('overlay_exists')).toBe(false);
  const use = detail.locator('[data-plugin-use]'); if (await use.isEnabled()) await use.click();
  await invoke('shortcut_set', { action: 'visibility', accelerator: 'Ctrl+Alt+Shift+F20' });
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/shortcut-fixture.ps1'), '-FunctionKey', '20'], { windowsHide: true });
  await expect.poll(() => invoke('overlay_exists'), { timeout: 10000 }).toBe(true);
  await expect.poll(async () => (await invoke('overlay_status')).visible).toBe(true);
  await expect.poll(() => context.pages().some(page => page.url().includes('overlay'))).toBe(true);
  const overlay = context.pages().find(page => page.url().includes('overlay'));
  await expect(overlay.locator('.aurora-surface')).toBeVisible();
  await expect(overlay.locator('.lyric-current')).toContainText('让');
  const status = await invoke('overlay_status'); expect(status.clickThrough).toBe(true); expect(status.borderVisible).toBe(true);
  await invoke('overlay_update', { visible: false });
  await expect(overlay.locator('.aurora-surface')).toHaveCount(0);
  await invoke('overlay_update', { visible: true });
  await expect(overlay.locator('.aurora-surface')).toBeVisible();
  await expect(overlay.locator('.lyric-current')).toContainText('让');
  await invoke('overlay_update', { visible: false, clickThrough: false, borderVisible: false });
  await go(main, 'lyrics');
  console.log('PASS: no startup overlay, flags and reload stay lazy, real Windows hotkey creates it, committed renderer synchronizes, hide/show preserves state.');
} finally { await browser.close(); }
