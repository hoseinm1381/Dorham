import { _electron, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { completeRecovery } from './browser/recovery-helper';

const run = promisify(execFile);

export const migratedValues = {
  'dorham.language': 'fa-IR',
  'dorham-voice-input': JSON.stringify({ mode: 'push', background: true, binding: { code: 'F9', alt: false, ctrl: false, shift: false } }),
  'dorham-sounds': JSON.stringify({ voice: false, messages: true }),
};

export async function exportOwnedElectronProfile(
  previousExecutable: string, validator: string, root: string,
  destination: string, server: string, username: string, password: string, token: string,
) {
  const roaming = path.join(root, 'Roaming AppData');
  const legacyProfile = path.join(roaming, '@dorham', 'desktop');
  await mkdir(legacyProfile, { recursive: true });
  const overlay = { enabled: true, position: 'bottom-right' };
  await writeFile(path.join(legacyProfile, 'settings.json'), JSON.stringify({ server, voiceOverlay: overlay }));
  const created = await fetch(server + '/api/v1/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId: crypto.randomUUID(), name: 'Owned migration fixture' }),
  });
  expect(created.ok).toBe(true);
  await created.body?.cancel();
  const expected: Record<string, string> = { ...migratedValues };
  const previous = await _electron.launch({
    executablePath: path.resolve(previousExecutable),
    args: [`--user-data-dir=${legacyProfile}`],
    timeout: 30000,
  });
  try {
    const identity = await previous.evaluate(({ app }) => ({ version: app.getVersion(), profile: app.getPath('userData') }));
    expect(identity.version).toBe('1.2.8');
    expect(path.resolve(identity.profile).toLowerCase()).toBe(path.resolve(legacyProfile).toLowerCase());
    const page = await previous.firstWindow();
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Let’s get you in', exact: true }).click();
    await completeRecovery(page);
    await expect(page.locator('.connection-light.connected')).toBeVisible({ timeout: 15000 });
    expect(await page.evaluate(async () => Boolean(await window.desktop?.getSecret()))).toBe(true);
    await page.getByRole('button', { name: 'Open Owned migration fixture', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('پیش‌نویس آزمایشی');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('dorham-drafts-v1') || '')).toContain('پیش‌نویس آزمایشی');
    expected['dorham-drafts-v1'] = (await page.evaluate(() => localStorage.getItem('dorham-drafts-v1')))!;
    await page.evaluate(values => {
      for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    }, migratedValues);
  } finally {
    await previous.close();
  }

  const nsis = path.resolve(process.env.DORHAM_NSIS_BUNDLE || '.tools/nsis/nsis-bundle', 'windows');
  const runner = path.join(root, 'run-installer-migration.exe');
  await run(path.join(nsis, 'makensis.exe'), ['/V2', path.resolve('tests/fixtures/tauri-migration.nsi')], {
    env: {
      ...process.env, NSISDIR: nsis, DORHAM_PROFILE_VALIDATOR: path.resolve(validator),
      DORHAM_TEST_MIGRATION_RUNNER: runner,
      DORHAM_TEST_MIGRATION_RESOURCES: path.resolve('apps/windows-rust/installer'),
    }, timeout: 60000, windowsHide: true,
  });
  await run(runner, [], {
    env: {
      ...process.env, DORHAM_TEST_MIGRATION_INSTALL: path.dirname(path.resolve(previousExecutable)),
      DORHAM_TEST_MIGRATION_ROAMING: roaming, DORHAM_TEST_MIGRATION_DESTINATION: destination,
    }, timeout: 130000, windowsHide: true,
  });
  const raw = await readFile(path.join(destination, 'electron-export-v1.json'), 'utf8');
  const parsed = JSON.parse(raw);
  expect(parsed.appId).toBe('com.dorham.chat');
  expect(typeof parsed.protectedPayload).toBe('string');
  expect(raw.includes('پیش‌نویس آزمایشی')).toBe(false);
  return { overlay, expected };
}
