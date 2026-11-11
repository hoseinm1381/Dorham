import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';

const project = 'apps/desktop-tauri';
const { version } = JSON.parse(await readFile(path.join(project, 'tauri.conf.json'), 'utf8'));
const release = path.resolve(project, 'target/release');
const directory = path.resolve('artifacts', `v${version}`);
await mkdir(directory, { recursive: true });
const payload = await mkdtemp(path.join(directory, 'tauri-payload-'));
await mkdir(path.join(payload, 'native'));
await copyFile(path.join(release, 'Dorham.exe'), path.join(payload, 'Dorham.exe'));
for (const name of ['VoiceHotkey.exe', 'CaptureVideo.exe', 'ShareAudio.exe']) {
  await copyFile(path.join(release, 'native', name), path.join(payload, 'native', name));
}

execFileSync(process.execPath, [
  'apps/windows-rust/installer/package.mjs', '--tauri', '--payload', payload, '--output', path.join(directory, 'windows'),
], { stdio: 'inherit', windowsHide: true });
