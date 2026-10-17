/**
 * The control window is routed; previews only exist on the visible page. Old page
 * names still work: `style` opens the renderer page's 显示 tab, `overlay` / `about`
 * open settings.
 */
const aliases = { style: ['renderers', 'display'], overlay: ['settings'], about: ['settings'] };
export const go = async (page, id) => {
  const [target, tab] = aliases[id] ?? [id];
  await page.locator(`[data-nav="${target}"]`).click();
  await page.locator(`#page-${target}`).waitFor({ state: 'visible' });
  if (tab) await page.locator(`[data-inspector-tab="${tab}"]`).click();
};
/** Opens one inspector tab of the renderer page (字体 font / 颜色 color / 显示 display / 构图 layout …). */
export const inspectorTab = async (page, tab) => page.locator(`[data-inspector-tab="${tab}"]`).click();

/** Selects a plugin in 全部插件 and returns its detail pane. */
export const openPlugin = async (page, id) => {
  await go(page, 'plugins');
  const search = page.locator('[data-plugin-search]');
  if (await search.inputValue()) await search.fill('');
  await page.locator('[data-plugin-group="all"]').click();
  await page.locator(`[data-plugin-row="${id}"]`).click();
  const detail = page.locator(`[data-plugin-detail][data-plugin-id="${id}"]`);
  await detail.waitFor({ state: 'visible' });
  return detail;
};

/** Mutating fixture helper: a native overlay is created only on first show. */
export const showNativeOverlay = async context => {
  let main;
  for (let i = 0; i < 100; i++) {
    main = context.pages().find(page => page.url().startsWith('http://tauri.localhost') && !page.url().includes('surface=overlay'));
    if (main) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!main) throw Error('Native control window missing');
  await main.locator('[data-nav]').first().waitFor({ state: 'visible' });
  await main.evaluate(() => window.__TAURI_INTERNALS__.invoke('overlay_update', { visible: true }));
  for (let i = 0; i < 100; i++) {
    const page = context.pages().find(page => page.url().includes('surface=overlay'));
    if (page) { await page.locator('.overlay-adjustment-border').waitFor({ state: 'attached' }); return page; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Native overlay did not start');
};
