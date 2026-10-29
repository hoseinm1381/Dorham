import { AttachmentMedia } from './attachment-media';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, unlink, stat, statfs, opendir } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { id, requestId } from '@dorham/contracts';
import type { Service } from './service';
import { fail } from './security';

export const MiB = 1048576;
export const retentionMs = (bytes: number) => bytes <= 10 * MiB ? 7 * 86400000 : 86400000;
const extensions = new Set(['.pdf', '.txt', '.md', '.csv', '.json', '.zip', '.7z', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.ogg', '.wav', '.mp4', '.webm']);
const uuid = z.string().uuid();
export class Attachments {
  private writers = new Set<string>(); private readers = new Map<string, number>(); private sweeping = false;
  private scan: Dir | null = null;
  readonly media: AttachmentMedia;
  constructor(private service: Service) { this.media = new AttachmentMedia(service, this.readers, id => this.file(id)); }
  private file(id: string, partial = false) { return path.join(this.service.c.attachmentDir, `${uuid.parse(id)}.${partial ? 'part' : 'bin'}`); }
  async initialize() { await mkdir(this.service.c.attachmentDir, { recursive: true, mode: 0o700 }); await this.cleanup(); }
  async close() { await this.scan?.close().catch(() => {}); this.scan = null; }
  async status() {
    const disk = await statfs(this.service.c.attachmentDir), rows = await this.service.db.one("SELECT COALESCE(SUM(size),0) AS bytes FROM attachments WHERE state IN ('reserved','ready')");
    return { bytes: Number(rows!.bytes), budget: this.service.c.attachmentBudgetMiB * MiB, freeBytes: disk.bavail * disk.bsize, reserveBytes: this.service.c.uploadReserveMiB * MiB };
  }
  register(api: FastifyInstance) {
    this.media.register(api);
    const { db, c } = this.service;
    api.addContentTypeParser('application/octet-stream', (_req, stream, done) => done(null, stream));
    api.post('/attachments', async req => {
      if (req.account.guest) fail(403, 'GUEST_UPLOAD', 'Guests cannot upload files.');
      const b = z.object({ conversationId: id, name: z.string().trim().min(1).max(180).refine(s => ![...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '/' || c === String.fromCharCode(92)), 'Invalid filename'), size: z.number().int().min(1).max(100 * MiB), requestId }).parse(req.body);
      if (!extensions.has(path.extname(b.name).toLowerCase())) fail(400, 'FILE_TYPE', 'This file type is not supported.');
      await this.cleanup(b.size);
      const storage = await this.status();
      return db.transaction(async tx => {
        await this.service.conversation(tx, req.account.id, b.conversationId, true);
        const old = await tx.one('SELECT * FROM attachments WHERE user_id=? AND request_id=?', [req.account.id, b.requestId]);
        if (old) {
          if (old.conversation_id !== b.conversationId || old.name !== b.name || Number(old.size) !== b.size) fail(409, 'IDEMPOTENCY_CONFLICT', 'Upload identifier already has different input.');
          return { id: old.id, state: old.state, expiresAt: Number(old.expires_at) };
        }
        const usage = await tx.one('SELECT COALESCE(SUM(bytes),0) AS bytes FROM attachment_usage WHERE user_id=? AND created_at>?', [req.account.id, Date.now() - 86400000]);
        if (Number(usage!.bytes) + b.size > 300 * MiB) fail(429, 'UPLOAD_QUOTA', 'The 300 MiB rolling daily upload allowance has been reached.');
        const global = Number((await tx.one('SELECT COALESCE(SUM(bytes),0) AS bytes FROM attachment_usage WHERE created_at>?', [Date.now() - 86400000]))!.bytes);
        if (global + b.size > c.uploadHardMiB * MiB) fail(429, 'UPLOAD_GLOBAL_HARD', 'The shared daily upload allowance has been reached.');
        if (global + b.size > c.uploadSoftMiB * MiB && b.size > c.uploadSmallMiB * MiB) fail(429, 'UPLOAD_SMALL_ONLY', 'Only files up to 2 MiB are allowed after the shared normal allowance is used. Compress pictures or try again later.');
        if (await tx.one("SELECT id FROM attachments WHERE user_id=? AND state='reserved'", [req.account.id])) fail(429, 'UPLOAD_BUSY', 'Finish or cancel your current upload first.');
        if ((await tx.one('SELECT COUNT(*) AS count FROM attachment_usage WHERE user_id=? AND created_at>?', [req.account.id, Date.now() - 86400000]))!.count >= 200) fail(429, 'UPLOAD_COUNT', 'At most 200 uploads are allowed per day.');
        const pending = await tx.one("SELECT COALESCE(SUM(size),0) AS bytes FROM attachments WHERE state='reserved'");
        const allocated = await tx.one("SELECT COALESCE(SUM(size),0) AS bytes FROM attachments WHERE state IN ('reserved','ready')");
        if (Number(allocated!.bytes) + b.size > storage.budget || storage.freeBytes - Number(pending!.bytes) - b.size < storage.reserveBytes) fail(507, 'UPLOAD_STORAGE', 'File storage has insufficient free space.');
        const uploadId = randomUUID(), now = Date.now(), expires = now + retentionMs(b.size);
        await tx.run('INSERT INTO attachments(id,user_id,conversation_id,request_id,name,size,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)', [uploadId, req.account.id, b.conversationId, b.requestId, b.name, b.size, 'reserved', now, expires]);
        await tx.run('INSERT INTO attachment_usage(id,user_id,bytes,created_at) VALUES(?,?,?,?)', [uploadId, req.account.id, b.size, now]);
        return { id: uploadId, state: 'reserved', expiresAt: expires };
      });
    });
    api.post('/attachments/:id/content', { bodyLimit: 100 * MiB, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async req => {
      const uploadId = uuid.parse((req.params as any).id);
      if (req.account.guest) fail(403, 'GUEST_UPLOAD', 'Guests cannot upload files.');
      if (this.writers.size >= c.uploadConcurrency || this.writers.has(uploadId)) fail(429, 'UPLOAD_BUSY', 'Uploads are busy. Retry shortly.');
      // Reserve the process slot before any await; metadata/quota is already committed.
      this.writers.add(uploadId); let ownedReservation = false;
      try {
        const upload = await db.one('SELECT * FROM attachments WHERE id=? AND user_id=?', [uploadId, req.account.id]);
        if (!upload) fail(404, 'NOT_FOUND', 'Upload is unavailable.');
        await this.service.conversation(db, req.account.id, upload!.conversation_id, true);
        if (upload!.state === 'ready') return { id: uploadId, state: 'ready' };
        ownedReservation = upload!.state === 'reserved';
        if (upload!.state !== 'reserved' || Number(upload!.created_at) + 15 * 60000 < Date.now()) fail(410, 'UPLOAD_EXPIRED', 'Upload reservation expired.');
        if (req.headers['content-length'] !== String(upload!.size) || req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') fail(400, 'UPLOAD_SIZE', 'Send exactly the reserved bytes as application/octet-stream.');
        const digest = createHash('sha256'); let received = 0, prefix = Buffer.alloc(0);
        const measure = new Transform({ transform(chunk: Buffer, _encoding, done) { received += chunk.length; if (received > Number(upload!.size)) return done(new Error('Upload exceeded reserved size.')); digest.update(chunk); if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]); done(null, chunk); } });
        await pipeline(req.body as Readable, measure, createWriteStream(this.file(uploadId, true), { flags: 'wx', mode: 0o600 }));
        if (received !== Number(upload!.size)) fail(400, 'UPLOAD_SIZE', 'Upload was incomplete.');
        const ext = path.extname(upload!.name).toLowerCase(), hex = prefix.toString('hex');
        const signatures: Record<string, boolean> = { '.pdf': prefix.subarray(0, 5).toString() === '%PDF-', '.png': hex.startsWith('89504e470d0a1a0a'), '.jpg': hex.startsWith('ffd8ff'), '.jpeg': hex.startsWith('ffd8ff'), '.gif': prefix.toString().startsWith('GIF8'), '.zip': hex.startsWith('504b'), '.webp': prefix.subarray(8, 12).toString() === 'WEBP', '.7z': hex.startsWith('377abcaf271c') };
        if (signatures[ext] === false || hex.startsWith('4d5a') || hex.startsWith('7f454c46')) fail(400, 'FILE_TYPE', 'File contents do not match the supported file type.');
        await rename(this.file(uploadId, true), this.file(uploadId));
        await db.run("UPDATE attachments SET state='ready',digest=? WHERE id=? AND state='reserved'", [digest.digest('hex'), uploadId]);
        return { id: uploadId, state: 'ready' };
      } catch (e) {
        if (ownedReservation) { await db.run("UPDATE attachments SET state='unavailable' WHERE id=? AND user_id=? AND state='reserved'", [uploadId, req.account.id]); await unlink(this.file(uploadId, true)).catch(() => {}); } throw e;
      } finally { this.writers.delete(uploadId); }
    });
    api.delete('/attachments/:id', async req => {
      const uploadId = uuid.parse((req.params as any).id); requestId.parse((req.body as any)?.requestId);
      if (this.writers.has(uploadId)) fail(409, 'UPLOAD_BUSY', 'Cancel the active transfer before removing the reservation.');
      await db.run("UPDATE attachments SET state='unavailable' WHERE id=? AND user_id=? AND message_id IS NULL", [uploadId, req.account.id]);
      await this.cleanup(); return { success: true };
    });
    api.get('/attachments/:id/download', async (req, reply) => {
      if ([...this.readers.values()].reduce((a, b) => a + b, 0) >= 4) fail(429, 'DOWNLOAD_BUSY', 'Downloads are busy. Retry shortly.');
      const uploadId = uuid.parse((req.params as any).id); this.readers.set(uploadId, (this.readers.get(uploadId) || 0) + 1);
      let released = false; const release = () => { if (released) return; released = true; const n = (this.readers.get(uploadId) || 1) - 1; if (n) this.readers.set(uploadId, n); else this.readers.delete(uploadId); };
      reply.raw.once('close', release); reply.raw.once('finish', release);
      try {
        const file = await db.one("SELECT a.* FROM attachments a JOIN messages m ON a.message_id=m.id WHERE a.id=? AND a.state='ready' AND a.expires_at>? AND m.deleted=0", [uploadId, Date.now()]);
        if (!file) fail(410, 'FILE_UNAVAILABLE', 'This attachment has expired or is unavailable.');
        await this.service.conversation(db, req.account.id, file!.conversation_id);
        const info = await stat(this.file(uploadId)).catch(() => null);
        if (!info || info.size !== Number(file!.size)) { await db.run("UPDATE attachments SET state='unavailable' WHERE id=?", [uploadId]); fail(410, 'FILE_UNAVAILABLE', 'This attachment is missing or corrupted.'); }
        const check = createHash('sha256'); for await (const chunk of createReadStream(this.file(uploadId))) check.update(chunk);
        if (!file!.digest || check.digest('hex') !== file!.digest) { await db.run("UPDATE attachments SET state='unavailable' WHERE id=?", [uploadId]); fail(410, 'FILE_UNAVAILABLE', 'This attachment is missing or corrupted.'); }
        reply.header('Content-Type', 'application/octet-stream').header('Content-Length', String(info!.size)).header('Content-Disposition', `attachment; filename="download${path.extname(file!.name)}"; filename*=UTF-8''${encodeURIComponent(file!.name).replace(/['()]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store').header('Content-Security-Policy', "sandbox; default-src 'none'");
        return reply.send(createReadStream(this.file(uploadId)));
      } catch (e) { release(); throw e; }
    });
    api.get('/uploads/usage', async req => ({ usedBytes: Number((await db.one('SELECT COALESCE(SUM(bytes),0) AS bytes FROM attachment_usage WHERE user_id=? AND created_at>?', [req.account.id, Date.now() - 86400000]))!.bytes), limitBytes: req.account.guest ? 0 : 300 * MiB, maxFileBytes: 100 * MiB, sharedUsedBytes: Number((await db.one('SELECT COALESCE(SUM(bytes),0) AS bytes FROM attachment_usage WHERE created_at>?', [Date.now() - 86400000]))!.bytes), softBytes: c.uploadSoftMiB * MiB, hardBytes: c.uploadHardMiB * MiB, smallFileBytes: c.uploadSmallMiB * MiB }));
  }
  async cleanup(requiredBytes = 0) {
    if (this.sweeping) return; this.sweeping = true;
    const { db, c } = this.service;
    try {
      const storage = await this.status(); let reclaimed = 0;
      const candidates = await db.all("SELECT * FROM attachments WHERE state<>'removed' AND (state<>'reserved' OR created_at<?) ORDER BY CASE WHEN expires_at<? OR state<>'ready' THEN 0 ELSE 1 END,created_at LIMIT 100", [Date.now() - 15 * 60000, Date.now()]);
      for (const a of candidates) {
        if (this.writers.has(a.id) || this.readers.has(a.id)) continue;
        const expired = a.expires_at < Date.now() || a.state !== 'ready';
        const pressure = storage.bytes - reclaimed + requiredBytes > storage.budget || storage.freeBytes + reclaimed - requiredBytes < storage.reserveBytes;
        if (!expired && !pressure) continue;
        await db.run("UPDATE attachments SET state='unavailable' WHERE id=?", [a.id]);
        let removed = true;
        for (const partial of [false, true]) await unlink(this.file(a.id, partial)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') removed = false; });
        if (removed) { reclaimed += Number(a.size); if (a.state !== 'removed') await db.run("UPDATE attachments SET state='removed' WHERE id=?", [a.id]); }
        if (a.message_id && await db.one('SELECT id FROM messages WHERE id=?', [a.message_id])) {
          const event = await db.transaction(async tx => this.service.event(tx, a.conversation_id, 'message', await this.service.messageView(tx, a.message_id)));
          await this.service.notify('conversation:event', event);
        }
      }
      // Crash reconciliation touches only generated UUID filenames, never other paths.
      this.scan ||= await opendir(c.attachmentDir);
      for (let n = 0; n < 100; n++) {
        const entry = await this.scan.read(); if (!entry) { await this.close(); break; }
        const name = entry.name; if (!entry.isFile() || !/^[0-9a-f-]{36}\.(bin|part)$/i.test(name)) continue;
        const uid = name.slice(0, 36); if (this.writers.has(uid) || this.readers.has(uid)) continue;
        if (!await db.one('SELECT id FROM attachments WHERE id=?', [uid])) await unlink(path.join(c.attachmentDir, name)).catch(() => {});
      }
      await db.run('DELETE FROM attachment_usage WHERE id IN (SELECT id FROM attachment_usage WHERE created_at<? LIMIT 1000)', [Date.now() - 86400000]);
    } finally { this.sweeping = false; }
  }
}
