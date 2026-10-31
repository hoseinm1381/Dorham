import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('Invalid release version');
const root = path.resolve(`artifacts/v${version}`), output = path.join(root, 'downloads', version);
await mkdir(output, { recursive: true });
const manifest = { schema: 1, version, publishedAt: new Date().toISOString() };
const metadata = JSON.parse(await readFile('apps/android/android/app/build/outputs/apk/release/output-metadata.json', 'utf8'));
if (metadata.applicationId !== 'com.dorham.chat' || metadata.elements[0].versionName !== version) throw Error('Android release identity mismatch');
for (const platform of ['windows', 'android']) {
  const name = `Dorham-${version}-${platform === 'windows' ? 'Windows-x64.exe' : 'Android.apk'}`;
  const file = path.join(root, platform, name), bytes = await readFile(file);
  await copyFile(file, path.join(output, name));
  manifest[platform] = { version, appId: 'com.dorham.chat', url: `https://dorhamapp.ir/downloads/${version}/${name}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...(platform === 'android' ? { versionCode: metadata.elements[0].versionCode } : {}) };
}
await writeFile(path.join(root, 'downloads/latest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(output, 'SHA256SUMS.txt'), ['windows', 'android'].map(platform => `${manifest[platform].sha256}  ${path.basename(new URL(manifest[platform].url).pathname)}\n`).join(''));
console.log(`Prepared public downloads for ${version}; server upload is a separate step. No signing materials are included.`);
