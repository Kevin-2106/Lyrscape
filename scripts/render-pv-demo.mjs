// Samples original lyrics in an isolated browser. The resulting frames can be
// encoded as a GIF; this is a timeline demonstration, not an OS capture.
import { chromium, expect } from '@playwright/test';
import { go, openPlugin } from './lib/nav.mjs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const output = path.resolve('qa/pv-demo'); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 960, height: 440 } });
  const main = await context.newPage(); await main.goto('http://127.0.0.1:1420');
  const overlay = await context.newPage(); await overlay.goto('http://127.0.0.1:1420/?surface=overlay');
  await overlay.addStyleTag({ content: 'html,body{background:#141720!important}.qa-caption{position:fixed;top:24px;left:32px;font:500 14px "Segoe UI",sans-serif;letter-spacing:2px;color:#b0b7c8;z-index:20}.qa-footer{position:fixed;bottom:24px;left:32px;font:12px "Segoe UI",sans-serif;color:#7d8498;letter-spacing:1px}' });
  await overlay.evaluate(() => {
    const caption = document.createElement('div'); caption.className = 'qa-caption'; document.body.append(caption);
    const footer = document.createElement('div'); footer.className = 'qa-footer'; footer.textContent = 'LYRSCAPE / ORIGINAL TEXT / TIMELINE SAMPLES'; document.body.append(footer);
  });
  let frame = 0;
  for (const [style, label, color, end] of [
    ['pop', '01 / PV · 糖果波普', '#eeff87', '#b7ffd8'],
    ['letter', '02 / PV · 情书', '#ffd9bc', '#ffa8c3'],
    ['elegy', '03 / PV · 水底挽歌', '#d2b7ff', '#a7e4ff'],
  ]) {
    await go(main, 'plugins');
    await (await openPlugin(main, `official.renderer.pv-${style}`)).locator('[data-plugin-use]').click();
    await main.evaluate(({ color, end }) => {
      const set = (key, value) => { const input = document.querySelector(`[data-setting="${key}"]`); if (!input) return; if (input.type === 'checkbox') input.checked = value; else input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); };
      for (const [key, value] of Object.entries({ fontSize: 62, fontWeight: 800, gradientEnabled: true, gradientStart: color, gradientEnd: end, backgroundOpacity: 0, showTranslation: false, showNextLine: false })) set(key, value);
      document.querySelector('[data-lyrics]').value = '[00:00.00]ねえ 今日もまた眠れないまま\n[00:03.00]二人で走り出そう\n[00:06.00]二人で走り出そう\n[00:09.00]';
      document.querySelector('[data-import]').click(); document.querySelector('[data-seek]').step = 'any';
    }, { color, end });
    await expect(overlay.locator('[data-pv-style]')).toHaveAttribute('data-pv-style', style);
    await overlay.locator('.qa-caption').evaluate((element, label) => { element.textContent = label; }, label);
    const samples = [
      ...Array.from({ length: 13 }, (_, i) => i * 25),
      ...Array.from({ length: 13 }, (_, i) => 400 + i * 180),
      ...Array.from({ length: 25 }, (_, i) => 2700 + i * 25),
      ...Array.from({ length: 10 }, (_, i) => 3400 + i * 100),
    ];
    for (const position of samples) {
      await main.locator('[data-seek]').evaluate((input, position) => { input.value = String(position); input.dispatchEvent(new Event('input', { bubbles: true })); }, position);
      // Wait for receiving realm and RAF paint before sampling the composed DOM.
      await overlay.waitForTimeout(40);
      await overlay.screenshot({ path: path.join(output, `frame-${String(frame++).padStart(4, '0')}.png`) });
    }
  }
  console.log(`Rendered ${frame} sampled PV frames to ${output}`);
} finally { await browser.close(); }
