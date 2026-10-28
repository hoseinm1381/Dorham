import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const html = await readFile('apps/web/dist/index.html', 'utf8');
const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]).filter(value => value.startsWith('./assets/'));
const shell = ['./', './icon.svg', './icon-192.png', './icon-512.png', './manifest.webmanifest', ...assets];
const version = createHash('sha256').update(html).digest('hex').slice(0, 12);
const worker = (await readFile('apps/web/public/sw.js', 'utf8')).replace('dorham-shell-v1', `dorham-shell-${version}`).replace("['__DORHAM_PRECACHE__']", JSON.stringify(shell));
await writeFile('apps/web/dist/sw.js', worker);
