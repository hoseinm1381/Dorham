import { randomUUID } from 'node:crypto';
import { readdir, stat, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { id, requestId } from '@dorham/contracts';
import { z } from 'zod';
import type { Service } from './service';
import { fail, hash } from './security';

export function serverIcons(api: FastifyInstance, service: Service, directory: string) {
  api.post('/servers/:id/icon', async req => {
    const serverId = id.parse((req.params as { id: string }).id), rid = requestId.parse(req.headers['x-request-id']);
    await service.member(service.db, req.account.id, serverId, 'manageChannels');
    const file = await req.file();
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) fail(400, 'INVALID_IMAGE', 'Choose a PNG, JPG or WebP image.');
    const bytes = await file!.toBuffer(); let image: Buffer;
    try { image = await sharp(bytes, { limitInputPixels: 16000000 }).rotate().resize(128, 128, { fit: 'cover' }).webp({ quality: 80 }).toBuffer(); }
    catch { fail(400, 'INVALID_IMAGE', 'Image could not be decoded.'); }
    if (image!.length > 96 * 1024) fail(400, 'IMAGE_TOO_LARGE', 'Compressed image is too large.');
    let written = '', retired: string | null = null;
    try {
      const result = await service.mutate(req.account.id, rid, 'server.icon', { serverId, digest: hash(bytes.toString('base64')) }, async tx => {
        await service.member(tx, req.account.id, serverId, 'manageChannels');
        let size = 0; for (const name of await readdir(directory)) size += (await stat(path.join(directory, name))).size;
        if (size + image!.length > service.c.maxAvatarsMiB * 1024 * 1024) fail(507, 'AVATAR_QUOTA', 'Avatar storage is full.');
        const name = `${randomUUID()}.webp`;
        await writeFile(path.join(directory, name), image!, { flag: 'wx' }); written = name;
        retired = (await tx.one('SELECT icon FROM servers WHERE id=?', [serverId]))?.icon || null;
        await tx.run('UPDATE servers SET icon=? WHERE id=?', [`/avatars/${name}`, serverId]);
        return { icon: `/avatars/${name}` };
      });
      written = '';
      if (retired) await unlink(path.join(directory, path.basename(retired))).catch(() => {});
      await service.notify('state:changed', {}); return result;
    } catch (error) { if (written) await unlink(path.join(directory, written)).catch(() => {}); throw error; }
  });
  api.delete('/servers/:id/icon', async req => {
    const serverId = id.parse((req.params as { id: string }).id), b = z.object({ requestId }).parse(req.body);
    let retired: string | null = null;
    const result = await service.mutate(req.account.id, b.requestId, 'server.icon.remove', { serverId }, async tx => {
      await service.member(tx, req.account.id, serverId, 'manageChannels');
      retired = (await tx.one('SELECT icon FROM servers WHERE id=?', [serverId]))?.icon || null;
      await tx.run('UPDATE servers SET icon=NULL WHERE id=?', [serverId]); return { success: true };
    });
    if (retired) await unlink(path.join(directory, path.basename(retired))).catch(() => {});
    await service.notify('state:changed', {}); return result;
  });
}
