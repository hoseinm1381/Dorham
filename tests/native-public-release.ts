import { chromium, _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Read-only public verification. Run through the guarded launcher only after
// publication. It never installs an update or creates a production account.
const executablePath = process.argv[2];
if (!executablePath) throw Error('Pass the current packaged Dorham.exe path.');
const version = process.env.DORHAM_NATIVE_RELEASE_VERSION || '1.1.0';
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid expected native version.');
const origin = 'https://dorhamapp.ir';
const previousVersion = process.env.DORHAM_PREVIOUS_WINDOWS_VERSION || '1.0.7';
const previousExecutable = path.resolve(process.env.DORHAM_PREVIOUS_WINDOWS_EXE || 'artifacts/v1.0.7/windows-avatars/win-unpacked/Dorham.exe');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'dorham-browser-native-public-'));
if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('dorham-browser-native-public-')) throw Error('Unexpected owned fixture path.');
if (process.env.DORHAM_FIXTURE_MANIFEST) await writeFile(process.env.DORHAM_FIXTURE_MANIFEST, JSON.stringify({ nonce: process.env.DORHAM_FIXTURE_NONCE, dataDir: temporary, pid: process.pid }));
const prefix = `artifacts/evidence/v${version.replaceAll('.','')}-native-public`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined;
const report: Record<string, unknown> = { version, checkedAtUTC: new Date().toISOString(), productionAccountsCreated: 0, installerExecuted: false, actualPublicMetadata: true, physicalAndroidAcceptance: false };
async function downloadLinks(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Download apps', exact: true }).click();
  for (const platform of ['Windows','Android']) {
    const suffix = platform === 'Windows' ? 'Windows-x64.exe' : 'Android.apk';
    await expect(page.getByRole('link', { name: `${platform} ${version}`, exact: true })).toHaveAttribute('href', `${origin}/downloads/${version}/Dorham-${version}-${suffix}`);
  }
}
async function native(exe: string, profile: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === 'string'));
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: path.resolve(exe), args: [`--user-data-dir=${path.join(temporary, profile)}`], env, timeout: 45000 });
  const identity = await desktop.evaluate(({ app }) => ({ version: app.getVersion(), userData: app.getPath('userData') }));
  expect(path.resolve(identity.userData).toLowerCase()).toBe(path.resolve(temporary, profile).toLowerCase());
  const page = await desktop.firstWindow(); page.setDefaultTimeout(20000);
  return { page, identity };
}
try {
  await mkdir('artifacts/evidence', { recursive: true });
  browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 30000 });
  const page = await browser.newPage(); page.setDefaultTimeout(20000);
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await downloadLinks(page); report.publicWebDownloadLinks = true;
  await page.screenshot({ path: prefix + '-web.png' });
  await browser.close(); browser = undefined;

  const current = await native(executablePath, 'current-profile'); expect(current.identity.version).toBe(version);
  await expect.poll(() => current.page.evaluate(() => (window as any).desktop.checkUpdate()), { timeout: 45000 }).toMatchObject({ current: version, latest: version, available: false });
  await expect(current.page.locator('.release-update')).toHaveCount(0);
  await downloadLinks(current.page); report.currentWindowsOnlineUpdaterAndLinks = true;
  report.currentNativeIdentity = current.identity.version;
  await current.page.screenshot({ path: prefix + '-windows-current.png' });
  await desktop!.close(); desktop = undefined;

  const previous = await native(previousExecutable, 'previous-profile'); expect(previous.identity.version).toBe(previousVersion);
  await expect.poll(() => previous.page.evaluate(() => (window as any).desktop.checkUpdate()), { timeout: 45000 }).toMatchObject({ current: previousVersion, latest: version, available: true });
  const update = previous.page.getByRole('button', { name: `Update ${version}`, exact: true }); await expect(update).toBeVisible();
  expect(await update.evaluate(e => e.getBoundingClientRect().height)).toBeLessThan(40);
  report.previousWindowsSeesCurrentUpdate = true; report.previousNativeIdentity = previousVersion;
  await previous.page.screenshot({ path: prefix + '-windows-previous.png' });
  report.status = 'passed';
  console.log('Public web/native download links and real current/previous Windows online updater passed; no installer executed.');
} catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
finally {
  await browser?.close(); await desktop?.close();
  await writeFile(prefix + '.json', JSON.stringify(report, null, 2));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
