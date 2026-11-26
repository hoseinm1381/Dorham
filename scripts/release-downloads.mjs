import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
const windowsOnly = process.argv.includes('--windows-only');
async function signWindows(manifest) {
  const keyPath = process.env.DORHAM_WINDOWS_MANIFEST_KEY;
  if (!keyPath) return;
  const key = createPrivateKey(await readFile(keyPath));
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw Error('The Windows release key must be P-256.');
  const { version, appId, url, size, sha256 } = manifest.windows;
  const payload = Buffer.from(`${version}\n${appId}\n${url}\n${size}\n${sha256}\n`);
  manifest.signature = sign('sha256', payload, { key, dsaEncoding: 'ieee-p1363' }).toString('hex');
}
const tauri = process.argv.includes('--windows-tauri');
if (tauri && !windowsOnly) throw Error('Use --windows-only with --windows-tauri');
const { version } = JSON.parse(await readFile(tauri ? 'apps/desktop-tauri/tauri.conf.json' : 'package.json', 'utf8'));
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('Invalid release version');
const root = path.resolve(`artifacts/v${version}`), output = path.join(root, 'downloads', version);
await mkdir(output, { recursive: true });
if (windowsOnly) {
  if (!process.env.DORHAM_PREVIOUS_MANIFEST) throw Error('Set DORHAM_PREVIOUS_MANIFEST to the currently published Android manifest before a Windows-only release.');
  const previous = JSON.parse(await readFile(process.env.DORHAM_PREVIOUS_MANIFEST, 'utf8'));
  const { releaseFile } = await import('../packages/contracts/src/releases.ts');
  releaseFile(previous, 'android');
  const name = `Dorham-${version}-Windows-x64.exe`, file = path.join(root, 'windows', name), bytes = await readFile(file);
  const windows = { schema: 1, version, publishedAt: new Date().toISOString(), windows: { version, appId: 'com.dorham.chat', url: `https://dorhamapp.ir/downloads/${version}/${name}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
  await signWindows(windows);
  await copyFile(file, path.join(output, name));
  await writeFile(path.join(output, 'SHA256SUMS.txt'), `${windows.windows.sha256}  ${name}\n`);
  const directory = path.join(root, 'downloads');
  await writeFile(path.join(directory, 'windows.json'), JSON.stringify(windows, null, 2) + '\n');
  await writeFile(path.join(directory, 'android.json'), JSON.stringify(previous, null, 2) + '\n');
  await writeFile(path.join(directory, 'releases.json'), JSON.stringify({ schema: 2, windows, android: previous }, null, 2) + '\n');
  console.log(`Prepared Windows ${version}; retained Android ${previous.android.version}. Legacy latest.json must remain unchanged.`);
  process.exit(0);
}
const manifest = { schema: 1, version, publishedAt: new Date().toISOString() };
const metadata = JSON.parse(await readFile('apps/android/android/app/build/outputs/apk/release/output-metadata.json', 'utf8'));
if (metadata.applicationId !== 'com.dorham.chat' || metadata.elements[0].versionName !== version) throw Error('Android release identity mismatch');
for (const platform of ['windows', 'android']) {
  const name = `Dorham-${version}-${platform === 'windows' ? 'Windows-x64.exe' : 'Android.apk'}`;
  const file = path.join(root, platform, name), bytes = await readFile(file);
  await copyFile(file, path.join(output, name));
  manifest[platform] = { version, appId: 'com.dorham.chat', url: `https://dorhamapp.ir/downloads/${version}/${name}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...(platform === 'android' ? { versionCode: metadata.elements[0].versionCode } : {}) };
}
const arm64Name = `Dorham-${version}-Android-arm64-v8a.apk`;
const arm64File = path.join(root, 'android', arm64Name);
if (existsSync(arm64File)) {
  const bytes = await readFile(arm64File);
  manifest.androidArm64 = { ...manifest.android, url: `https://dorhamapp.ir/downloads/${version}/${arm64Name}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await copyFile(arm64File, path.join(output, arm64Name));
}
await signWindows(manifest);
await writeFile(path.join(root, 'downloads/latest.json'), JSON.stringify(manifest, null, 2) + '\n');
// Keep both legacy clients and the independent platform checkers current when
// the next release rebuilds Android and Windows together.
await writeFile(path.join(root, 'downloads/windows.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(root, 'downloads/android.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(root, 'downloads/releases.json'), JSON.stringify({ schema: 2, windows: manifest, android: manifest }, null, 2) + '\n');
await writeFile(path.join(output, 'SHA256SUMS.txt'), ['windows', 'android', 'androidArm64'].filter(platform => manifest[platform]).map(platform => `${manifest[platform].sha256}  ${path.basename(new URL(manifest[platform].url).pathname)}\n`).join(''));
console.log(`Prepared public downloads for ${version}; server upload is a separate step. No signing materials are included.`);
