import { chromium, expect } from '@playwright/test';
import { go } from './lib/nav.mjs';

// Plugin list hot reload (development source). The catalog endpoints are intercepted
// so the check adds, re-describes and removes a fixture renderer without editing src/.
const base = process.env.LYRSCAPE_URL ?? 'http://127.0.0.1:1420';
const FIXTURE = 'qa.renderer.catalog-fixture';
const fixtureManifest = {
  id: FIXTURE, name: '目录测试渲染器', description: '只用于重新扫描检查。', category: 'renderer', rendererService: 'renderer.catalog-fixture@1',
  fields: [{ key: 'label', label: '标记', type: 'select', default: 'one', options: [{ value: 'one', label: '一' }, { value: 'two', label: '二' }] }],
};
// Self-contained module: named manifest export plus a default Plugin providing the renderer.
const fixtureBundle = {
  id: FIXTURE, css: '[data-catalog-fixture] { color: rgb(1, 2, 3); }',
  javascript: `export const manifest = ${JSON.stringify(fixtureManifest)};
export default { id: ${JSON.stringify(FIXTURE)}, activate(ctx) {
  ctx.provide(manifest.rendererService, { mount(root, state) {
    const node = document.createElement('div'); node.dataset.catalogFixture = '';
    const paint = () => { node.textContent = 'fixture ' + (state().plugins.configs[manifest.id]?.label ?? '?'); raf = requestAnimationFrame(paint); };
    let raf = requestAnimationFrame(paint); root.replaceChildren(node);
    return () => { cancelAnimationFrame(raf); node.remove(); };
  } });
} };`,
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
const main = await context.newPage(), overlay = await context.newPage();
const errors = [];
for (const page of [main, overlay]) page.on('pageerror', error => errors.push(error.message));
let listing = 'builtin', auroraDescription;
await context.route('**/__lyrscape/plugin-catalog', async route => {
  const response = await route.fetch(), body = await response.json();
  if (listing !== 'builtin') body.manifests.push(fixtureManifest);
  if (auroraDescription) body.manifests.find(m => m.id === 'official.renderer.aurora').description = auroraDescription;
  await route.fulfill({ response, json: body });
});
await context.route(`**/__lyrscape/plugin-source/${FIXTURE}`, route => route.fulfill({ json: fixtureBundle }));
const card = () => main.locator(`[data-plugin-id="${FIXTURE}"]`);
const rescan = async expected => {
  await go(main, 'plugins');
  await main.locator('[data-plugin-rescan]').click();
  await expect(main.locator('.plugin-message')).toContainText(expected);
};

try {
  await main.goto(base); await overlay.goto(`${base}/?surface=overlay`);
  await go(main, 'plugins');
  await expect(main.locator('[data-plugin-rescan]')).toBeVisible();
  await expect(card()).toHaveCount(0);

  console.log('Rescan: an unchanged catalog reports no change');
  await rescan('插件列表没有变化');

  console.log('Rescan: add a renderer without reloading the page');
  await main.evaluate(() => { window.__catalogSentinel = 'same-page'; });
  listing = 'with-fixture';
  await rescan(`新增 ${FIXTURE}`);
  await expect(card()).toHaveAttribute('data-plugin-origin', 'source');
  await expect(card().locator('.plugin-origin')).toHaveText('源码新增');
  await expect(card().locator('h3')).toHaveText(fixtureManifest.name);
  await card().locator('[data-plugin-use]').click();
  await card().locator('details').evaluate(element => { element.open = true; });
  await card().locator('[data-plugin-config="label"]').selectOption('two');
  await go(main, 'lyrics');
  await expect(main.locator('#lyrics-preview [data-catalog-fixture]')).toHaveText('fixture two');
  await expect(main.locator('[data-renderer-label]')).toHaveText(`${fixtureManifest.name}渲染器`);
  await expect(overlay.locator('[data-catalog-fixture]')).toHaveText('fixture two');
  await expect(overlay.locator('[data-catalog-fixture]')).toHaveCSS('color', 'rgb(1, 2, 3)');
  expect(await main.evaluate(() => window.__catalogSentinel), 'no page reload').toBe('same-page');

  console.log('Rescan: an overlay opened later receives the added renderer');
  await overlay.reload();
  await expect(overlay.locator('[data-catalog-fixture]')).toHaveText('fixture two');

  console.log('Rescan: metadata of an existing plugin updates in place');
  auroraDescription = '目录扫描更新后的说明。';
  await rescan('更新说明 / 配置 official.renderer.aurora');
  await expect(main.locator('[data-plugin-id="official.renderer.aurora"] .plugin-description')).toHaveText(auroraDescription);

  console.log('Rescan: removing it falls back to plain text in both windows');
  listing = 'builtin'; auroraDescription = undefined;
  await rescan(`移除 ${FIXTURE}`);
  await expect(card()).toHaveCount(0);
  await go(main, 'lyrics');
  await expect(main.locator('#lyrics-preview [data-catalog-fixture]')).toHaveCount(0);
  await expect(overlay.locator('[data-catalog-fixture]')).toHaveCount(0);
  await expect(overlay.locator('.lyric-surface')).toBeVisible();

  console.log('Rescan: stored settings survive a restart until the plugin is found again');
  listing = 'with-fixture';
  await rescan(`新增 ${FIXTURE}`);
  await main.reload(); await go(main, 'plugins');
  await expect(card()).toHaveCount(0);
  // The restarted control window resets the overlay to the built-in list.
  await expect(overlay.locator('[data-catalog-fixture]')).toHaveCount(0);
  await rescan(`新增 ${FIXTURE}`);
  await card().locator('details').evaluate(element => { element.open = true; });
  await expect(card().locator('[data-plugin-config="label"]')).toHaveValue('two');
  listing = 'builtin'; await rescan(`移除 ${FIXTURE}`);

  if (errors.length) throw Error(errors.join('\n'));
  console.log('PASS: rescan adds, re-describes and removes plugins in the control window and overlay without a page reload; late overlays sync; settings persist across restarts.');
} finally { await browser.close(); }
