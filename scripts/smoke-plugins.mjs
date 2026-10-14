import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { go } from './lib/nav.mjs';

const output = process.env.LYRSCAPE_QA_DIR ?? path.resolve('qa');
await mkdir(output, { recursive: true });
const native = Boolean(process.env.LYRSCAPE_CDP);
const browser = native ? await chromium.connectOverCDP(process.env.LYRSCAPE_CDP) : await chromium.launch({ channel: 'msedge', headless: true });
const context = native ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 1280, height: 950 } });
const page = native ? context.pages().find(page => !page.url().includes('surface=overlay')) : await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const aurora = page.locator('[data-plugin-id="official.renderer.aurora"]');
const amll = page.locator('[data-plugin-id="official.adapter.amll"]');
const input = (selector, value) => page.locator(selector).evaluate((element, value) => {
  element.value = String(value); element.dispatchEvent(new Event('input', { bubbles: true }));
}, value);
const configure = (key, value) => aurora.locator(`[data-plugin-config="${key}"]`).evaluate((element, value) => {
  if (element.type === 'checkbox') element.checked = value;
  else element.value = String(value);
  element.dispatchEvent(new Event('change', { bubbles: true }));
}, value);
try {
  if (!native) await page.goto(process.env.LYRSCAPE_URL ?? 'http://127.0.0.1:1420');
  else await page.reload();
  await go(page, 'lyrics');
  await expect(page.locator('[data-renderer-label]')).toHaveText('普通文字渲染器');
  await go(page, 'plugins');
  await expect(page.locator('.plugin-count')).toHaveText('23 / 23 已启用');
  await page.locator('[data-plugin-filter]').selectOption('renderer');
  await expect(page.locator('.plugin-card:visible')).toHaveCount(10);
  await page.locator('[data-plugin-search]').fill('aurora');
  await expect(page.locator('.plugin-card:visible')).toHaveCount(1);
  await page.locator('[data-plugin-search]').fill('does-not-exist');
  await expect(page.locator('.plugin-empty')).toBeVisible();
  await page.locator('[data-plugin-search]').fill('');
  await aurora.locator('[data-plugin-use]').click();
  await go(page, 'lyrics');
  await expect(page.locator('#lyrics-preview')).toHaveClass(/aurora-surface/);
  await aurora.locator('details').evaluate(element => { element.open = true; });
  await configure('duration', 1800); await configure('stagger', 0);
  await page.locator('details.import-card').evaluate(element => { element.open = true; });
  await page.locator('[data-lyrics]').fill('[00:00.00]<00:00.00>Hello <00:01.00>world<00:02.00>\n[00:03.00]Next line');
  await page.locator('[data-import]').click(); await input('[data-seek]', 500);
  await expect(page.locator('.word-fill').first()).toHaveCSS('clip-path', 'inset(0px 50% 0px 0px)');
  await expect(page.locator('.word-base')).toHaveCount(2);
  await page.locator('#lyrics-preview').scrollIntoViewIfNeeded();
  for (const entrance of ['orbit', 'prism', 'comet']) {
    await configure('entrance', entrance);
    await expect(page.locator('#lyrics-preview')).toHaveAttribute('data-entrance', entrance);
    await expect(page.locator('.aurora-unit').first()).toHaveCSS('animation-name', `aurora-${entrance}`);
    const animated = await page.locator('.aurora-unit').first().evaluate(element => getComputedStyle(element).transform !== 'none');
    if (!animated) throw Error(`${entrance} did not produce an actual transform`);
    if (entrance === 'orbit') await page.locator('.preview-card').screenshot({ path: path.join(output, native ? 'plugins-native-entrance.png' : 'plugins-entrance.png') });
  }
  let overlay;
  if (native) {
    await go(page, 'overlay');
    await page.locator('[data-overlay-toggle]').click();
    await go(page, 'lyrics');
    overlay = context.pages().find(page => page.url().includes('surface=overlay'));
  } else { overlay = await context.newPage(); await overlay.goto(`${process.env.LYRSCAPE_URL ?? 'http://127.0.0.1:1420'}/?surface=overlay`); }
  await expect(overlay.locator('.lyric-surface')).toHaveClass(/aurora-surface/);
  await expect(overlay.locator('.word-base')).toHaveCount(2);
  await overlay.evaluate(() => { window.__stableWord = document.querySelector('.word-base'); });
  await page.waitForTimeout(2100);
  if (!await overlay.evaluate(() => window.__stableWord === document.querySelector('.word-base'))) throw Error('Periodic sync rebuilt unchanged animated lyrics');
  await configure('motion', false);
  await expect(page.locator('.aurora-unit').first()).toHaveCSS('animation-name', 'none');
  await expect(overlay.locator('.aurora-unit').first()).toHaveCSS('animation-name', 'none');
  await configure('motion', true);
  if (!native) {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.aurora-unit').first()).toHaveCSS('animation-name', 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
  await page.reload();
  await expect(page.locator('#lyrics-preview')).toHaveClass(/aurora-surface/);
  await expect(aurora.locator('[data-plugin-config="duration"]')).toHaveValue('1800');
  await go(page, 'plugins');
  await aurora.locator('[data-plugin-toggle]').click();
  await go(page, 'lyrics');
  await expect(page.locator('#lyrics-preview')).not.toHaveClass(/aurora-surface/);
  await expect(overlay.locator('.lyric-surface')).not.toHaveClass(/aurora-surface/);
  await expect(aurora.locator('.plugin-status')).toHaveText('已停用');
  await page.reload(); await expect(aurora.locator('.plugin-status')).toHaveText('已停用');
  await go(page, 'plugins');
  await aurora.locator('[data-plugin-toggle]').click(); await aurora.locator('[data-plugin-use]').click();
  await go(page, 'lyrics');
  await expect(page.locator('#lyrics-preview')).toHaveClass(/aurora-surface/);
  await go(page, 'plugins');
  await page.locator('[data-plugin-filter]').selectOption('playback-adapter');
  let fixture;
  if (native) {
    await go(page, 'lyrics');
    await page.locator('[data-adapter="amll"]').click();
    await page.locator('[data-port]').fill('11445'); await page.locator('[data-connect]').click();
    await expect(page.locator('[data-connection-status]')).toHaveText('等待连接');
    fixture = new WebSocket('ws://127.0.0.1:11445');
    await new Promise((resolve, reject) => { fixture.addEventListener('open', resolve, { once: true }); fixture.addEventListener('error', reject, { once: true }); });
    fixture.send(JSON.stringify({ type: 'initialize' }));
    fixture.send(JSON.stringify({ type: 'state', value: { update: 'setMusic', musicId: 'plugins-qa', musicName: 'Plugin lifecycle fixture', artists: [{ id: 'qa', name: 'Fixture' }], duration: 60000 } }));
    await expect(page.locator('[data-track-title]')).toHaveText('Plugin lifecycle fixture');
    await go(page, 'plugins');
    await page.locator('[data-plugin-filter]').selectOption('renderer');
    await page.locator('[data-plugin-id="official.renderer.text"] [data-plugin-use]').click();
    await aurora.locator('[data-plugin-use]').click();
    await expect(page.locator('[data-track-title]')).toHaveText('Plugin lifecycle fixture');
    await expect(page.locator('[data-connection-status]')).toHaveText('已连接');
    await page.locator('[data-plugin-filter]').selectOption('playback-adapter');
  }
  await amll.locator('[data-plugin-toggle]').click();
  await go(page, 'lyrics');
  await expect(page.locator('[data-adapter="amll"]')).toBeDisabled();
  if (native) {
    await expect(page.locator('[data-source-label]')).toHaveText('DEMO');
    await expect.poll(() => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('amll_status').then(status => status.running))).toBe(false);
    await expect.poll(() => fixture.readyState).toBe(WebSocket.CLOSED);
  }
  await go(page, 'plugins');
  await amll.locator('[data-plugin-toggle]').click();
  await go(page, 'lyrics');
  await expect(page.locator('[data-adapter="amll"]')).toBeEnabled();
  await go(page, 'plugins');
  await page.locator('[data-plugin-filter]').selectOption('renderer');
  await aurora.locator('details').evaluate(element => { element.open = true; });
  await aurora.locator('[data-plugin-reset]').click();
  await expect(aurora.locator('[data-plugin-config="duration"]')).toHaveValue('850');
  await go(page, 'style');
  await page.locator('[data-setting="gradientEnabled"]').check();
  await input('[data-seek]', 9000);
  await go(page, 'lyrics');
  await page.waitForTimeout(1800);
  await page.locator('.preview-card').screenshot({ path: path.join(output, native ? 'plugins-native-preview.png' : 'plugins-preview.png') });
  await go(page, 'plugins');
  await page.locator('.plugin-panel').screenshot({ path: path.join(output, native ? 'plugins-native-manager.png' : 'plugins-manager.png') });
  await overlay.screenshot({ path: path.join(output, native ? 'plugins-native-overlay.png' : 'plugins-overlay.png'), omitBackground: true });
  if (!native) {
    for (const width of [860, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error(`Plugin UI overflows at ${width}px`);
    }
    await overlay.close();
  } else await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('overlay_update', { visible: false, clickThrough: false, alwaysOnTop: true }));
  if (errors.length) throw Error(`Page errors: ${errors.join('; ')}`);
  console.log(`PASS: ${native ? 'native WebView2' : 'Edge browser'} plugin categories/search, actual entrance transforms (3 presets), real word progress, config persistence/reset, renderer disable fallback/re-enable, AMLL lifecycle controls, cross-window animation/config sync without anchor replay, ${native ? 'native transparent overlay' : 'reduced motion + 860/390px layout'}.`);
} finally { await browser.close(); }
