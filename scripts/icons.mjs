import sharp from 'sharp';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
const source = 'apps/web/public/icon.svg';
for (const size of [192, 512]) await sharp(source).resize(size, size).png().toFile(`apps/web/public/icon-${size}.png`);
for (const [density, size] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
  const dir = `apps/android/android/app/src/main/res/mipmap-${density}`; await mkdir(dir, { recursive: true });
  for (const name of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground']) await sharp(source).resize(size, size).png().toFile(`${dir}/${name}.png`);
}
const resources = 'apps/android/android/app/src/main/res';
for (const directory of await readdir(resources)) if (directory.startsWith('drawable')) {
  const file = `${resources}/${directory}/splash.png`;
  if (!(await readdir(`${resources}/${directory}`)).includes('splash.png')) continue;
  const { width, height } = await sharp(file).metadata(); const size = Math.round(Math.min(width, height) * 0.22);
  const logo = await sharp(source).resize(size, size).png().toBuffer();
  const splash = await sharp({ create: { width, height, channels: 4, background: '#101218' } }).composite([{ input: logo, gravity: 'centre' }]).png().toBuffer();
  await writeFile(file, splash);
}
