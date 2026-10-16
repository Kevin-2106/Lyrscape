import { chromium, expect } from '@playwright/test';
import { go, openPlugin } from './lib/nav.mjs';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const main = await context.newPage(), overlay = await context.newPage();
  await main.goto(process.env.LYRSCAPE_URL ?? 'http://127.0.0.1:1420');
  await overlay.goto('http://127.0.0.1:1420/?surface=overlay');
  const input = (selector, value) => main.locator(selector).evaluate((node, value) => {
    node.value = String(value); node.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  const importText = async text => {
    await main.locator('.import-card').evaluate(node => { node.open = true; });
    await main.locator('[data-lyrics]').fill(text); await main.locator('[data-import]').click();
  };
  const long = 'LongWord'.repeat(28);
  for (const renderer of ['official.renderer.text', 'official.renderer.aurora']) {
    const use = (await openPlugin(main, `${renderer}`)).locator('[data-plugin-use]');
    await go(main, 'plugins');
    if (await use.isEnabled()) await use.click();
    await go(main, 'lyrics');
    for (const fixture of [long, `[00:00.00]${long}\n[00:10.00]下一行`, `[00:00.00]<00:00.00>${long}<00:10.00>\n[00:12.00]下一行`]) {
      await importText(fixture); await input('[data-seek]', 5000);
      await expect(overlay.locator('.lyric-current')).toContainText(long);
      for (const width of [320, 520, 1100]) {
        await overlay.setViewportSize({ width, height: 2400 });
        await overlay.waitForTimeout(1650);
        const layout = await overlay.locator('.lyric-current').evaluate(node => ({
          client: node.clientWidth, scroll: node.scrollWidth, text: node.textContent,
          overwideWords: [...node.querySelectorAll('.lyric-word')].filter(word => word.getBoundingClientRect().width > node.clientWidth + 1).length,
        }));
        if (layout.scroll > layout.client + 1 || layout.overwideWords) throw Error(`Clipped long lyrics: ${renderer} width=${width} ${JSON.stringify(layout)}`);
      }
      if (!fixture.includes('<00:')) await expect(overlay.locator('.word-fill')).toHaveCount(0);
    }
  }
  await importText('[00:00.00]按字符进入 👨‍👩‍👧‍👦\n[00:10.00]下一行');
  await expect(overlay.locator('.aurora-unit')).toHaveCount(7);
  await expect(overlay.locator('.word-fill')).toHaveCount(0);
  await expect(overlay.locator('.lyric-current')).toHaveCSS('filter', 'none');
  await expect(overlay.locator('.aurora-unit').first()).toHaveCSS('filter', 'none');
  await expect(overlay.locator('[data-resize-direction]')).toHaveCount(2);
  const star = overlay.locator('.aurora-ornament i').first();
  await expect(star).toHaveCSS('animation-name', 'aurora-twinkle');
  await expect(star).toHaveCSS('animation-iteration-count', 'infinite');
  await overlay.evaluate(() => { window.__star = document.querySelector('.aurora-ornament i'); window.__twinkle = window.__star.getAnimations()[0]; });
  await importText('[00:00.00]新的歌词行\n[00:10.00]下一行');
  await expect(overlay.locator('.lyric-current')).toHaveText('新的歌词行');
  if (!await overlay.evaluate(() => window.__star === document.querySelector('.aurora-ornament i') && window.__twinkle === window.__star.getAnimations()[0])) throw Error('Star animation restarted on lyric revision');
  await overlay.emulateMedia({ reducedMotion: 'reduce' });
  await expect(star).toHaveCSS('animation-name', 'none');
  console.log('PASS: ordinary/Aurora static + line + long single timed word wrap at 320/520/1100px; no fabricated progress; grapheme entrances; transparent overlay filter-free; resize handles; persistent slow twinkle + reduced motion.');
} finally { await browser.close(); }
