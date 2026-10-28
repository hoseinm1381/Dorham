import Fastify, { type FastifyRequest, type FastifyReply, type FastifyContextConfig } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { Server as SocketServer, type Socket } from 'socket.io';
import { z, ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { existsSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile, unlink, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { registerSchema, credentialsSchema, messageSchema, requestId, id, signalSchema } from '@dorham/contracts';
import { config, type Config } from './config';
import { openDatabase, type Row } from './db';
import { Service, schemas, publicUser } from './service';
import { AppError, fail, hash, token, equal, passwordHash, passwordVerify } from './security';
import { Sfu } from './sfu';

declare module 'fastify' { interface FastifyRequest { account: Row; session: Row; } }
export async function createApp(c: Config = config(), options: { logger?: boolean; rateLimit?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? !process.env.VITEST, bodyLimit: 128 * 1024, trustProxy: false, requestTimeout: 15000 });
  await mkdir(c.dataDir, { recursive: true });
  const lockPath = path.join(c.dataDir, 'instance.lock');
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid instance.lock. Verify no server is running before removing it.');
    try { process.kill(pid, 0); throw new Error('Another server already owns this data directory.'); } catch (e: any) { if (e.code !== 'ESRCH') throw e; unlinkSync(lockPath); }
  }
  const lock = openSync(lockPath, 'wx'); writeSync(lock, String(process.pid)); closeSync(lock);
  const db = await openDatabase(c), service = new Service(db, c), sfu = new Sfu(c, service);
  // Voice is transient. Restart fences every previous signaling epoch.
  await db.transaction(async tx => { await tx.run('DELETE FROM voice_members'); await tx.run('UPDATE coordinators SET user_id=NULL,epoch=epoch+1,expires_at=0'); });
  const avatarDir = path.join(c.dataDir, 'avatars'); await mkdir(avatarDir, { recursive: true });
  async function storageStatus() {
    // Logical pages include committed WAL pages that have not reached the main file.
    const databaseBytes = c.databaseUrl ? null : Number((await db.one('PRAGMA page_count'))!.page_count) * Number((await db.one('PRAGMA page_size'))!.page_size);
    let avatarBytes = 0; for (const name of await readdir(avatarDir)) avatarBytes += (await stat(path.join(avatarDir, name))).size;
    const databaseBudgetBytes = c.maxDatabaseMiB * 1048576, avatarBudgetBytes = c.maxAvatarsMiB * 1048576;
    const warnings = [];
    if (databaseBytes !== null && databaseBytes >= databaseBudgetBytes * 0.8) warnings.push('Database is at least 80% of its page budget. Prune data or migrate storage.');
    if (avatarBytes >= avatarBudgetBytes * 0.8) warnings.push('Avatar storage is at least 80% of its budget.');
    return { databaseBytes, databaseBudgetBytes: c.databaseUrl ? null : databaseBudgetBytes, avatarBytes, avatarBudgetBytes, warnings };
  }
  await app.register(cookie);
  const allowed = (origin: string | undefined) => !origin || c.origins.includes(origin);
  await app.register(cors, { origin: (origin, cb) => cb(null, allowed(origin)), credentials: true, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Request-Id', 'X-Dorham-Native'] });
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'", 'https:', 'wss:', ...(c.production ? [] : ['http:', 'ws:'])], mediaSrc: ["'self'", 'blob:'], objectSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginEmbedderPolicy: false });
  await app.register(rateLimit, { global: options.rateLimit !== false, max: 600, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: 256 * 1024, files: 1, fields: 0 } });
  app.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 400) } });
    if (error instanceof AppError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error.code === 'SQLITE_FULL') return reply.code(507).send({ error: { code: 'STORAGE_FULL', message: 'Storage is full. Contact the instance administrator.' } });
    if (error.code?.includes('CONSTRAINT') || error.code === '23505') return reply.code(409).send({ error: { code: 'CONFLICT', message: 'The record already exists or changed. Refresh and retry.' } });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: { code: 'REQUEST_ERROR', message: error.message } });
    app.log.error({ err: error }, 'Request failed'); return reply.code(500).send({ error: { code: 'INTERNAL', message: 'The request could not be completed.' } });
  });
  app.addHook('onRequest', async (req, reply) => {
    if (!allowed(req.headers.origin)) return reply.code(403).send({ error: { code: 'ORIGIN', message: 'Origin is not allowed.' } });
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  async function resolveSession(raw?: string) {
    if (!raw || raw.length > 512) return undefined;
    const session = await db.one('SELECT * FROM sessions WHERE access_hash=? AND access_expires>=? AND expires_at>=?', [hash(raw), Date.now(), Date.now()]);
    if (!session) return undefined;
    const account = await db.one('SELECT * FROM users WHERE id=?', [session.user_id]); return account ? { session, account } : undefined;
  }
  async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    const resolved = await resolveSession(bearer || req.cookies.dorham_session);
    if (!resolved) fail(401, 'UNAUTHENTICATED', 'Please sign in.');
    req.account = resolved!.account; req.session = resolved!.session;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !bearer) {
      if (!req.headers.origin || !allowed(req.headers.origin) || !equal(String(req.headers['x-csrf-token'] || ''), req.session.csrf)) fail(403, 'CSRF', 'Refresh your session and retry.');
    }
  }
  const setCookie = (reply: FastifyReply, access: string) => reply.setCookie('dorham_session', access, { httpOnly: true, secure: c.secure, sameSite: 'lax', path: '/', maxAge: 30 * 86400 });
  async function sessionFor(userId: string, native: boolean, reply: FastifyReply) {
    const access = token(), refresh = native ? token() : null, csrf = token(), now = Date.now();
    await db.transaction(async tx => {
      const old = await tx.all('SELECT id FROM sessions WHERE user_id=? ORDER BY created_at DESC', [userId]);
      for (const s of old.slice(2)) await tx.run('DELETE FROM sessions WHERE id=?', [s.id]);
      await tx.run('INSERT INTO sessions(id,user_id,access_hash,refresh_hash,csrf,native,access_expires,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [randomUUID(), userId, hash(access), refresh ? hash(refresh) : null, csrf, Number(native), now + (native ? 15 * 60000 : 30 * 86400000), now + 30 * 86400000, now]);
    });
    const account = await db.one('SELECT * FROM users WHERE id=?', [userId]);
    if (!native) setCookie(reply, access);
    return { user: publicUser(account!), csrf, ...(native ? { accessToken: access, refreshToken: refresh } : {}) };
  }
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async () => { await db.one('SELECT version FROM schema_migrations LIMIT 1'); return { status: 'ready', database: db.dialect }; });
  app.get('/api/v1/config', async () => ({ registrationOpen: c.registrationOpen, mediaTransport: c.mediaTransport, publicUrl: c.publicUrl }));
  const authRate: FastifyContextConfig = options.rateLimit === false ? {} : { rateLimit: { max: 60, timeWindow: '15 minutes' } };
  app.post('/api/v1/auth/register', { config: authRate }, async (req, reply) => {
    if (!c.registrationOpen) fail(403, 'REGISTRATION_CLOSED', 'Registration is closed.');
    const body = registerSchema.parse(req.body), username = body.username.toLowerCase();
    const encoded = await passwordHash(body.password);
    const userId = await db.transaction(async tx => {
      const count = await tx.one('SELECT COUNT(*) AS count FROM users');
      if (count!.count >= c.maxUsers) fail(409, 'ACCOUNT_LIMIT', 'This instance has reached its account limit.');
      if (await tx.one('SELECT id FROM users WHERE username=?', [username])) fail(409, 'USERNAME_TAKEN', 'This username is unavailable.');
      const userId = randomUUID(); await tx.run('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)', [userId, username, body.displayName, encoded, Date.now()]); return userId;
    });
    await service.notify('state:changed', {}); return reply.code(201).send(await sessionFor(userId, req.headers['x-dorham-native'] === '1', reply));
  });
  app.post('/api/v1/auth/login', { config: authRate }, async (req, reply) => {
    const body = credentialsSchema.extend({ requestId }).parse(req.body);
    const user = await db.one('SELECT * FROM users WHERE username=?', [body.username.toLowerCase()]);
    // Hash a nonexistent user's attempt as well, avoiding a cheap timing oracle.
    if (!user) { await passwordHash(body.password); fail(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.'); }
    if (!await passwordVerify(user!.password_hash, body.password)) fail(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
    return sessionFor(user!.id, req.headers['x-dorham-native'] === '1', reply);
  });
  app.post('/api/v1/auth/refresh', { config: authRate }, async req => {
    const body = z.object({ refreshToken: z.string().min(20).max(512), requestId }).parse(req.body), fingerprint = hash(body.refreshToken);
    const outcome = await db.transaction(async tx => {
      const reused = await tx.one('SELECT session_id FROM used_refresh WHERE hash=?', [fingerprint]);
      if (reused) { await tx.run('DELETE FROM sessions WHERE id=?', [reused.session_id]); return null; }
      const old = await tx.one('SELECT * FROM sessions WHERE refresh_hash=? AND native=1 AND expires_at>=?', [fingerprint, Date.now()]);
      if (!old) return null;
      const accessToken = token(), refreshToken = token();
      await tx.run('INSERT INTO used_refresh(hash,session_id,expires_at) VALUES(?,?,?)', [fingerprint, old.id, old.expires_at]);
      await tx.run('UPDATE sessions SET access_hash=?,refresh_hash=?,access_expires=? WHERE id=?', [hash(accessToken), hash(refreshToken), Date.now() + 15 * 60000, old.id]);
      return { accessToken, refreshToken, csrf: old.csrf };
    });
    if (!outcome) fail(401, 'REFRESH_INVALID', 'Session expired. Sign in again.'); return outcome;
  });
  await app.register(async api => {
    api.addHook('preHandler', authenticate);
    api.get('/auth/me', async req => ({ user: publicUser(req.account), csrf: req.session.csrf }));
    api.post('/auth/logout', async (req, reply) => { z.object({ requestId }).parse(req.body); await db.run('DELETE FROM sessions WHERE id=?', [req.session.id]); for (const s of io.sockets.sockets.values()) if (s.data.sessionId === req.session.id) s.disconnect(true); reply.clearCookie('dorham_session', { path: '/' }); return { success: true }; });
    api.post('/auth/password', async req => {
      const b = z.object({ currentPassword: z.string().max(128), password: z.string().min(10).max(128), requestId }).parse(req.body);
      if (!await passwordVerify(req.account.password_hash, b.currentPassword)) fail(401, 'INVALID_CREDENTIALS', 'Current password is incorrect.');
      const encoded = await passwordHash(b.password);
      const result = await service.mutate(req.account.id, b.requestId, 'password.change', { fingerprint: hash(b.password) }, async tx => { await tx.run('UPDATE users SET password_hash=? WHERE id=?', [encoded, req.account.id]); await tx.run('DELETE FROM sessions WHERE user_id=? AND id<>?', [req.account.id, req.session.id]); return { success: true }; });
      await disconnectInvalidSessions(); return result;
    });
    api.post('/admin/claim', async req => {
      const b = z.object({ secret: z.string().max(256), requestId }).parse(req.body);
      if (!c.bootstrapSecret || !equal(c.bootstrapSecret, b.secret)) fail(403, 'FORBIDDEN', 'Bootstrap secret is invalid.');
      return service.mutate(req.account.id, b.requestId, 'admin.claim', {}, async tx => {
        if (await tx.one("SELECT value FROM meta WHERE key='admin_claimed'")) fail(409, 'ALREADY_CLAIMED', 'Instance administration has already been claimed.');
        await tx.run('UPDATE users SET instance_admin=1 WHERE id=?', [req.account.id]); await tx.run("INSERT INTO meta(key,value) VALUES('admin_claimed',?)", [req.account.id]); return { success: true };
      });
    });
    api.get('/bootstrap', async req => service.bootstrap(req.account.id));
    api.patch('/profile', async req => {
      const b = schemas.profile.parse(req.body);
      const result = await service.mutate(req.account.id, b.requestId, 'profile.change', b, async tx => { await tx.run('UPDATE users SET display_name=?,bio=?,status=? WHERE id=?', [b.displayName, b.bio, b.status, req.account.id]); return { success: true }; }); await service.notify('state:changed', {}); return result;
    });
    api.post('/profile/avatar', async req => {
      const rid = requestId.parse(req.headers['x-request-id']); const file = await req.file();
      if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) fail(400, 'IMAGE_REQUIRED', 'Upload a PNG, JPEG, or WebP image.');
      const bytes = await file!.toBuffer();
      let image: Buffer; try { image = await sharp(bytes, { limitInputPixels: 16000000 }).rotate().resize(128, 128, { fit: 'cover' }).webp({ quality: 80 }).toBuffer(); } catch { fail(400, 'INVALID_IMAGE', 'Image could not be decoded.'); }
      if (image!.length > 96 * 1024) fail(400, 'IMAGE_TOO_LARGE', 'Compressed avatar is too large.');
      const result = await service.mutate(req.account.id, rid, 'avatar.change', { hash: hash(bytes.toString('base64')) }, async tx => {
        let size = 0; for (const f of await readdir(avatarDir)) size += (await stat(path.join(avatarDir, f))).size;
        if (size + image!.length > c.maxAvatarsMiB * 1024 * 1024) fail(507, 'AVATAR_QUOTA', 'Avatar storage is full.');
        const name = `${randomUUID()}.webp`; await writeFile(path.join(avatarDir, name), image!, { flag: 'wx' });
        const old = await tx.one('SELECT avatar FROM users WHERE id=?', [req.account.id]);
        await tx.run('UPDATE users SET avatar=? WHERE id=?', [`/avatars/${name}`, req.account.id]);
        if (old?.avatar) await unlink(path.join(avatarDir, path.basename(old.avatar))).catch(() => {}); return { avatar: `/avatars/${name}` };
      }); await service.notify('state:changed', {}); return result;
    });
    api.post('/servers', async req => { const b = z.object({ name: schemas.name, requestId }).parse(req.body); return service.createServer(req.account.id, b.requestId, b.name); });
    api.patch('/servers/:id', async req => { const b = z.object({ name: schemas.name.optional(), delete: z.boolean().optional(), requestId }).refine(b => b.name || b.delete).parse(req.body); return service.changeServer(req.account.id, b.requestId, id.parse((req.params as any).id), b); });
    api.post('/servers/:id/channels', async req => { const b = schemas.channel.parse(req.body); return service.createChannel(req.account.id, b.requestId, id.parse((req.params as any).id), b.name, b.kind); });
    api.patch('/channels/:id', async req => { const b = z.object({ name: schemas.name.optional(), delete: z.boolean().optional(), role: schemas.role.optional(), permissions: schemas.permissions.optional(), requestId }).refine(b => b.name || b.delete || (b.role && b.permissions)).parse(req.body); return service.changeChannel(req.account.id, b.requestId, id.parse((req.params as any).id), b); });
    api.post('/servers/:id/invites', async req => { const b = z.object({ hours: z.number().int().min(1).max(168).default(24), uses: z.number().int().min(1).max(100).default(10), requestId }).parse(req.body); return service.invite(req.account.id, b.requestId, id.parse((req.params as any).id), token(), b.hours, b.uses); });
    api.post('/invites/join', async req => { const b = z.object({ code: z.string().min(10).max(100), requestId }).parse(req.body); return service.joinInvite(req.account.id, b.requestId, b.code); });
    api.get('/servers/:id/members', async req => service.members(req.account.id, id.parse((req.params as any).id)));
    api.patch('/servers/:serverId/members/:userId', async req => { const b = z.object({ role: schemas.role.optional(), remove: z.boolean().optional(), requestId }).refine(b => b.role || b.remove).parse(req.body), p = req.params as any; return service.changeMember(req.account.id, b.requestId, id.parse(p.serverId), id.parse(p.userId), b); });
    api.post('/dms', async req => { const b = z.object({ userId: id, requestId }).parse(req.body); const result = await service.dm(req.account.id, b.requestId, b.userId); await service.notify('state:changed', {}); return result; });
    api.get('/conversations/:id/messages', async req => { const b = z.object({ before: z.coerce.number().int().min(1).optional(), after: z.coerce.number().int().min(0).optional() }).parse(req.query); return service.history(req.account.id, id.parse((req.params as any).id), b.before, b.after); });
    api.post('/messages', async req => { const b = messageSchema.parse(req.body); return service.send(req.account.id, b.requestId, b.conversationId, b.content, b.replyTo); });
    api.patch('/messages/:id', async req => { const b = z.object({ content: z.string().trim().min(1).max(4000).optional(), delete: z.boolean().optional(), emoji: z.enum(['👍', '❤️', '😂', '🎉', '👀', '✅']).optional(), removeReaction: z.boolean().optional(), requestId }).refine(b => b.content || b.delete || b.emoji).parse(req.body); return service.changeMessage(req.account.id, b.requestId, id.parse((req.params as any).id), b); });
    api.post('/conversations/:id/read', async req => { const b = z.object({ sequence: z.number().int().min(0), requestId }).parse(req.body); return service.read(req.account.id, b.requestId, id.parse((req.params as any).id), b.sequence); });
    api.get('/voice/:id', async req => service.room(req.account.id, id.parse((req.params as any).id)));
    api.post('/voice/:id/moderate', async req => { const b = z.object({ userId: id, action: z.enum(['mute', 'unmute', 'kick', 'stopShare']), requestId }).parse(req.body); return service.moderate(req.account.id, b.requestId, id.parse((req.params as any).id), b.userId, b.action); });
    api.get('/admin/metrics', async req => {
      if (!req.account.instance_admin) fail(403, 'FORBIDDEN', 'Instance administrator required.');
      let disk = 0; for (const f of await readdir(c.dataDir)) { const s = await stat(path.join(c.dataDir, f)); if (s.isFile()) disk += s.size; }
      return { uptimeSeconds: process.uptime(), memory: process.memoryUsage(), cpu: process.cpuUsage(), dataBytes: disk, storage: await storageStatus(), connectedUsers: new Set([...io.sockets.sockets.values()].map(s => s.data.userId)).size, accounts: (await db.one('SELECT COUNT(*) AS count FROM users'))!.count, messages: (await db.one('SELECT COUNT(*) AS count FROM messages'))!.count, shares: (await db.one('SELECT COUNT(*) AS count FROM share_leases'))!.count };
    });
  }, { prefix: '/api/v1' });
  const io = new SocketServer(app.server, { cors: { origin: c.origins, credentials: true }, maxHttpBufferSize: 128 * 1024, connectionStateRecovery: { maxDisconnectionDuration: 120000, skipMiddlewares: false }, pingInterval: 20000, pingTimeout: 10000, allowRequest: (req, callback) => callback(null, allowed(req.headers.origin)) });
  io.use(async (socket, next) => {
    try {
      const cookieValue = String(socket.handshake.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('dorham_session='))?.split('=')[1];
      const resolved = await resolveSession(socket.handshake.auth.token || cookieValue);
      if (!resolved) throw new Error('Please sign in.');
      if (!socket.handshake.auth.token && !equal(String(socket.handshake.auth.csrf || ''), resolved.session.csrf)) throw new Error('Invalid session proof.');
      socket.data.userId = resolved.account.id; socket.data.sessionId = resolved.session.id;
      const users = new Set([...io.sockets.sockets.values()].map(s => s.data.userId));
      if (!users.has(socket.data.userId) && users.size >= c.maxOnline) throw new Error('This instance is at its online capacity.');
      next();
    } catch (error: any) { next(new Error(error.message)); }
  });
  async function validSocket(socket: Socket) {
    const session = await db.one('SELECT id FROM sessions WHERE id=? AND expires_at>=? AND access_expires>=?', [socket.data.sessionId, Date.now(), Date.now()]);
    if (!session) { socket.disconnect(true); fail(401, 'UNAUTHENTICATED', 'Session expired.'); }
  }
  async function disconnectInvalidSessions() { for (const s of io.sockets.sockets.values()) { try { await validSocket(s); } catch { /* already disconnected */ } } }
  service.notify = async (kind, payload) => {
    if (kind === 'conversation:event') {
      for (const s of io.sockets.sockets.values()) { try { await service.conversation(db, s.data.userId, payload.conversationId); s.emit(kind, payload); } catch { /* access denied */ } }
    } else if (kind === 'voice:changed') {
      for (const s of io.sockets.sockets.values()) {
        s.emit('voice:directory', await service.voiceDirectory(s.data.userId));
        if (!s.data.voiceChannel) continue;
        const vm = await db.one('SELECT channel_id FROM voice_members WHERE user_id=? AND socket_id=?', [s.data.userId, s.id]);
        if (!vm) { s.emit('voice:removed', {}); s.data.voiceChannel = null; continue; }
        try { s.emit('voice:room', await service.room(s.data.userId, vm.channel_id)); } catch { s.emit('voice:removed', {}); s.data.voiceChannel = null; }
      }
      if (sfu.client) {
        try { await sfu.synchronize(); }
        catch (err) { app.log.error({ err }, 'SFU permission synchronization failed'); fail(503, 'SFU_UNAVAILABLE', 'Control changes were saved, but SFU enforcement could not be confirmed. Retry when the media server is available.'); }
      }
    } else io.emit(kind, payload);
  };
  io.on('connection', socket => {
    // The second capacity check closes the asynchronous handshake race.
    const connected = new Set([...io.sockets.sockets.values()].map(s => s.data.userId));
    if (connected.size > c.maxOnline) { socket.emit('capacity', { message: 'Online capacity reached.' }); socket.disconnect(true); return; }
    io.emit('presence', { userId: socket.data.userId, online: true });
    let windowStart = Date.now(), eventCount = 0;
    const handle = (event: string, fn: (body: any) => Promise<any>) => socket.on(event, async (body, ack) => {
      if (typeof ack !== 'function') return;
      try {
        if (Date.now() - windowStart > 10000) { windowStart = Date.now(); eventCount = 0; }
        if (++eventCount > 400) fail(429, 'RATE_LIMIT', 'Too many real-time actions.');
        await validSocket(socket); const result = await fn(body); ack({ ok: true, data: result });
      } catch (e: any) { ack({ ok: false, error: { code: e.code || 'INVALID_REQUEST', message: e instanceof ZodError ? 'Invalid real-time payload.' : ((e.status && e.status < 500) || e.code === 'TURN_UNAVAILABLE' ? e.message : 'Real-time action failed.') } }); }
    });
    handle('message:send', async b => { const m = messageSchema.parse(b); return service.send(socket.data.userId, m.requestId, m.conversationId, m.content, m.replyTo); });
    handle('typing', async b => { const v = z.object({ conversationId: id, active: z.boolean() }).parse(b); await service.conversation(db, socket.data.userId, v.conversationId, true); for (const s of io.sockets.sockets.values()) { if (s.id === socket.id) continue; try { await service.conversation(db, s.data.userId, v.conversationId); s.emit('typing', { ...v, userId: socket.data.userId }); } catch { /* private */ } } return {}; });
    handle('voice:join', async b => { const v = z.object({ channelId: id, eligible: z.boolean() }).parse(b); const result = await service.joinVoice(socket.data.userId, socket.id!, v.channelId, v.eligible); socket.data.voiceChannel = v.channelId; return result; });
    handle('voice:leave', async b => { z.object({ requestId }).parse(b); const result = await service.voiceAction(socket.data.userId, socket.id!, 'leave'); socket.data.voiceChannel = null; return result; });
    handle('voice:heartbeat', async b => { const v = z.object({ eligible: z.boolean().optional() }).parse(b); const result = await service.voiceAction(socket.data.userId, socket.id!, 'heartbeat', v); if ('room' in result) socket.emit('voice:room', result.room); return result; });
    handle('voice:state', async b => { const v = z.object({ muted: z.boolean(), deafened: z.boolean(), requestId }).parse(b); return service.voiceAction(socket.data.userId, socket.id!, 'state', v); });
    handle('share:start', async b => { const v = z.object({ requestId }).parse(b); return service.share(socket.data.userId, socket.id!, v.requestId); });
    handle('share:stop', async b => { const v = z.object({ requestId }).parse(b); return service.share(socket.data.userId, socket.id!, v.requestId, true); });
    handle('voice:sfu', async b => { const v = z.object({ channelId: id }).parse(b); return sfu.credentials(socket.data.userId, socket.id!, v.channelId); });
    handle('voice:signal', async b => {
      const v = signalSchema.parse(b), sender = await db.one('SELECT * FROM voice_members WHERE user_id=? AND socket_id=? AND channel_id=? AND epoch=?', [socket.data.userId, socket.id, v.channelId, v.epoch]);
      if (!sender) fail(403, 'STALE_EPOCH', 'Voice session is no longer current.');
      await service.channel(db, socket.data.userId, v.channelId);
      const target = await db.one('SELECT * FROM voice_members WHERE user_id=? AND channel_id=?', [v.to, v.channelId]);
      if (!target) fail(404, 'PEER_LEFT', 'Peer left the room.');
      await service.channel(db, target!.user_id, v.channelId);
      for (const stream of v.streams || []) if (stream.kind === 'screen') {
        if (!await db.one('SELECT id FROM share_leases WHERE id=? AND user_id=? AND channel_id=? AND expires_at>=?', [stream.leaseId, socket.data.userId, v.channelId, Date.now()])) fail(403, 'SHARE_EXPIRED', 'Screen-share authorization expired.');
      }
      io.to(target!.socket_id).emit('voice:signal', { ...v, from: socket.data.userId }); return {};
    });
    socket.on('disconnect', async () => {
      try {
        const vm = await db.one('SELECT channel_id FROM voice_members WHERE socket_id=?', [socket.id]);
        if (vm) { await service.voiceAction(socket.data.userId, socket.id!, 'leave'); await service.notify('voice:changed', {}); }
        if (![...io.sockets.sockets.values()].some(s => s.data.userId === socket.data.userId)) io.emit('presence', { userId: socket.data.userId, online: false });
      } catch (err) { app.log.error({ err }, 'Disconnect cleanup failed'); }
    });
  });
  app.get('/api/v1/presence', { preHandler: authenticate }, async () => ({ online: [...new Set([...io.sockets.sockets.values()].map(s => s.data.userId))] }));
  await app.register(staticPlugin, { root: avatarDir, prefix: '/avatars/', decorateReply: false, maxAge: 3600000, immutable: true });
  const webRoot = path.resolve('apps/web/dist');
  if (existsSync(webRoot)) {
    await app.register(staticPlugin, { root: webRoot, prefix: '/' });
    app.setNotFoundHandler((req, reply) => { if (req.url.startsWith('/api/') || req.url.startsWith('/avatars/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } }); return reply.sendFile('index.html'); });
  }
  let maintenanceRunning = false, nextStorageCheck = 0, storageWasPressured = false;
  const maintenance = setInterval(async () => {
    if (maintenanceRunning) return; maintenanceRunning = true;
    try {
      await service.cleanup(); await disconnectInvalidSessions(); await service.notify('voice:changed', {});
      if (Date.now() >= nextStorageCheck) {
        nextStorageCheck = Date.now() + 60000; const storage = await storageStatus();
        if (storage.warnings.length && !storageWasPressured) app.log.warn({ storage }, 'Storage pressure: act before writes fail');
        storageWasPressured = storage.warnings.length > 0;
      }
    } catch (err) { app.log.error({ err }, 'Maintenance failed'); } finally { maintenanceRunning = false; }
  }, 5000); maintenance.unref();
  // Upgraded sockets must close before Fastify starts draining the HTTP server.
  // Waiting until onClose deadlocks a restart while any chat client stays online.
  app.addHook('preClose', async () => { clearInterval(maintenance); io.engine.close(); });
  app.addHook('onClose', async () => { await new Promise<void>(resolve => io.close(() => resolve())); await db.close(); if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === String(process.pid)) unlinkSync(lockPath); });
  return { app, db, service, io, config: c };
}
