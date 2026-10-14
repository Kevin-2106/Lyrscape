import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { go } from './lib/nav.mjs';
const input = process.argv.find(a => a.startsWith('--input='))?.slice(8) ?? 'qa/app-session-before-update.json';
const snapshot = JSON.parse(await readFile(input, 'utf8'));
const browser = await chromium.connectOverCDP(process.env.LYRSCAPE_CDP ?? 'http://127.0.0.1:9227');
try {
  const main = browser.contexts().flatMap(c => c.pages()).find(p => !p.url().includes('surface=overlay'));
  if (!main) throw Error('Control window missing');
  const changed = await main.evaluate(snapshot => {
    let changed = false;
    const preferences = [['lyrscape.settings.v1', snapshot.settings], ['lyrscape.plugins.v1', snapshot.plugins]];
    if ('shortcuts' in snapshot) preferences.push(['lyrscape.shortcuts.v1', snapshot.shortcuts]);
    for (const [key, value] of preferences) {
      if (localStorage.getItem(key) !== value) { changed = true; if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
    }
    return changed;
  }, snapshot);
  if (changed) await main.reload();
  await go(main, 'lyrics');
  await expect(main.locator('#lyrics-preview')).toBeVisible();
  if (snapshot.amll.running) {
    await main.locator('[data-adapter="amll"]').click();
    await main.locator('[data-port]').fill(String(snapshot.amll.port ?? 11444));
    await main.locator('[data-connect]').click();
  }
  if (snapshot.adapter === 'DEMO') await main.locator('[data-adapter="demo"]').click();
  await main.evaluate(status => window.__TAURI_INTERNALS__.invoke('overlay_update', {
    visible: status.visible, alwaysOnTop: status.alwaysOnTop, clickThrough: status.clickThrough ?? status.clickthrough, borderVisible: status.borderVisible,
  }), snapshot.overlay);
  if (snapshot.page) await main.evaluate(hash => { location.hash = hash; }, snapshot.page);
  console.log('Restored application preferences, source, overlay visibility/top/clickthrough and AMLL listener.');
} finally { await browser.close(); }
