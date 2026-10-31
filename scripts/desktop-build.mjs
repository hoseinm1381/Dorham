import { build } from 'esbuild';
import { cp, mkdir, writeFile, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
await cp('packages/contracts/src/voice-keys.json', 'apps/desktop/voice-keys.json');
if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), ['/nologo', '/optimize+', '/platform:x64', `/out:${path.resolve('apps/desktop/native/VoiceHotkey.exe')}`, path.resolve('apps/desktop/native/VoiceHotkey.cs')], { stdio: 'inherit', windowsHide: true });
const desktopDist = path.resolve('apps/desktop/dist');
if (path.relative(process.cwd(), desktopDist).split(path.sep).join('/') !== 'apps/desktop/dist') throw new Error('Unexpected generated desktop directory');
await rm(desktopDist, { recursive: true, force: true });
await mkdir(desktopDist, { recursive: true });
await cp('apps/web/dist', desktopDist, { recursive: true });
const png = await sharp('apps/web/public/icon.svg').resize(256, 256).png().toBuffer();
await writeFile('apps/desktop/icon.png', png);
const header = Buffer.alloc(22); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
await writeFile('apps/desktop/icon.ico', Buffer.concat([header, png]));

await build({ entryPoints: ['packages/contracts/src/releases.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'apps/desktop/release-contract.cjs' });
