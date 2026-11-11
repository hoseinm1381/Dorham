import { execFileSync } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const app = 'apps/desktop-tauri';
const config = JSON.parse(await readFile(path.join(app, 'tauri.conf.json'), 'utf8'));
const env = { ...process.env, DORHAM_WINDOWS_VERSION: config.version };
const run = (file, args = []) => execFileSync(process.execPath, [file, ...args], { env, stdio: 'inherit', windowsHide: true });

for (const script of ['icons', 'audio-assets', 'default-avatars', 'emoji-assets']) {
  run(`scripts/${script}.mjs`);
}
run('node_modules/vite/bin/vite.js', ['build', '--config', 'apps/web/vite.config.ts', '--outDir', path.resolve(app, 'dist')]);
const entry = path.join(app, 'dist', 'index.html');
const html = await readFile(entry, 'utf8');
if (!html.includes('<head>')) throw new Error('Bundled interface is missing its HTML head');
const csp = config.app.security.csp;
await writeFile(entry, html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">`));
for (const name of ['overlay.html', 'overlay.css', 'overlay-renderer.js', 'capture-picker.css', 'capture-picker.js']) {
  await copyFile(path.join('apps', 'desktop', name), path.join(app, 'dist', name));
}
const picker = await readFile('apps/desktop/capture-picker.html', 'utf8');
await writeFile(path.join(app, 'dist', 'capture-picker.html'), picker.replace("connect-src 'none'", 'connect-src https://ipc.localhost'));
