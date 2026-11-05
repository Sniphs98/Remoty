import { expect, type Page } from '@playwright/test';

/** Clicks the Settings gear and returns the Settings window it opens (a popup here,
 *  served by the same stub through `context().addInitScript`). */
export async function openSettings(page: Page): Promise<Page> {
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = await popup;
  await expect(settings.getByRole('heading', { name: 'Settings' }).first()).toBeAttached();
  return settings;
}
