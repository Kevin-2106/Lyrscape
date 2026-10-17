import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { go, openPlugin } from './lib/nav.mjs';

// Release → install → plugin, on Windows with the real NSIS installer:
// silent install into qa/e2e/app → launch (isolated WebView2 profile, CDP 9228,
// LYRSCAPE_DATA_DIR) → import a .lyrx → use it → restart → reinstall over it
// (update) → the plugin survives → uninstall the plugin → uninstall the app.
// Build first: npm run desktop:package && npm run plugin:pack -- examples/plugins/wave/index.mjs
const root = path.resolve(process.env.LYRSCAPE_E2E_DIR ?? 'qa/e2e');
const setup = path.resolve(process.env.LYRSCAPE_SETUP ?? 'src-tauri/target/release/bundle/nsis/Lyrscape_0.1.0_x64-setup.exe');
const app = path.join(root, 'app'), data = path.join(root, 'data'), profile = path.join(root, 'webview');
const exe = path.join(app, 'lyrscape.exe');
const ID = 'example.renderer.wave', FILE = path.resolve(`builds/packages/${ID}-1.0.0.lyrx`);
const PORT = 9228;
const pkg = JSON.parse(await readFile(FILE, 'utf8'));

const install = () => {
  const result = spawnSync(setup, ['/S', `/D=${app}`], { stdio: 'inherit', windowsVerbatimArguments: true });
  if (result.status !== 0) throw Error(`installer exited with ${result.status}`);
  if (!existsSync(exe)) throw Error(`installer did not create ${exe}`);
};
let child;
const launch = async () => {
  child = spawn(exe, [], { detached: true, stdio: 'ignore', env: { ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, LYRSCAPE_DATA_DIR: data } });
  child.unref();
  for (let i = 0; i < 80; i++) {
    try { const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); const page = browser.contexts()[0]?.pages().find(p => !p.url().includes('surface=overlay')); if (page) return { browser, page }; await browser.close(); } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error('app did not expose CDP');
};
const quit = async browser => {
  await browser.close().catch(() => {});
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  for (let i = 0; i < 40 && spawnSync('tasklist', ['/FI', `PID eq ${child.pid}`, '/NH']).stdout.toString().includes(String(child.pid)); i++) await new Promise(r => setTimeout(r, 250));
};
const accept = page => page.locator('dialog[open] button[value="accept"]').click();
const pluginFile = path.join(data, 'plugins', `${ID}.mjs`);

await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true });
try {
  console.log('Install: silent NSIS install into a scratch folder');
  install();
  if (existsSync(path.join(app, 'plugins'))) throw Error('a fresh install must not ship a plugins folder');

  let { browser, page } = await launch();
  console.log('Import: .lyrx → confirm → stored under LYRSCAPE_DATA_DIR/plugins');
  await go(page, 'plugins');
  await page.locator('[data-plugin-file]').setInputFiles(FILE);
  await expect(page.locator('dialog[open] .dialog-details')).toContainText('已校验');
  await accept(page);
  await expect(page.locator(`[data-plugin-row="${ID}"] .badge.is-installed`)).toHaveText('已安装');
  expect(existsSync(pluginFile), pluginFile).toBe(true);
  expect(await readFile(pluginFile, 'utf8')).toBe(pkg.javascript);

  console.log('Use: select the renderer');
  await go(page, 'renderers');
  await page.locator(`[data-renderer-choice="${ID}"]`).click();
  await expect(page.locator('#style-preview.wave-lyric')).toHaveCount(1);

  console.log('Restart: plugin and selection survive');
  await quit(browser); ({ browser, page } = await launch());
  await go(page, 'lyrics');
  await expect(page.locator('#lyrics-preview.wave-lyric')).toHaveCount(1);

  console.log('Update: reinstall over the running install folder, plugin survives');
  await quit(browser); install();
  expect(existsSync(pluginFile)).toBe(true);
  ({ browser, page } = await launch());
  await go(page, 'lyrics');
  await expect(page.locator('#lyrics-preview.wave-lyric')).toHaveCount(1);

  console.log('Uninstall plugin: files removed, renderer falls back');
  const detail = await openPlugin(page, ID);
  await detail.locator('[data-plugin-uninstall]').click(); await accept(page);
  await expect(page.locator(`[data-plugin-row="${ID}"]`)).toHaveCount(0);
  expect(existsSync(pluginFile)).toBe(false);
  await quit(browser);
  console.log('PASS: NSIS install, .lyrx import into the data folder, renderer use, restart, update-in-place and plugin uninstall.');
} finally {
  if (child) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  console.log('Cleanup: uninstall the app');
  const uninstall = path.join(app, 'uninstall.exe');
  if (existsSync(uninstall)) spawnSync(uninstall, ['/S'], { stdio: 'inherit' });
  for (let i = 0; i < 40 && existsSync(exe); i++) await new Promise(r => setTimeout(r, 250));
  if (existsSync(exe)) console.log(`WARN: ${exe} still present after uninstall`);
}
