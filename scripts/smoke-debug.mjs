import { chromium, expect } from '@playwright/test';
import { go } from './lib/nav.mjs';

// 调试 page: playback facts update live, parsed lyrics and try-parse, plugin table,
// and (native, LYRSCAPE_CDP) AMLL wire messages recorded from a local fixture on 11445.
const native = Boolean(process.env.LYRSCAPE_CDP);
const base = process.env.LYRSCAPE_URL ?? 'http://127.0.0.1:1420';
const browser = native ? await chromium.connectOverCDP(process.env.LYRSCAPE_CDP) : await chromium.launch({ channel: 'msedge', headless: true });
const context = native ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = native ? context.pages().find(p => !p.url().includes('surface=overlay')) : await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const tab = id => page.locator(`[data-debug-tab="${id}"]`).click();
const fact = (panel, label) => page.locator(`[data-debug-panel="${panel}"] dt:text-is("${label}") + dd`).first();
let ws;
try {
  if (native) await page.reload(); else await page.goto(base);
  await go(page, 'lyrics');
  await page.locator('[data-lyrics]').fill('[00:00.00]<00:00.00>调试<00:01.00>页面<00:02.00>\n[00:03.00]第二行');
  await page.locator('[data-import]').click();

  console.log('Playback: facts refresh while visible');
  await go(page, 'debug');
  await expect(fact('playback', '歌词')).toHaveText('2 行 · word');
  await expect(fact('playback', '当前行')).toContainText('调试页面');

  console.log('Lyrics: parser output, row detail and try-parse without importing');
  await tab('lyrics');
  await expect(fact('lyrics', '时间模式')).toHaveText('逐字 / 逐词');
  await expect(fact('lyrics', '逐字片段')).toHaveText('2（有逐字数据的行 1）');
  await page.locator('[data-lyric-table] tr[data-line="0"]').click();
  await expect(page.locator('[data-lyric-detail]')).toContainText('"startMs": 1000');
  await page.locator('[data-parse-input]').fill('[00:01.00]试解析一行\n[00:02.00]第二行');
  await page.locator('[data-parse-run]').click();
  await expect(page.locator('[data-parse-facts] dt:text-is("时间模式") + dd')).toHaveText('逐行');
  await expect(fact('lyrics', '行数')).toContainText('2（'); // current lyrics unchanged
  await page.locator('[data-parse-input]').fill('[00:01.00]原文\n[00:01.00]Translation\n[00:02.00]下一行');
  await page.locator('[data-parse-run]').click();
  await expect(page.locator('[data-parse-facts] dt:text-is("译文 / 音译") + dd')).toHaveText('1 / 0 行');
  await page.locator('[data-parse-input]').fill('<tt><broken');
  await page.locator('[data-parse-kind]').selectOption('x.ttml');
  await page.locator('[data-parse-run]').click();
  await expect(page.locator('[data-parse-error]')).toContainText('解析失败');

  console.log('Plugins and beat tabs render');
  await tab('plugins');
  await expect(page.locator('[data-plugin-table] tbody tr').first()).toBeVisible();
  await tab('beat');
  await expect(page.locator('[data-beat-facts] dd').first()).not.toHaveText('');
  await expect(page.locator('[data-pcm-facts]')).toContainText('没有收到 PCM');

  if (native) {
    console.log('AMLL: fixture messages appear with their raw payload');
    await go(page, 'lyrics');
    await page.locator('[data-adapter="amll"]').click();
    // A previous run may have left the service listening.
    if (await page.locator('[data-connect]').isEnabled()) { await page.locator('[data-port]').fill('11445'); await page.locator('[data-connect]').click(); }
    await expect(page.locator('[data-connection-status]')).toHaveText('等待连接');
    ws = new WebSocket('ws://127.0.0.1:11445');
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    ws.send(JSON.stringify({ type: 'initialize' }));
    const send = value => ws.send(JSON.stringify({ type: 'state', value }));
    send({ update: 'setMusic', musicId: 'debug-qa', musicName: 'Debug fixture', artists: [{ id: 'qa', name: 'Fixture' }], duration: 60000 });
    send({ update: 'setLyric', format: 'structured', lines: [{ startTime: 0, endTime: 3000, words: [{ word: '原始', startTime: 0, endTime: 1500 }, { word: '数据', startTime: 1500, endTime: 3000 }] }] });
    send({ update: 'progress', progress: 500 });
    await expect(page.locator('[data-track-title]')).toHaveText('Debug fixture');
    await go(page, 'debug'); await tab('amll');
    await expect(page.locator('[data-amll-list] li b', { hasText: 'setLyric' })).toHaveCount(1);
    await expect(page.locator('[data-amll-list] li b', { hasText: 'progress' })).toHaveCount(0);
    await page.locator('[data-amll-progress]').check();
    await expect(page.locator('[data-amll-list] li b', { hasText: 'progress' })).toHaveCount(1);
    await page.locator('[data-amll-list] li', { hasText: 'setLyric' }).click();
    await expect(page.locator('[data-amll-detail]')).toContainText('"word": "原始"');
    await tab('lyrics');
    await expect(fact('lyrics', '来源')).toHaveText('AMLL / structured lyrics');
    ws.close();
    await go(page, 'lyrics'); await page.locator('[data-adapter="demo"]').click();
  }
  if (errors.length) throw Error(errors.join('\n'));
  console.log(`PASS: ${native ? 'WebView2' : 'Edge'} debug page — live playback facts, parser output and try-parse, plugin table, beat/PCM panel${native ? ', AMLL raw messages with filter and detail' : ''}.`);
} finally { ws?.close(); await browser.close(); }
