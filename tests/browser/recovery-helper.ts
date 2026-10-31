import { expect, type Page } from '@playwright/test';
export async function completeRecovery(page: Page) {
  const popup = page.getByRole('dialog', { name: 'Protect your account', exact: true }); await expect(popup).toBeVisible();
  if (await popup.getByLabel('I have saved my recovery codes', { exact: true }).count()) {
    await popup.getByLabel('I have saved my recovery codes', { exact: true }).check(); await popup.getByRole('button', { name: 'Continue to Dorham', exact: true }).click();
  } else await popup.getByRole('button', { name: 'I already saved my codes', exact: true }).click();
  await expect(popup).toBeHidden();
}
export async function chooseScreen(page: Page) {
  await page.getByRole('dialog', { name: 'Screen sharing', exact: true }).getByRole('button', { name: 'Choose screen', exact: true }).click();
}
