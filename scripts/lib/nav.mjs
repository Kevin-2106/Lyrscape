/** The control window is routed; previews only exist on the visible page. */
export const go = async (page, id) => {
  await page.locator(`[data-nav="${id}"]`).click();
  await page.locator(`#page-${id}`).waitFor({ state: 'visible' });
};
