import { openPlugin, showNativeOverlay } from './lib/nav.mjs';
import { chromium, expect } from '@playwright/test';
const browser = await chromium.connectOverCDP(process.env.LYRSCAPE_CDP ?? 'http://127.0.0.1:9228');
const pvStyle = process.argv.find(arg => arg.startsWith('--pv='))?.slice(5);
if (pvStyle && !['pop', 'letter', 'elegy'].includes(pvStyle)) throw Error('Unknown PV style');
try {
  await showNativeOverlay(browser.contexts()[0]);
  const pages = browser.contexts().flatMap(c => c.pages());
  const main = pages.find(p => !p.url().includes('surface=overlay'));
  const overlay = pages.find(p => p.url().includes('surface=overlay'));
  if (!main || !overlay) throw Error('Expected isolated fixture windows');
  await main.reload();
  const rendererId = pvStyle ? `official.renderer.pv-${pvStyle}` : 'official.renderer.aurora';
  const useRenderer = (await openPlugin(main, `${rendererId}`)).locator('[data-plugin-use]');
  if (await useRenderer.isEnabled()) await useRenderer.click();
  await main.evaluate(({ lineOnly, pvStyle, rendererId }) => {
    const set = (selector, value, type = 'input') => {
      const input = document.querySelector(selector);
      if (input.type === 'checkbox') input.checked = value; else input.value = String(value);
      input.dispatchEvent(new Event(type, { bubbles: true }));
    };
    for (const [key, value] of Object.entries({ fontSize: 54, fontWeight: 700, color: '#bea4ff', gradientStart: '#b7a0ff', gradientEnd: '#8cdce4', backgroundOpacity: 0, shadow: 1, gradientEnabled: true })) set(`[data-setting="${key}"]`, value);
    const renderer = `[data-plugin-id="${rendererId}"]`;
    const config = pvStyle ? { motion: true, layout: 'auto', scale: 1 }
      : { motion: true, sparks: true, glow: true, stagger: 28, intensity: 1, duration: 1800, entrance: 'orbit' };
    for (const [key, value] of Object.entries(config)) set(`${renderer} [data-plugin-config="${key}"]`, value, 'change');
    document.querySelector('[data-lyrics]').value = (lineOnly ? '[00:00.00]<00:00.00>Fixture lyrics<00:02.00>' : '[00:00.00]<00:00.00>Fixture <00:01.00>lyrics<00:02.00>') + '\n[00:02.00]第二行，进入动画。\n[00:04.00]Third animated line\n[00:06.00]第四行，没有私有内容\n[00:08.00]';
    document.querySelector('[data-import]').click();
  }, { lineOnly: process.argv.includes('--line-only'), pvStyle, rendererId });
  if (pvStyle) await expect(main.locator('#lyrics-preview .pv-text')).toHaveText(/Fixture/);
  else if (process.argv.includes('--line-only')) {
    await expect(main.locator('.lyric-current')).toHaveText('Fixture lyrics');
    await expect(main.locator('.word-fill')).toHaveCount(0);
  } else await expect(main.locator('.word-base').first()).toHaveText('Fixture ');
  // Import is guarded asynchronously and resets playback. Wait until it is
  // applied before playing; clicking both in one task leaves timed PV paused.
  await expect(main.locator('[data-play-text]')).toHaveText('播放');
  await main.locator('[data-play]').click();
  await expect(main.locator('[data-play-text]')).toHaveText('暂停');
  await expect.poll(async () => Number(await main.locator('[data-seek]').inputValue())).toBeGreaterThan(150);
  await main.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '#app{visibility:hidden!important}html,body{background:#112233!important}';
    document.head.append(style); document.body.dataset.qaBackdrop = 'controlled';
    window.__fixtureReplay = setInterval(() => document.querySelector('[data-restart]').click(), 8000);
  });
  await main.evaluate(() => document.querySelector('[data-overlay-toggle]').click());
  if (pvStyle) await expect(overlay.locator('[data-pv-style]')).toHaveAttribute('data-pv-style', pvStyle);
  else await expect(overlay.locator('.lyric-surface')).toHaveClass(/aurora-surface/);
  await overlay.screenshot({ path: 'qa/ghost-fixture-cdp.png', omitBackground: true });
  console.log(JSON.stringify({ ready: true, userAgent: await overlay.evaluate(() => navigator.userAgent), viewport: overlay.viewportSize() }));
} finally { await browser.close(); }
