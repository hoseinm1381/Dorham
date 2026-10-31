import { test, expect } from '@playwright/test';
import { completeRecovery } from './recovery-helper';
const origin = 'https://dorhamapp.ir';
const entry = (platform: 'windows' | 'android') => ({ version: '1.0.0', appId: 'com.dorham.chat', versionCode: 1000000, size: 4096, sha256: 'a'.repeat(64), url: `${origin}/downloads/1.0.0/Dorham-1.0.0-${platform === 'windows' ? 'Windows-x64.exe' : 'Android.apk'}` });
const manifest = { schema: 1, version: '1.0.0', windows: entry('windows'), android: entry('android') };
test.use({ trace: 'off', video: 'off' });
test('small download menu works before sign-in, after sign-in and on mobile', async ({ page }) => {
  await page.route(origin + '/downloads/latest.json', route => route.fulfill({ json: manifest, headers: { 'access-control-allow-origin': '*' } }));
  await page.goto('/'); const downloads = page.getByRole('button', { name: 'Download apps', exact: true });
  await expect(downloads).toBeVisible(); await downloads.click();
  await expect(page.getByRole('link', { name: 'Windows 1.0.0' })).toHaveAttribute('href', manifest.windows.url);
  await expect(page.getByRole('link', { name: 'Android 1.0.0' })).toHaveAttribute('href', manifest.android.url);
  await page.getByRole('button', { name: 'Close downloads' }).click();
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  const name = 'Release' + Date.now().toString().slice(-7); await page.getByLabel('Display name', { exact: true }).fill(name); await page.getByLabel('Username', { exact: true }).fill(name); await page.getByLabel('Password', { exact: true }).fill('release-browser-fixture');
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await completeRecovery(page);
  await expect(downloads).toBeVisible(); await downloads.click(); await expect(page.getByRole('dialog', { name: 'Download apps', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/evidence/v100-downloads-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator('.release-menu').evaluate(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })).toBe(true);
  await page.screenshot({ path: 'artifacts/evidence/v100-downloads-mobile.png' });
});
test('native update notice stays small and invokes the native update action', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__updateCalls = 0;
    (window as any).desktop = { getServer: async () => location.origin, setServer: async () => {}, getSecret: async () => null, setSecret: async () => {}, setInCall: () => {}, configureVoiceHotkey: async () => ({ supported: true }), onVoiceHotkey: () => () => {}, getAppInfo: async () => ({ version: '1.0.0' }), checkUpdate: async () => ({ current: '1.0.0', latest: '1.0.1', available: true }), installUpdate: async () => { (window as any).__updateCalls++; return { started: true }; } };
  });
  await page.goto('/'); const update = page.getByRole('button', { name: 'Update 1.0.1', exact: true });
  await expect(update).toBeVisible(); expect(await update.evaluate(e => e.getBoundingClientRect().height)).toBeLessThan(40);
  await update.click(); await expect.poll(() => page.evaluate(() => (window as any).__updateCalls)).toBe(1);
});
test('missing release metadata does not break sign-in or offer invalid download links', async ({ page }) => {
  await page.route(origin + '/downloads/latest.json', route => route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' } }));
  await page.goto('/'); await page.getByRole('button', { name: 'Download apps', exact: true }).click();
  await expect(page.getByText('Downloads are temporarily unavailable.', { exact: false })).toBeVisible();
  await expect(page.locator('.release-menu a')).toHaveCount(0); await expect(page.getByLabel('Username', { exact: true })).toBeEnabled();
});
