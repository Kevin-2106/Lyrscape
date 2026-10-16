import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { go, openPlugin } from './lib/nav.mjs';

// .lyrx lifecycle in the browser preview (IndexedDB plugin store):
// import → runs in control + overlay → survives restart with its selection → export → uninstall.
// Build the fixture first: npm run plugin:pack -- examples/plugins/wave/index.mjs
const base = process.env.LYRSCAPE_URL ?? 'http://127.0.0.1:1420';
const ID = 'example.renderer.wave', FILE = `builds/packages/${ID}-1.0.0.lyrx`;
const pkg = JSON.parse(await readFile(FILE, 'utf8'));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const main = await context.newPage(), overlay = await context.newPage();
const errors = [];
for (const page of [main, overlay]) page.on('pageerror', error => errors.push(error.message));
const accept = () => main.locator('dialog[open] button[value="accept"]').click();

try {
  await main.goto(base); await overlay.goto(`${base}/?surface=overlay`);
  await go(main, 'plugins');

  console.log('Import: a tampered package is refused before anything is installed');
  await main.locator('[data-plugin-file]').setInputFiles({ name: 'bad.lyrx', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...pkg, javascript: pkg.javascript + '\n//x' })) });
  await expect(main.locator('.plugin-message')).toContainText('校验失败');
  await expect(main.locator(`[data-plugin-row="${ID}"]`)).toHaveCount(0);

  console.log('Import: confirm shows the manifest, then the plugin registers without a reload');
  await main.evaluate(() => { window.__sentinel = 1; });
  await main.locator('[data-plugin-file]').setInputFiles(FILE);
  await expect(main.locator('dialog[open] .dialog-details')).toContainText(ID);
  await expect(main.locator('dialog[open] .dialog-details')).toContainText('已校验');
  await accept();
  const detail = await openPlugin(main, ID);
  await expect(detail).toHaveAttribute('data-plugin-origin', 'local');
  await expect(main.locator(`[data-plugin-row="${ID}"] .badge.is-installed`)).toHaveText('已安装');
  expect(await main.evaluate(() => window.__sentinel)).toBe(1);

  console.log('Use: the renderer page lists it; preview and overlay both run it, options apply');
  await go(main, 'renderers');
  await main.locator(`[data-renderer-choice="${ID}"]`).click();
  await expect(main.locator('#style-preview.wave-lyric')).toHaveCount(1);
  await expect(overlay.locator('.wave-lyric')).toHaveCount(1);
  await main.locator('[data-renderer-options] [data-plugin-config="tint"]').selectOption('glow');
  await expect(overlay.locator('.wave-lyric')).toHaveAttribute('data-wave-tint', 'glow');

  console.log('Restart: installed plugins load at boot and keep the selected renderer and options');
  await main.reload(); await overlay.reload();
  await go(main, 'lyrics');
  await expect(main.locator('#lyrics-preview.wave-lyric')).toHaveCount(1);
  await expect(main.locator('[data-renderer-label]')).toHaveText(pkg.manifest.name);
  await expect(overlay.locator('.wave-lyric')).toHaveAttribute('data-wave-tint', 'glow');

  console.log('Export: the package round-trips with the current configuration');
  const exported = await openPlugin(main, ID);
  const [download] = await Promise.all([main.waitForEvent('download'), exported.locator('[data-plugin-export]').click()]);
  expect(download.suggestedFilename()).toBe(`${ID}-1.0.0.lyrx`);
  const round = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(round.manifest.id).toBe(ID); expect(round.javascript).toBe(pkg.javascript); expect(round.config.tint).toBe('glow');

  console.log('Uninstall: both windows fall back to plain text and the store is empty');
  await exported.locator('[data-plugin-uninstall]').click(); await accept();
  await expect(main.locator(`[data-plugin-row="${ID}"]`)).toHaveCount(0);
  await expect(overlay.locator('.wave-lyric')).toHaveCount(0);
  await main.reload(); await go(main, 'plugins');
  await expect(main.locator(`[data-plugin-row="${ID}"]`)).toHaveCount(0);

  if (errors.length) throw Error(errors.join('\n'));
  console.log('PASS: .lyrx import validates and confirms, runs in both windows, persists across restart, exports with config, and uninstalls cleanly.');
} finally { await browser.close(); }
