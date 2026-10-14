import { chromium, expect } from '@playwright/test';
import { go } from './lib/nav.mjs';
const browser = await chromium.connectOverCDP(process.env.LYRSCAPE_CDP ?? 'http://127.0.0.1:9227');
const pages = browser.contexts().flatMap(c => c.pages());
const main = pages.find(p => !p.url().includes('surface=overlay'));
if (!main) throw Error('Lyrscape control window not found');
const invoke = (command, args) => main.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
if (process.argv.includes('--start')) {
  await main.reload();
  await go(main, 'lyrics');
  await expect(main.locator('[data-adapter="amll"]')).toBeVisible();
  await main.locator('[data-adapter="amll"]').click();
  await main.locator('[data-port]').fill('11444');
  await main.locator('[data-connect]').click();
  await expect(main.locator('[data-connection-status]')).not.toHaveText('未启动');
}
await main.waitForTimeout(5000);
const status = await invoke('amll_status');
const info = {
  status,
  uiStatus: await main.locator('[data-connection-status]').textContent(),
  hasTrackMetadata: await main.locator('[data-track-title]').textContent() !== '等待播放器',
  wordCount: await main.locator('.word-base').count(),
  visibleLyricChars: await main.locator('.lyric-current').evaluate(e => e.textContent.length),
  position: await main.locator('[data-position]').textContent(),
  error: (await main.locator('.toast.is-error').allTextContents()).join(' | ') || null,
};
console.log(JSON.stringify(info, null, 2));
await browser.close();
