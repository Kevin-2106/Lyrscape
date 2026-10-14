import { chromium, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { go } from './lib/nav.mjs';

const output = path.resolve(process.env.LYRSCAPE_QA_DIR ?? 'qa'); await mkdir(output, { recursive: true });
const native = Boolean(process.env.LYRSCAPE_CDP);
const browser = native ? await chromium.connectOverCDP(process.env.LYRSCAPE_CDP) : await chromium.launch({ channel: 'msedge', headless: true });
const context = native ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 1280, height: 950 } });
const main = native ? context.pages().find(p => !p.url().includes('surface=overlay')) : await context.newPage();
let overlay = native ? context.pages().find(p => p.url().includes('surface=overlay')) : await context.newPage();
const sourcePath = path.resolve(native ? process.env.LYRSCAPE_LOCAL_PLUGIN ?? 'qa/manual-reload-runtime/plugins/official.renderer.aurora.mjs' : 'src/plugins/aurora.ts');
const cssPath = path.resolve(native ? sourcePath.replace(/\.mjs$/, '.css') : 'src/plugins/aurora.css');
const original = await readFile(sourcePath, 'utf8'), originalCss = await readFile(cssPath, 'utf8');
let lastSource = original, lastCss = originalCss;
let fixture;
const edit = async (source, css = lastCss) => { lastSource = source; lastCss = css; await writeFile(sourcePath, source); await writeFile(cssPath, css); };
const card = () => main.locator('[data-plugin-id="official.renderer.aurora"]');
const reload = async () => { await go(main, 'plugins'); await card().locator('[data-plugin-reload]').click(); };
const proof = async (page, value) => { if (page === main) await go(main, 'lyrics'); await expect(page.locator('[data-reload-proof]').first()).toHaveAttribute('data-reload-proof', value); };
const browserErrors = [];
for (const page of [main, overlay]) { page.on('pageerror', e => browserErrors.push(e.message)); page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); }); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  if (!native) { await main.goto('http://127.0.0.1:1420'); await overlay.goto('http://127.0.0.1:1420/?surface=overlay'); }
  else { await main.reload(); await overlay.reload(); }
  await go(main, 'plugins');
  const use = card().locator('[data-plugin-use]'); if (!await use.isDisabled()) await use.click();
  await card().locator('details').evaluate(element => { element.open = true; });
  await card().locator('[data-plugin-config="duration"]').fill('1200');
  await card().locator('[data-plugin-config="duration"]').dispatchEvent('change');
  await card().locator('[data-plugin-reload-source]').selectOption(native ? 'local' : 'source');
  await main.evaluate(() => { window.__manualReloadSentinel = 'same-page'; });
  await expect(overlay.locator('.aurora-surface').first()).toBeVisible();
  const v2 = native
    ? (await readFile('examples/editable-aurora.mjs', 'utf8')).replace('local-v1', 'local-v2')
    : original.replace("root.classList.add('aurora-surface');", "root.classList.add('aurora-surface'); root.dataset.reloadProof = 'source-v2';")
      .replace("root.classList.remove('aurora-surface'", "delete root.dataset.reloadProof; root.classList.remove('aurora-surface'");
  const value = native ? 'local-v2' : 'source-v2';
  await edit(v2, `${originalCss}\n[data-reload-proof] { --reload-proof: applied-v2; }\n`);
  await delay(450);
  expect(await main.evaluate(() => window.__manualReloadSentinel)).toBe('same-page');
  expect(await main.locator('[data-reload-proof]').count()).toBe(0);
  await reload(); await proof(main, value); await proof(overlay, value);
  expect(await main.locator('[data-reload-proof]').first().evaluate(e => getComputedStyle(e).getPropertyValue('--reload-proof').trim())).toBe('applied-v2');
  await expect(card().locator('[data-plugin-config="duration"]')).toHaveValue('1200');
  await overlay.reload(); await proof(overlay, value);

  await edit(`${v2}\n invalid javascript !!!`);
  await reload(); await expect(card().locator('.plugin-error')).toBeVisible();
  await proof(main, value); await proof(overlay, value);

  // Loading parses successfully, but activation fails only in the peer window.
  const brokenPeer = native
    ? v2.replace('activate(ctx) {', "activate(ctx) { if (location.search.includes('surface=overlay')) throw Error('peer-fixture');")
    : v2.replace('activate(ctx) {', "activate(ctx) { if (location.search.includes('surface=overlay')) throw Error('peer-fixture');");
  await edit(brokenPeer);
  await reload(); await expect(card().locator('.plugin-error')).toContainText('peer-fixture');
  await proof(main, value); await proof(overlay, value);
  await expect(main.locator('style[data-plugin-style="official.renderer.aurora"]')).toHaveCount(1);
  await expect(overlay.locator('style[data-plugin-style="official.renderer.aurora"]')).toHaveCount(1);
  expect(await main.evaluate(() => window.__manualReloadSentinel)).toBe('same-page');

  await edit(original, originalCss); await reload();
  await expect(main.locator('[data-reload-proof]')).toHaveCount(0);
  await expect(overlay.locator('[data-reload-proof]')).toHaveCount(0);
  await expect(card().locator('.plugin-error')).toBeHidden();
  await go(main, 'lyrics');
  await expect(main.locator('.aurora-surface').first()).toBeVisible();
  await go(main, 'plugins');
  await main.screenshot({ path: path.join(output, native ? 'manual-reload-native.png' : 'manual-reload-browser.png'), fullPage: true });
  if (native) {
    const invoke = (command, args) => main.evaluate(([command, args]) => window.__TAURI_INTERNALS__.invoke(command, args), [command, args]);
    const connect = async () => {
      fixture = new WebSocket('ws://127.0.0.1:11445');
      await new Promise((resolve, reject) => { fixture.addEventListener('open', resolve, { once: true }); fixture.addEventListener('error', reject, { once: true }); });
      fixture.send(JSON.stringify({ type: 'initialize' }));
      fixture.send(JSON.stringify({ type: 'state', value: { update: 'setMusic', musicId: 'reload-qa', musicName: 'Manual reload fixture', artists: [], duration: 60000 } }));
    };
    await go(main, 'lyrics'); await main.locator('[data-adapter="amll"]').click();
    await main.locator('[data-port]').fill('11445'); await main.locator('[data-connect]').click();
    await expect.poll(async () => (await invoke('amll_status')).running).toBe(true);
    await expect.poll(async () => (await invoke('amll_status')).port).toBe(11445);
    await connect();
    await expect(main.locator('[data-track-title]')).toHaveText('Manual reload fixture');
    await go(main, 'plugins');
    const amll = main.locator('[data-plugin-id="official.adapter.amll"]');
    await amll.locator('[data-plugin-reload-source]').selectOption('local'); await amll.locator('[data-plugin-reload]').click();
    await expect.poll(() => fixture.readyState).toBe(WebSocket.CLOSED);
    await expect.poll(async () => (await invoke('amll_status')).running).toBe(true);
    await expect.poll(async () => (await invoke('amll_status')).port).toBe(11445);
    await connect(); await go(main, 'lyrics'); await expect(main.locator('[data-track-title]')).toHaveText('Manual reload fixture');
    await invoke('amll_stop');
    await main.locator('[data-adapter="demo"]').click();
    for (const id of ['official.renderer.pv-pop', 'official.renderer.pv-letter', 'official.renderer.pv-elegy']) {
      await go(main, 'plugins'); const pv = main.locator(`[data-plugin-id="${id}"]`);
      await pv.locator('[data-plugin-use]').click(); await pv.locator('[data-plugin-reload-source]').selectOption('local');
      await pv.locator('[data-plugin-reload]').click(); await expect(pv.locator('[data-plugin-reload]')).toHaveAttribute('title', /已成功热重载/);
      await expect(pv.locator('.plugin-error')).toBeHidden(); await go(main, 'lyrics');
      await expect(main.locator('#lyrics-preview canvas').first()).toBeVisible(); await expect(overlay.locator('canvas').first()).toBeVisible();
    }
  }
  console.log(`PASS: ${native ? 'release WebView2 local JS' : 'development TypeScript'} manual source application, no page reload, config/selection retained, both windows updated, CSS replaced, overlay reload resync, syntax failure keeps old code, peer activation failure rolls both windows back, resources bounded and source restored.`);
} catch (error) {
  console.error('Reload diagnostics:', JSON.stringify({ error: await card().locator('.plugin-error').textContent(), message: await main.locator('.plugin-message').textContent(), status: await card().locator('.plugin-status').textContent(), title: await card().locator('[data-plugin-reload]').getAttribute('title'), styles: await main.locator('style[data-plugin-style]').count(), browserErrors }));
  throw error;
} finally {
  fixture?.close();
  // Never overwrite an unrelated edit that appeared while this test was running.
  if (await readFile(sourcePath, 'utf8') === lastSource) await writeFile(sourcePath, original);
  else throw Error('Source changed outside the fixture; original backup was not written over it');
  if (await readFile(cssPath, 'utf8') === lastCss) await writeFile(cssPath, originalCss);
  else throw Error('CSS changed outside the fixture; original backup was not written over it');
  await browser.close();
}
