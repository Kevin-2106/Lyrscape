import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { go, openPlugin } from './lib/nav.mjs';

// PV renderers paint into a canvas; checks sample a pixel signature (alpha sum and
// a coarse positional hash) plus the stage's data attributes.
const output = process.env.LYRSCAPE_QA_DIR ?? path.resolve('qa/pv');
await mkdir(output, { recursive: true });
const native = Boolean(process.env.LYRSCAPE_CDP);
const base = process.env.LYRSCAPE_URL ?? 'http://127.0.0.1:1420';
const browser = native ? await chromium.connectOverCDP(process.env.LYRSCAPE_CDP) : await chromium.launch({ channel: 'msedge', headless: true });
const context = native ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 1280, height: 950 } });
const page = native ? context.pages().find(page => !page.url().includes('surface=overlay')) : await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const settle = () => new Promise(resolve => { setTimeout(resolve, 200); requestAnimationFrame(() => requestAnimationFrame(resolve)); });
const input = (selector, value) => page.locator(selector).evaluate((element, value) => {
  element.value = String(value); element.dispatchEvent(new Event('input', { bubbles: true }));
  return new Promise(resolve => { setTimeout(resolve, 200); requestAnimationFrame(() => requestAnimationFrame(resolve)); });
}, value);
const seek = async value => {
  await page.bringToFront();
  await page.locator('[data-seek]').evaluate(element => { element.step = 'any'; });
  await input('[data-seek]', value);
  await expect(page.locator('[data-seek]')).toHaveValue(String(value));
};
const importLyrics = async text => {
  await page.locator('[data-lyrics]').fill(text); await page.locator('[data-import]').click();
};
const configure = (card, key, value) => card.locator(`[data-plugin-config="${key}"]`).evaluate((element, value) => {
  if (element.type === 'checkbox') element.checked = value; else element.value = String(value);
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return new Promise(resolve => { setTimeout(resolve, 200); requestAnimationFrame(() => requestAnimationFrame(resolve)); });
}, value);
/** Waits for fonts and two paints, then summarises the canvas. */
const paint = target => target.locator(target === page ? '#lyrics-preview canvas' : '[data-pv-style] canvas').first().evaluate(async canvas => {
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let alpha = 0, signature = 0;
  for (let i = 3; i < data.length; i += 4) {
    alpha += data[i];
    if (data[i] > 24) signature = (signature * 31 + (i >> 6) + data[i - 1] + data[i - 2] * 3) % 1000000007;
  }
  return { alpha, signature, width: canvas.width, height: canvas.height };
});
const stable = async target => {
  // Fonts can finish loading between samples (a face's first load through the dev
  // server can take a second); wait until the frame stays the same for ~0.6 s.
  let previous = await paint(target), same = 0;
  for (let i = 0; i < 40; i++) {
    await target.waitForTimeout(120);
    const next = await paint(target);
    same = next.signature === previous.signature ? same + 1 : 0;
    if (same >= 5) return next;
    previous = next;
  }
  return previous;
};

try {
  if (native) await page.reload(); else await page.goto(base);
  await go(page, 'lyrics');
  await page.locator('[data-adapter="demo"]').click();
  await go(page, 'plugins');
  let overlay;
  if (native) {
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('overlay_update', { visible: true, clickThrough: false, alwaysOnTop: true }));
    overlay = context.pages().find(page => page.url().includes('surface=overlay'));
  } else { overlay = await context.newPage(); await overlay.goto(`${base}/?surface=overlay`); }
  const report = [];
  // PV_STYLES=halo3,azure checks a subset.
  for (const style of process.env.PV_STYLES?.split(',') ?? ['pop', 'letter', 'elegy', 'vamp', 'synth', 'halo', 'halo2', 'halo3', 'azure', 'gamedev']) {
    console.log(`Checking ${style}: paint, timing, sync`);
    const card = page.locator(`[data-plugin-detail][data-plugin-id="official.renderer.pv-${style}"]`);
    await openPlugin(page, `official.renderer.pv-${style}`);
    const use = card.locator('[data-plugin-use]');
    if (await use.isEnabled()) await use.click();
    await go(page, 'lyrics');
    await expect(page.locator('#lyrics-preview')).toHaveAttribute('data-pv-style', style);
    await expect(overlay.locator('[data-pv-style]')).toHaveAttribute('data-pv-style', style);
    await importLyrics('[00:00.00]ねえ 今日もまた眠れないまま\n[00:03.00]二人で走り出そう\n[00:06.00]二人で走り出そう\n[00:09.00]');
    await seek(70);
    await expect(page.locator('#lyrics-preview')).toHaveAttribute('data-pv-mode', 'caption');
    const early = await stable(page);
    expect(early.alpha, 'entrance has begun painting').toBeGreaterThan(0);
    await page.waitForTimeout(250); expect((await paint(page)).signature, 'paused clock is static').toBe(early.signature);
    await seek(1500); const hold = await stable(page);
    expect(hold.signature).not.toBe(early.signature); expect(hold.alpha).toBeGreaterThan(early.alpha * 0.5);
    await seek(2980); const exit = await stable(page);
    expect(exit.alpha, 'line leaves before the next one').toBeLessThan(hold.alpha);
    await expect(overlay.locator('[data-pv-style]')).toHaveAttribute('data-pv-line', await page.locator('#lyrics-preview').getAttribute('data-pv-line'));
    await seek(1500); expect((await stable(page)).signature, 'seek restores the same frame').toBe(hold.signature);
    await seek(4500);
    await expect(page.locator('#lyrics-preview')).toHaveAttribute('data-pv-mode', 'hero');
    await expect(overlay.locator('[data-pv-style]')).toHaveAttribute('data-pv-mode', 'hero');
    const hero = await stable(page); expect(hero.alpha).toBeGreaterThan(0);
    await page.locator('#lyrics-preview').screenshot({ path: path.join(output, `${native ? 'native-' : ''}${style}-hero.png`) });
    await seek(1500);
    await page.locator('#lyrics-preview').screenshot({ path: path.join(output, `${native ? 'native-' : ''}${style}-caption.png`) });

    await configure(card, 'scale', 1.2);
    await configure(card, 'motion', false);
    // Synthesis' and Halo's HUDs show a live clock and countdown (information, not animation); hide it for this check.
    if (style === 'synth' || style === 'gamedev' || style.startsWith('halo')) await configure(card, 'hud', false);
    await seek(70); const still = await stable(page);
    await seek(1500); expect((await stable(page)).signature, 'motion off draws the settled composition').toBe(still.signature);
    await configure(card, 'motion', true);
    if (!native) {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await seek(70); const reduced = await stable(page);
      await seek(1500); expect((await stable(page)).signature, 'reduced motion is static').toBe(reduced.signature);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
    if (style === 'synth' || style === 'gamedev' || style.startsWith('halo')) await configure(card, 'hud', true);
    console.log(`Checking ${style}: reload, disable and reset`);
    await page.reload(); await expect(page.locator('#lyrics-preview')).toHaveAttribute('data-pv-style', style);
    await expect(card.locator('[data-plugin-config="scale"]')).toHaveValue('1.2');
    await go(page, 'plugins');
    await card.locator('[data-plugin-toggle]').click();
    await go(page, 'lyrics');
    await expect(page.locator('#lyrics-preview')).not.toHaveAttribute('data-pv-style', style);
    await expect(overlay.locator('.lyric-surface')).toBeVisible();
    await go(page, 'plugins');
    await card.locator('[data-plugin-toggle]').click(); await card.locator('[data-plugin-use]').click();
    await card.locator('[data-plugin-reset]').click();
    await go(page, 'lyrics');
    if (!native) {
      console.log(`Checking ${style}: widths, word timing and glyph budget`);
      for (const width of [320, 520, 1100]) {
        await overlay.setViewportSize({ width, height: 600 });
        await importLyrics(`[00:00.00]${'很长的歌词需要完整换行 '.repeat(6)}\n[00:03.00]下一行`);
        await seek(1500);
        const sample = await stable(overlay);
        expect(sample.alpha, `${style} ${width}px paints`).toBeGreaterThan(0);
        const box = await overlay.locator('[data-pv-style]').boundingBox();
        expect(box.height, `${style} ${width}px stage height is bounded`).toBeLessThan(400);
      }
      await importLyrics('[00:00.00]<00:00.00>Hello <00:01.00>world<00:02.00>\n[00:03.00]Next');
      // Text may land on an opaque caption plate, so compare the image, not total alpha.
      await seek(500); const half = await stable(page);
      await seek(1500); expect((await stable(page)).signature, 'second word appears when sung').not.toBe(half.signature);
      await seek(500); expect((await stable(page)).signature, 'unsung word stays hidden after seeking back').toBe(half.signature);
      await importLyrics('👨‍👩‍👧‍👦 ' + '长'.repeat(10000));
      const started = Date.now(); await stable(page);
      expect(Date.now() - started, '10k graphemes stay within the sprite budget').toBeLessThan(8000);
      await expect(page.locator('#lyrics-preview .pv-text')).toHaveText('👨‍👩‍👧‍👦 ' + '长'.repeat(10000));
    }
    report.push({ style, early, hold, exit, hero, native });
  }
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(path.join(output, native ? 'native-report.json' : 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS: ${native ? 'WebView2' : 'Edge'} ${process.env.PV_STYLES ?? 'ten'} PV plugins painted on canvas, entrance/hold/exit, paused clock, seek determinism, overlay line sync, hero/caption choice, config persistence, motion off, disable fallback${native ? '' : ', reduced motion, 320/520/1100px, word timing and 10k grapheme budget'}.`);
  if (native) await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('overlay_update', { visible: false, clickThrough: false, alwaysOnTop: true }));
} finally { await browser.close(); }
