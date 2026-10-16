import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { go, openPlugin } from './lib/nav.mjs';

if (!process.env.LYRSCAPE_CDP) throw Error('Use an isolated native instance');
const output = path.resolve(process.env.LYRSCAPE_QA_DIR ?? 'qa/memory-v2/native-fonts');
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.LYRSCAPE_CDP);
try {
  const main = browser.contexts()[0].pages().find(page => !page.url().includes('overlay'));
  const use = (await openPlugin(main, 'official.renderer.text')).locator('[data-plugin-use]');
  if (await use.isEnabled()) await use.click();
  await go(main, 'lyrics');
  await main.locator('[data-adapter="demo"]').click();
  const report = [];
  for (const [id, text, family, lang] of [
    ['sc', '我们说过的话，这个梦还没醒来', 'Noto Sans SC', 'zh-CN'],
    ['sc-new', '星河灿烂，明天继续一起前行', 'Noto Sans SC', 'zh-CN'],
    ['tc', '我們說過的話，這個夢還沒醒來', 'Noto Sans TC', 'zh-TW'],
    ['ja', '夜明けの鐘が鳴るまで二人で走り出そう', 'Noto Sans JP', 'ja'],
  ]) {
    await main.locator('[data-lyrics]').fill(text); await main.locator('[data-import]').click();
    const line = main.locator('#lyrics-preview .lyric-current');
    await expect(line).toHaveText(text); await expect(line).toHaveAttribute('lang', lang);
    await expect(line).toHaveCSS('font-family', new RegExp(family));
    await expect.poll(() => main.evaluate(family => [...document.fonts].some(face => face.family.replace(/["']/g, '') === family && face.status === 'loaded'), family)).toBe(true);
    await line.screenshot({ path: path.join(output, `${id}.png`), omitBackground: true });
    report.push({ id, family, faces: await main.evaluate(() => document.fonts.size) });
  }
  await main.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('lyrscape.settings.v1') ?? '{}');
    localStorage.setItem('lyrscape.settings.v1', JSON.stringify({ ...settings, fontFamily: '"Share Tech Mono", monospace' }));
  });
  await main.reload(); await go(main, 'lyrics');
  await main.locator('[data-lyrics]').fill('HELLO WORLD'); await main.locator('[data-import]').click();
  await expect(main.locator('#lyrics-preview .lyric-current')).toHaveText('HELLO WORLD');
  await expect.poll(() => main.evaluate(() => [...document.fonts].some(face => face.family.replace(/["']/g, '') === 'Share Tech Mono' && face.status === 'loaded'))).toBe(true);
  await main.locator('#lyrics-preview .lyric-current').screenshot({ path: path.join(output, 'custom.png'), omitBackground: true });
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log('PASS: real native fonts load for SC, new SC subsets, TC, Japanese and a custom bundled family; font family and language remain correct.');
} finally { await browser.close(); }
