import { randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requestId } from '@dorham/contracts';
import type { Service } from './service';
import { fail, hash } from './security';
const uuid = z.string().uuid();
export function mediaMime(name: string, prefix: Buffer): string | null {
  const ext = path.extname(name).toLowerCase(), hex = prefix.toString('hex');
  if (ext === '.png' && hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (['.jpg', '.jpeg'].includes(ext) && hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (ext === '.gif' && /^GIF8[79]a/.test(prefix.toString('ascii'))) return 'image/gif';
  if (ext === '.webp' && prefix.subarray(0, 4).toString() === 'RIFF' && prefix.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (ext === '.mp4' && prefix.subarray(4, 8).toString() === 'ftyp') return 'video/mp4';
  if (ext === '.webm' && hex.startsWith('1a45dfa3') && prefix.includes(Buffer.from('webm'))) return 'video/webm';
  return null;
}
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header); if (!match || (!match[1] && !match[2])) throw new Error('range');
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (![start, end].every(Number.isSafeInteger) || start >= size || end < start || (!match[1] && Number(match[2]) === 0)) throw new Error('range');
  start = Math.max(0, start); return { start, end };
}
export class AttachmentMedia {
  private tickets = new Map<string, { sessionId: string; fileId: string; expiresAt: number }>();
  private checked = new Map<string, { key: string; expiresAt: number; mime: string }>();
  constructor(private service: Service, private readers: Map<string, number>, private file: (id: string) => string) {}
  resolveTicket(value: unknown, fileId: string): string | undefined {
    if (typeof value !== 'string' || value.length !== 43) return;
    const ticket = this.tickets.get(hash(value));
    if (!ticket || ticket.fileId !== fileId || ticket.expiresAt <= Date.now()) return;
    return ticket.sessionId;
  }
  private async available(userId: string, fileId: string) {
    const row = await this.service.db.one("SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=? AND a.state='ready' AND a.expires_at>? AND m.deleted=0", [fileId, Date.now()]);
    if (!row) fail(410, 'FILE_UNAVAILABLE', 'This attachment has expired or is unavailable.');
    await this.service.conversation(this.service.db, userId, row!.conversation_id); return row!;
  }
  register(api: FastifyInstance) {
    api.post('/attachments/:id/preview', async req => {
      z.object({ requestId }).strict().parse(req.body);
      const fileId = uuid.parse((req.params as any).id); await this.available(req.account.id, fileId);
      for (const [key, ticket] of this.tickets) if (ticket.expiresAt <= Date.now()) this.tickets.delete(key);
      const owned = [...this.tickets].filter(([, t]) => t.sessionId === req.session.id);
      for (const [key] of owned.slice(0, Math.max(0, owned.length - 31))) this.tickets.delete(key);
      while (this.tickets.size >= 512) this.tickets.delete(this.tickets.keys().next().value!);
      const ticket = randomBytes(32).toString('base64url'), expiresAt = Date.now() + 5 * 60000;
      this.tickets.set(hash(ticket), { sessionId: req.session.id, fileId, expiresAt });
      return { path: `/api/v1/attachments/${fileId}/media?media_ticket=${ticket}`, expiresAt };
    });
    api.get('/attachments/:id/media', async (req, reply) => {
      if ([...this.readers.values()].reduce((a, b) => a + b, 0) >= 4) fail(429, 'DOWNLOAD_BUSY', 'Downloads are busy. Retry shortly.');
      const fileId = uuid.parse((req.params as any).id);
      this.readers.set(fileId, (this.readers.get(fileId) || 0) + 1);
      let released = false; const release = () => { if (released) return; released = true; const count = (this.readers.get(fileId) || 1) - 1; if (count) this.readers.set(fileId, count); else this.readers.delete(fileId); };
      reply.raw.once('close', release); reply.raw.once('finish', release);
      try {
        const row = await this.available(req.account.id, fileId), filename = this.file(fileId), info = await stat(filename).catch(() => null);
        if (!info?.isFile() || info.size !== Number(row.size)) fail(410, 'FILE_UNAVAILABLE', 'This attachment is missing or corrupted.');
        const key = `${row.digest}/${info!.size}/${info!.mtimeMs}/${info!.ctimeMs}`, cached = this.checked.get(fileId);
        let mime = cached?.key === key && cached.expiresAt > Date.now() ? cached.mime : null;
        if (!mime) {
          const digest = createHash('sha256'); let prefix = Buffer.alloc(0);
          for await (const chunk of createReadStream(filename)) { digest.update(chunk); if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]); }
          if (!row.digest || digest.digest('hex') !== row.digest) fail(410, 'FILE_UNAVAILABLE', 'This attachment is missing or corrupted.');
          mime = mediaMime(row.name, prefix);
          if (!mime) fail(415, 'PREVIEW_UNSUPPORTED', 'This file cannot be previewed. Download it to view.');
          if (this.checked.size >= 64) this.checked.delete(this.checked.keys().next().value!);
          this.checked.set(fileId, { key, expiresAt: Date.now() + 60000, mime: mime! });
        }
        reply.header('Content-Type', mime!).header('Content-Disposition', 'inline').header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer').header('Content-Security-Policy', "sandbox; default-src 'none'").header('Accept-Ranges', 'bytes');
        let range: ReturnType<typeof byteRange>;
        try { range = byteRange(req.headers.range, info!.size); } catch { release(); return reply.code(416).header('Content-Range', `bytes */${info!.size}`).send(); }
        if (range) reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${info!.size}`).header('Content-Length', range.end - range.start + 1);
        else reply.header('Content-Length', info!.size);
        return reply.send(createReadStream(filename, range || undefined));
      } catch (error) { release(); throw error; }
    });
  }
}
