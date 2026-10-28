import { _electron as electron } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Continue the isolated hosted smoke fixture; never open the user's normal profile.
const fixture = JSON.parse(await readFile('artifacts/evidence/windows-live-smoke.json', 'utf8'));
assert.equal(fixture.server, 'https://dorham.bot-keep.xyz');
assert.ok(path.resolve(fixture.isolatedProfile).startsWith(path.join(os.tmpdir(), 'dorham-desktop-test-')));
const profile = path.join(fixture.isolatedProfile, 'profile');
const settings = path.join(profile, 'settings.json');
const before = await readFile(settings, 'utf8');
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({ executablePath: fixture.executablePath, args: [`--user-data-dir=${profile}`], env, timeout: 30000 });
try {
  const page = await desktop.firstWindow();
  await page.getByRole('heading', { name: 'Hey, Windows.' }).waitFor();
  await page.locator('.connection-light.connected').waitFor();
  assert.notEqual(await readFile(settings, 'utf8'), before, 'The protected refresh credential rotates after app restart.');
  await page.locator('.dm-item').filter({ hasText: 'Web deployment check' }).click();
  await page.getByTestId('message').filter({ hasText: 'Web to Windows verification reply.' }).waitFor();
  const acknowledgement = 'Windows received the web reply after restarting.';
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(acknowledgement);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByTestId('message').filter({ hasText: acknowledgement }).waitFor();
  await page.screenshot({ path: 'artifacts/evidence/windows-live-dm.png' });
  await writeFile('artifacts/evidence/windows-live-persistence.json', JSON.stringify({ testedAt: new Date().toISOString(), server: fixture.server, nativeAppRestartLogin: true, protectedRefreshRotated: true, webReplyReceived: true, acknowledgement, socketConnected: true }, null, 2));
  console.log('Native persistent login, refresh rotation and web/Windows DM exchange passed.');
} finally { await desktop.close(); }
