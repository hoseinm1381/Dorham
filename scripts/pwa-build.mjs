import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const html = await readFile('apps/web/dist/index.html', 'utf8');
const appVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]).filter(value => value.startsWith('./assets/'));
// Keep the shell and Persian text available offline. The worker caches optional
// media, avatars, emoji, and gameplay chunks when they are actually requested.
assets.push(...(await readdir('apps/web/dist/assets')).filter(name => name.endsWith('.woff2')).map(name => `./assets/${name}`));
const shell = [...new Set(['./', './icon.svg', './manifest.webmanifest', ...assets])];
const version = createHash('sha256').update(html).update(appVersion).update(JSON.stringify(shell)).digest('hex').slice(0, 12);
const worker = (await readFile('apps/web/public/sw.js', 'utf8')).replace('dorham-shell-v1', `dorham-shell-${version}`).replace("['__DORHAM_PRECACHE__']", JSON.stringify(shell));
await writeFile('apps/web/dist/sw.js', worker);
