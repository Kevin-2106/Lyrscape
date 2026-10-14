import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { go } from './lib/nav.mjs';

// Browser smoke for the Apple Music-style list renderer (scene mode): scroll
// springs settle, seek and pause are exact, motion off snaps, interlude dots
// fill long gaps, rows resize the stage, untimed text still paints.
const output = process.env.LYRSCAPE_QA_DIR ?? path.resolve('qa/amll-style');
await mkdir(output, { recursive: true });
const base = process.env.LYRSCAPE_URL ?? 'http://127.0.0.1:1420';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const seek = value => page.locator('[data-seek]').evaluate((element, value) => {
  element.step = 'any'; element.value = String(value); element.dispatchEvent(new Event('input', { bubbles: true }));
  return new Promise(resolve => { setTimeout(resolve, 200); requestAnimationFrame(() => requestAnimationFrame(resolve)); });
}, value);
const importLyrics = async text => {
  await page.locator('details.import-card').evaluate(element => { element.open = true; });
  await page.locator('[data-lyrics]').fill(text); await page.locator('[data-import]').click();
};
const configure = (key, value) => page.locator(`[data-plugin-id="official.renderer.amll"] [data-plugin-config="${key}"]`).evaluate((element, value) => {
  if (element.type === 'checkbox') element.checked = value; else element.value = String(value);
  element.dispatchEvent(new Event('change', { bubbles: true }));
}, value);
const paint = target => target.locator(target === page ? '#lyrics-preview canvas' : '[data-pv-style] canvas').first().evaluate(async canvas => {
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let alpha = 0, signature = 0;
  for (let i = 3; i < data.length; i += 4) {
    alpha += data[i];
    if (data[i] > 24) signature = (signature * 31 + (i >> 6) + data[i - 1] + data[i - 2] * 3) % 1000000007;
  }
  return { alpha, signature, height: canvas.height };
});
const stable = async target => {
  let previous = await paint(target);
  for (let i = 0; i < 20; i++) { await target.waitForTimeout(120); const next = await paint(target); if (next.signature === previous.signature) return next; previous = next; }
  return previous;
};
// Line-timed lyrics (no word sweep) so only scrolling, blur and dots change the picture; 6 s gap before the last line.
const lyrics = '[00:00.00]第一行 一緒に歩こう\n[00:02.00]第二行 夜明けの鐘\n[00:04.00]第三行 走り出そう\n[00:06.00]第四行 またあした\n[00:08.00]\n[00:14.00]第五行 間奏のあと\n[00:16.00]';

try {
  await page.goto(base);
  await go(page, 'plugins');
  await page.locator('[data-plugin-id="official.renderer.amll"] [data-plugin-use]').click();
  await go(page, 'lyrics');
  await expect(page.locator('#lyrics-preview')).toHaveAttribute('data-pv-style', 'amll');
  await importLyrics(lyrics);
  const overlay = await context.newPage(); await overlay.goto(`${base}/?surface=overlay`);

  await seek(2050); const moving = await stable(page);
  expect(moving.alpha, 'list paints').toBeGreaterThan(0);
  await expect(page.locator('#lyrics-preview')).toHaveAttribute('data-pv-lines', /.+/);
  const second = await page.locator('#lyrics-preview').getAttribute('data-pv-line');
  await seek(3300); const settled = await stable(page);
  expect(settled.signature, 'scroll spring moves after a line change').not.toBe(moving.signature);
  await seek(3900); expect((await stable(page)).signature, 'scroll has settled within ~1.3 s').toBe(settled.signature);
  await seek(2050); expect((await stable(page)).signature, 'seek back replays the same frame').toBe(moving.signature);
  await page.waitForTimeout(300); expect((await paint(page)).signature, 'paused clock is static').toBe(moving.signature);
  await seek(4100);
  expect(await page.locator('#lyrics-preview').getAttribute('data-pv-line'), 'focus follows the active line').not.toBe(second);
  await expect(overlay.locator('[data-pv-style]')).toHaveAttribute('data-pv-line', await page.locator('#lyrics-preview').getAttribute('data-pv-line'));

  // Interlude: dots appear and fill across the 6 s gap.
  await seek(7000); const beforeGap = await stable(page);
  await seek(9500); const dotsEarly = await stable(page);
  await seek(12500); const dotsLate = await stable(page);
  expect(dotsEarly.signature, 'dots appear after the line ends').not.toBe(beforeGap.signature);
  expect(dotsLate.signature, 'dots fill as the gap progresses').not.toBe(dotsEarly.signature);
  await page.locator('#lyrics-preview').screenshot({ path: path.join(output, 'interlude.png') });

  await go(page, 'plugins');
  await page.locator('[data-plugin-id="official.renderer.amll"] details').evaluate(element => { element.open = true; });
  await configure('motion', false);
  await go(page, 'lyrics');
  await seek(2030); const snapped = await stable(page);
  await seek(3600); expect((await stable(page)).signature, 'motion off snaps without a scroll transition').toBe(snapped.signature);
  await go(page, 'plugins'); await configure('motion', true);
  await go(page, 'lyrics'); const before = (await paint(page)).height;
  await go(page, 'plugins'); await configure('rows', 5); await go(page, 'lyrics');
  await expect.poll(async () => (await paint(page)).height, { message: 'rows grow the stage' }).toBeGreaterThan(before);
  await seek(2050); await page.locator('#lyrics-preview').screenshot({ path: path.join(output, 'rows5.png') });

  await importLyrics('第一行\n第二行\n第三行');
  expect((await stable(page)).alpha, 'untimed text still paints').toBeGreaterThan(0);
  if (errors.length) throw Error(errors.join('\n'));
  console.log('PASS: Edge Apple Music-style list: paint, spring scroll settles, seek determinism, paused stillness, focus + overlay sync, interlude dots, motion off snap, rows option, untimed fallback.');
} finally { await browser.close(); }
