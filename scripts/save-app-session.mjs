import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const output = process.argv.find(a => a.startsWith('--output='))?.slice(9) ?? 'qa/app-session-before-update.json';
const browser = await chromium.connectOverCDP(process.env.LYRSCAPE_CDP ?? 'http://127.0.0.1:9227');
try {
  const main = browser.contexts().flatMap(c => c.pages()).find(p => !p.url().includes('surface=overlay'));
  if (!main) throw Error('Control window missing');
  const snapshot = await main.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const created = await invoke('overlay_exists').catch(() => true);
    return {
      settings: localStorage.getItem('lyrscape.settings.v1'), plugins: localStorage.getItem('lyrscape.plugins.v1'),
      shortcuts: localStorage.getItem('lyrscape.shortcuts.v1'), page: location.hash,
      overlay: await invoke('overlay_status'),
      position: created ? await invoke('plugin:window|outer_position', { label: 'overlay' }) : null,
      size: created ? await invoke('plugin:window|inner_size', { label: 'overlay' }) : null,
      adapter: document.querySelector('[data-source-label]').textContent,
      amll: await invoke('amll_status'),
    };
  });
  // Persist only preferences, geometry, and connectivity; no track or lyrics.
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(snapshot, null, 2));
  console.log(JSON.stringify({ saved: true, overlayVisible: snapshot.overlay.visible, width: snapshot.size?.width ?? null, amllRunning: snapshot.amll.running }));
} finally { await browser.close(); }
