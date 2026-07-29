// The header regression this guards: seven inline controls used to crush the
// brand title to "CAN…" at the default ~360–400px side-panel width. The
// less-frequent actions now live behind a "More" overflow menu, and the title
// must render untruncated at the narrowest supported width.

import { expect, sendChat, test } from './fixtures';

test.describe('header overflow menu', () => {
  test('brand title does not truncate at 360px', async ({ sidebar }) => {
    await sidebar.setViewportSize({ width: 360, height: 700 });
    const title = sidebar.locator('.header .title');
    await expect(title).toHaveText('CANChat Agent');
    // Ellipsis truncation shows as scrollWidth exceeding clientWidth.
    const { scrollWidth, clientWidth } = await title.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test('menu opens, scales text without closing, and closes on Escape', async ({ sidebar }) => {
    await sidebar.setViewportSize({ width: 400, height: 700 });
    const trigger = sidebar.getByRole('button', { name: 'More actions' });
    await trigger.click();

    const menu = sidebar.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(sidebar.getByRole('menuitem', { name: /Save conversation/ })).toBeVisible();
    await expect(sidebar.getByRole('menuitem', { name: /Undo last exchange/ })).toBeVisible();

    // The embedded text-scale control acts without dismissing the menu.
    await menu.getByRole('button', { name: 'Larger text' }).click();
    await expect(menu.getByRole('button', { name: 'Reset text size' })).toHaveText('110%');
    await expect(menu).toBeVisible();

    // Escape closes and returns focus to the trigger.
    await sidebar.keyboard.press('Escape');
    await expect(sidebar.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Reset zoom so later tests in this context are unaffected.
    await trigger.click();
    await sidebar.getByRole('menu').getByRole('button', { name: 'Reset text size' }).click();
    await sidebar.keyboard.press('Escape');
  });

  test('menu actions work: save conversation exports the thread', async ({ sidebar }) => {
    await sidebar.setViewportSize({ width: 400, height: 700 });
    await sendChat(sidebar, 'Please summarize the current page.');
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();

    // Stub chrome.downloads to observe the export without a Save dialog.
    await sidebar.evaluate(() => {
      (window as unknown as { __dl: unknown[] }).__dl = [];
      chrome.downloads.download = ((opts: chrome.downloads.DownloadOptions, cb?: (id: number) => void) => {
        (window as unknown as { __dl: unknown[] }).__dl.push(opts);
        cb?.(1);
      }) as typeof chrome.downloads.download;
    });

    await sidebar.getByRole('button', { name: 'More actions' }).click();
    await sidebar.getByRole('menuitem', { name: /Save conversation/ }).click();
    // Selecting closes the menu and fires the download.
    await expect(sidebar.getByRole('menu')).toHaveCount(0);
    await expect
      .poll(() => sidebar.evaluate(() => (window as unknown as { __dl: unknown[] }).__dl.length))
      .toBeGreaterThan(0);
  });

  test('keyboard: arrows cycle menu items', async ({ sidebar }) => {
    await sidebar.setViewportSize({ width: 400, height: 700 });
    await sendChat(sidebar, 'Please summarize the current page.');
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();

    await sidebar.getByRole('button', { name: 'More actions' }).click();
    // First enabled item receives focus on open (Save conversation once a
    // message exists).
    await expect(sidebar.getByRole('menuitem', { name: /Save conversation/ })).toBeFocused();
    await sidebar.keyboard.press('ArrowDown');
    await expect(sidebar.getByRole('menuitem', { name: /Undo last exchange/ })).toBeFocused();
    await sidebar.keyboard.press('ArrowUp');
    await expect(sidebar.getByRole('menuitem', { name: /Save conversation/ })).toBeFocused();
    await sidebar.keyboard.press('Escape');
  });
});
