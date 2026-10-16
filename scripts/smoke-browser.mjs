import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { go } from './lib/nav.mjs';

const output = process.env.LYRSCAPE_QA_DIR ?? path.resolve('qa');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
const input = async (selector, value) => page.locator(selector).evaluate((element, value) => {
  element.value = String(value); element.dispatchEvent(new Event('input', { bubbles: true }));
}, value);
try {
  await page.goto(process.env.LYRSCAPE_URL ?? 'http://127.0.0.1:1420');
  await expect(page.locator('.word-base').first()).toHaveText('让');
  await page.locator('[data-lyrics]').fill('普通文字，自己的风景。');
  await page.locator('[data-import]').click();
  await expect(page.locator('.lyric-current')).toHaveText('普通文字，自己的风景。');
  await go(page, 'style');
  await input('[data-setting="fontSize"]', 52);
  await page.locator('[data-setting="color"][type="text"]').fill('rebeccapurple');
  await expect(page.locator('.lyric-current')).toHaveCSS('color', 'rgb(102, 51, 153)');
  await expect(page.locator('#style-preview')).toHaveCSS('font-size', '52px');
  await page.locator('[data-font-select]').selectOption('custom');
  await page.locator('[data-setting="fontFamily"]').fill('"Microsoft YaHei", sans-serif');
  await page.locator('[data-setting="gradientEnabled"]').check();
  await input('[data-setting="gradientAngle"]', 135);
  await expect(page.locator('.lyric-current')).toHaveCSS('color', 'rgba(0, 0, 0, 0)');
  const paint = await page.locator('.lyric-current').evaluate(element => getComputedStyle(element).backgroundImage);
  if (!paint.includes('135deg')) throw Error(`Gradient did not render: ${paint}`);
  await page.reload();
  await expect(page.locator('[data-setting="gradientEnabled"]')).toBeChecked();
  await expect(page.locator('#style-preview')).toHaveCSS('font-size', '52px');
  await page.screenshot({ path: path.join(output, 'lyrscape-settings.png'), fullPage: true });

  await go(page, 'lyrics');
  await page.locator('[data-lyrics]').fill('[00:00.00]First line\n[00:04.00]Next line');
  await page.locator('[data-import]').click();
  await input('[data-seek]', 5000);
  await expect(page.locator('.lyric-current')).toHaveText('Next line');
  await page.locator('[data-lyrics]').fill('[00:00.00]<00:00.00>Hello <00:01.00>world<00:02.00>\n[00:03.00]Next');
  await page.locator('[data-import]').click();
  await input('[data-seek]', 500);
  await expect(page.locator('.word-fill')).toHaveCount(2);
  await expect.poll(() => page.locator('.word-fill').first().evaluate(element => element.style.clipPath), { message: 'Word progress did not render' }).toContain('50%');

  const overlay = await context.newPage();
  await overlay.goto(`${process.env.LYRSCAPE_URL ?? 'http://127.0.0.1:1420'}/?surface=overlay`);
  await expect(overlay.locator('#app')).toContainText('Hello');
  await expect(overlay.locator('html')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(overlay.locator('.lyric-surface')).toHaveCSS('font-size', '52px');
  await overlay.screenshot({ path: path.join(output, 'lyrscape-overlay-browser.png'), omitBackground: true });
  await overlay.close();

  await page.locator('[data-lyrics]').fill('<img src=x onerror="window.__lyricInjected=true">');
  await page.locator('[data-import]').click();
  await expect(page.locator('.lyric-current')).toContainText('<img src=x');
  if (await page.evaluate(() => window.__lyricInjected)) throw Error('Untrusted lyric HTML executed');
  await expect(page.locator('.lyric-current img')).toHaveCount(0);
  await page.setViewportSize({ width: 860, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow) throw Error('Control panel overflows the minimum desktop width');
  if (errors.length) throw Error(`Browser errors: ${errors.join('; ')}`);
  console.log('PASS: live CSS color/gradient/font, persistence, plain/LRC/word lyric rendering, cross-window sync, transparency, lyric injection boundary, 860px layout.');
} finally { await browser.close(); }
