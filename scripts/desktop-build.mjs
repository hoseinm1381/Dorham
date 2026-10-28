import { cp, mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
await mkdir('apps/desktop/dist', { recursive: true });
await cp('apps/web/dist', 'apps/desktop/dist', { recursive: true });
const png = await sharp('apps/web/public/icon.svg').resize(256, 256).png().toBuffer();
await writeFile('apps/desktop/icon.png', png);
const header = Buffer.alloc(22); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
await writeFile('apps/desktop/icon.ico', Buffer.concat([header, png]));
