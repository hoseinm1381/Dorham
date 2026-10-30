import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const html = await readFile('apps/web/dist/index.html', 'utf8');
const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]).filter(value => value.startsWith('./assets/'));
// Fonts referenced by CSS are not direct HTML links. Keep Persian readable
// offline without an external font CDN or caching any private responses.
assets.push(...(await readdir('apps/web/dist/assets')).filter(name => /\.(woff2|js|css)$/.test(name) && !/^(ChessRoom|GamesHub|GameRoom|PokerPanel|DominoPanel|LudoPanel|TelephonePanel|DrawingPanel|DrawingCanvas|WordsPanel|FourPanel|game-experience|microphone-check)-/.test(name)).map(name => `./assets/${name}`));
const shell = [...new Set(['./', './icon.svg', './icon-192.png', './icon-512.png', './manifest.webmanifest', ...assets])];
const version = createHash('sha256').update(html).digest('hex').slice(0, 12);
const worker = (await readFile('apps/web/public/sw.js', 'utf8')).replace('dorham-shell-v1', `dorham-shell-${version}`).replace("['__DORHAM_PRECACHE__']", JSON.stringify(shell));
await writeFile('apps/web/dist/sw.js', worker);
