import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = 'assets/dorham-emoji', { icons } = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
const hash = createHash('sha256');
for (const icon of icons) { hash.update(icon.name); hash.update(await readFile(`${root}/${icon.file}`)); }
const directory = `emojis/soft-bubble-${hash.digest('hex').slice(0, 12)}`;
await mkdir(`apps/web/public/${directory}`, { recursive: true });
const catalog = [];
for (const icon of icons) {
  if (!/^(emoji|dorham)-[a-z0-9-]+$/.test(icon.name) || !/^emojis\/[a-z-]+\/[a-z0-9-]+\.svg$/.test(icon.file)) throw Error('Invalid emoji manifest entry');
  await cp(`${root}/${icon.file}`, `apps/web/public/${directory}/${icon.name}.svg`);
  const label = icon.name.replace(/^(emoji|dorham)-/, '').split('-').map(s => s[0].toUpperCase() + s.slice(1)).join(' ');
  catalog.push({ id: icon.name, label, category: icon.category, tags: icon.tags, src: `./${directory}/${icon.name}.svg` });
}
await writeFile('apps/web/src/emoji-catalog.json', JSON.stringify(catalog, null, 2) + '\n');
console.log(`Prepared ${catalog.length} bundled emojis in ${directory}.`);
