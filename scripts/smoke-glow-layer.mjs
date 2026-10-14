import { chromium, expect } from '@playwright/test';
import { go } from './lib/nav.mjs';
import { mkdir } from 'node:fs/promises';
const native = Boolean(process.env.LYRSCAPE_CDP);
const browser = native ? await chromium.connectOverCDP(process.env.LYRSCAPE_CDP) : await chromium.launch({ channel: 'msedge', headless: true });
try {
  await mkdir('qa/glow-layers', { recursive: true });
  const context = native ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const main = native ? context.pages().find(p => !p.url().includes('surface=overlay')) : await context.newPage();
  if (!native) await main.goto(process.env.LYRSCAPE_URL ?? 'http://127.0.0.1:1420');
  const use = main.locator('[data-plugin-id="official.renderer.aurora"] [data-plugin-use]');
  await go(main, 'plugins');
  if (await use.isEnabled()) await use.click();
  await go(main, 'lyrics');
  const configure = (key, value) => main.locator(`[data-plugin-id="official.renderer.aurora"] [data-plugin-config="${key}"]`).evaluate((node, value) => {
    if (node.type === 'checkbox') node.checked = value; else node.value = String(value);
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await main.evaluate(() => {
    for (const [key, value] of Object.entries({ gradientEnabled: true, gradientStart: '#35a7ff', gradientEnd: '#35a7ff', color: '#ffffff', fontSize: 76, fontWeight: 900, shadow: 0 })) {
      document.querySelectorAll(`[data-setting="${key}"]`).forEach(node => {
        if (node.type === 'color') return;
        if (node.type === 'checkbox') node.checked = value; else node.value = String(value);
        node.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    document.querySelector('[data-lyrics]').value = 'MMMM'; document.querySelector('[data-import]').click();
  });
  await configure('motion', false); await configure('sparks', false); await configure('glow', false);
  const overlay = native ? context.pages().find(p => p.url().includes('surface=overlay')) : await context.newPage();
  if (!native) await overlay.goto('http://127.0.0.1:1420/?surface=overlay');
  await expect(overlay.locator('.lyric-current')).toHaveText('MMMM');
  for (const [name, page] of [['preview', main], ['overlay', overlay]]) {
    await page.locator('.lyric-current').screenshot({ path: `qa/glow-layers/${native ? 'native-' : ''}${name}-off.png`, omitBackground: true });
  }
  await configure('glow', true);
  for (const [name, page] of [['preview', main], ['overlay', overlay]]) {
    await expect(page.locator('.aurora-solid').first()).toHaveCSS('z-index', '1');
    await expect(page.locator('.aurora-glow-layer').first()).toHaveCSS('z-index', '0');
    await expect(page.locator('.aurora-solid').first()).toHaveCSS('text-shadow', 'none');
    await page.locator('.lyric-current').screenshot({ path: `qa/glow-layers/${native ? 'native-' : ''}${name}-on.png`, omitBackground: true });
  }
  // Timed fills remain the clipping owner; glyph wrappers must not duplicate text.
  await main.evaluate(() => { document.querySelector('[data-lyrics]').value = '[00:00.00]<00:00.00>Hello <00:01.00>world<00:02.00>'; document.querySelector('[data-import]').click(); });
  await expect(overlay.locator('.word-fill')).toHaveCount(2);
  await expect(overlay.locator('.word-fill .aurora-solid').first()).toHaveText('Hello ');
  await expect(overlay.locator('.aurora-glow-layer')).toHaveCount(2);
  console.log('PASS: separate rear glow and front solid in preview/overlay, crisp foreground has no shadow; timed fill/text preserved; screenshot pairs saved for pixel verification.');
} finally { await browser.close(); }
