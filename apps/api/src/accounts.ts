import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyContextConfig } from 'fastify';
import { z } from 'zod';
import { passwordSchema, registerSchema, requestId, id } from '@dorham/contracts';
import type { Connection, Row } from './db';
import { publicUser, type Service } from './service';
import { fail, hash, passwordHash, passwordVerify, token } from './security';

export async function initialRecoveryCodes(tx: Connection, userId: string) {
  const codes = Array.from({ length: 8 }, () => token().slice(0, 24));
  for (const code of codes) await tx.run('INSERT INTO recovery_codes(user_id,code_hash,created_at) VALUES(?,?,?)', [userId, hash(code), Date.now()]);
  return codes;
}
export const normalizeAnswer = (answer: string) => answer.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
export async function audit(tx: Connection, actor: string | null, action: string, target: string | null, details: unknown = {}) {
  await tx.run('INSERT INTO audit_log(id,actor_id,action,target_id,details,created_at) VALUES(?,?,?,?,?,?)', [randomUUID(), actor, action, target, JSON.stringify(details), Date.now()]);
  await tx.run('DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log ORDER BY created_at DESC LIMIT 500 OFFSET 10000)');
}
export async function administrator(tx: Connection, userId: string) {
  const user = await tx.one('SELECT * FROM users WHERE id=? AND banned=0 AND guest=0', [userId]);
  if (!user?.instance_admin) fail(403, 'FORBIDDEN', 'Global administration is required.'); return user!;
}
async function verifyCurrent(user: Row, password: string) {
  if (user.guest || !await passwordVerify(user.password_hash, password)) fail(401, 'INVALID_CREDENTIALS', 'Current password is incorrect.');
}
export function publicAccountRoutes(app: FastifyInstance, service: Service, authRate: FastifyContextConfig, sessionFor: (userId: string, native: boolean, reply: FastifyReply, device?: string) => Promise<Record<string, unknown>>, disconnect: () => Promise<void>) {
  const { db, c } = service;
  app.post('/api/v1/auth/guest', { config: authRate }, async (req, reply) => {
    const b = z.object({ displayName: z.string().trim().min(1).max(48), code: z.string().min(10).max(100), language: z.enum(['en-US', 'fa-IR']).optional(), requestId }).parse(req.body);
    if (!c.guestsEnabled) fail(403, 'GUESTS_DISABLED', 'Guest access is disabled.');
    const userId = await db.transaction(async tx => {
      const fingerprint = hash(JSON.stringify({ code: b.code, displayName: b.displayName }));
      const previous = await tx.one("SELECT m.user_id,m.fingerprint,m.response,u.guest FROM mutations m JOIN users u ON u.id=m.user_id WHERE m.request_id=? AND m.operation='guest.create'", [b.requestId]);
      if (previous) { if (!previous.guest) fail(409, 'NOT_GUEST', 'This account is already registered.'); if (previous.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'Request identifier was already used with different input.'); return { userId: previous.user_id as string, ...JSON.parse(previous.response || '{}') }; }
      const inv = await tx.one('SELECT i.*,s.allow_guests FROM invites i JOIN servers s ON s.id=i.server_id WHERE i.hash=? AND i.expires_at>=? AND i.remaining>0', [hash(b.code), Date.now()]);
      if (!inv?.allow_guests) fail(403, 'GUEST_INVITE_REQUIRED', 'A valid invitation to a guest-enabled server is required.');
      if (Number((await tx.one('SELECT COUNT(*) AS count FROM users'))!.count) >= c.maxUsers) fail(409, 'ACCOUNT_LIMIT', 'This instance has reached its account limit.');
      if (Number((await tx.one('SELECT COUNT(*) AS count FROM users WHERE guest=1'))!.count) >= c.maxGuests) fail(409, 'GUEST_LIMIT', 'Guest capacity has been reached.');
      const uid = randomUUID(), now = Date.now();
      await tx.run('INSERT INTO users(id,username,display_name,password_hash,guest,created_at,language) VALUES(?,?,?,?,1,?,?)', [uid, `guest_${uid.replaceAll('-', '').slice(0, 20)}`, b.displayName, '!guest-no-password', now, b.language || '']);
      await tx.run('INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)', [inv!.server_id, uid, 'member', now]);
      await tx.run('UPDATE invites SET remaining=remaining-1 WHERE hash=?', [hash(b.code)]);
      await tx.run('INSERT INTO mutations(user_id,request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)', [uid, b.requestId, 'guest.create', fingerprint, JSON.stringify({ serverId: inv!.server_id, channelId: inv!.channel_id }), now]);
      await audit(tx, uid, 'guest.create', inv!.server_id); return { userId: uid, serverId: inv!.server_id, channelId: inv!.channel_id };
    });
    await service.notify('state:changed', {});
    return reply.code(201).send({ ...await sessionFor(userId.userId, req.headers['x-dorham-native'] === '1', reply, String(req.headers['user-agent'] || 'Guest device')), landing: { serverId: userId.serverId, channelId: userId.channelId } });
  });
  app.post('/api/v1/auth/recover', { config: authRate }, async req => {
    const b = z.object({ username: z.string().trim().min(1).max(32), code: z.string().max(128), password: passwordSchema, requestId }).parse(req.body);
    const subject = hash(b.username.toLowerCase());
    await db.transaction(async tx => {
      const old = await tx.one('SELECT * FROM recovery_attempts WHERE subject=?', [subject]);
      const attempts = old && old.expires_at > Date.now() ? Number(old.attempts) + 1 : 1;
      if (attempts > 5) fail(429, 'RECOVERY_LIMIT', 'Recovery is temporarily unavailable. Try later or contact the administrator.');
      await tx.run('INSERT INTO recovery_attempts(subject,attempts,expires_at) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET attempts=excluded.attempts,expires_at=excluded.expires_at', [subject, attempts, old && old.expires_at > Date.now() ? old.expires_at : Date.now() + 3600000]);
    });
    const user = await db.one('SELECT * FROM users WHERE username=? AND guest=0 AND banned=0', [b.username.toLowerCase()]);
    const codeHash = hash(b.code.trim());
    if (!user || !await db.one('SELECT code_hash FROM recovery_codes WHERE user_id=? AND code_hash=?', [user!.id, codeHash])) fail(401, 'RECOVERY_INVALID', 'Recovery details are invalid or unavailable.');
    const encoded = await passwordHash(b.password);
    await db.transaction(async tx => {
      if (!await tx.one('SELECT code_hash FROM recovery_codes WHERE user_id=? AND code_hash=?', [user!.id, codeHash])) fail(401, 'RECOVERY_INVALID', 'Recovery details are invalid or unavailable.');
      await tx.run('DELETE FROM recovery_codes WHERE user_id=? AND code_hash=?', [user!.id, codeHash]);
      await tx.run('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?', [encoded, user!.id]);
      await tx.run('DELETE FROM sessions WHERE user_id=?', [user!.id]); await tx.run('DELETE FROM voice_members WHERE user_id=?', [user!.id]);
      await audit(tx, user!.id, 'account.recover', user!.id);
    });
    await disconnect(); await service.notify('voice:changed', {}); return { success: true };
  });
}

export function protectedAccountRoutes(api: FastifyInstance, service: Service, disconnect: () => Promise<void>) {
  const { db, c } = service;
  api.post('/auth/upgrade', async req => {
    const b = registerSchema.parse(req.body); if (!req.account.guest) fail(409, 'NOT_GUEST', 'This account is already registered.');
    const encoded = await passwordHash(b.password);
    const result = await service.mutate(req.account.id, b.requestId, 'guest.upgrade', { username: b.username, displayName: b.displayName, password: hash(b.password) }, async tx => {
      if (!c.registrationOpen) fail(403, 'REGISTRATION_CLOSED', 'Registration is closed.');
      if (!await tx.one('SELECT id FROM users WHERE id=? AND guest=1', [req.account.id])) fail(409, 'NOT_GUEST', 'This account is already registered.');
      await tx.run('UPDATE users SET username=?,display_name=?,password_hash=?,guest=0 WHERE id=?', [b.username.toLowerCase(), b.displayName, encoded, req.account.id]);
      await audit(tx, req.account.id, 'guest.upgrade', req.account.id); return { success: true };
    }); await service.notify('state:changed', {}); return result;
  });
  api.get('/auth/sessions', async req => ({ sessions: (await db.all('SELECT id,device_name,native,created_at,last_seen,expires_at FROM sessions WHERE user_id=? AND expires_at>=? ORDER BY created_at DESC', [req.account.id, Date.now()])).map(s => ({ id: s.id, device: s.device_name, native: Boolean(s.native), createdAt: Number(s.created_at), lastSeen: Number(s.last_seen), expiresAt: Number(s.expires_at), current: s.id === req.session.id })) }));
  api.post('/auth/sessions/revoke', async req => {
    const b = z.object({ sessionId: id.optional(), all: z.boolean().default(false), requestId }).refine(b => b.sessionId || b.all).parse(req.body);
    await service.mutate(req.account.id, b.requestId, 'session.revoke', b, async tx => {
      if (b.all) await tx.run('DELETE FROM sessions WHERE user_id=?', [req.account.id]);
      else await tx.run('DELETE FROM sessions WHERE user_id=? AND id=?', [req.account.id, b.sessionId]);
      await audit(tx, req.account.id, 'session.revoke', b.all ? 'all' : b.sessionId!); return { success: true };
    }); await disconnect(); return { success: true };
  });
  api.post('/auth/recovery-codes', async req => {
    const b = z.object({ password: z.string().max(128), requestId }).parse(req.body); await verifyCurrent(req.account, b.password);
    const codes = Array.from({ length: 8 }, () => token().slice(0, 24));
    await db.transaction(async tx => {
      if (await tx.one('SELECT request_id FROM mutations WHERE user_id=? AND request_id=?', [req.account.id, b.requestId])) fail(409, 'CODES_ALREADY_ISSUED', 'Codes are shown only once. Generate a new set if needed.');
      await tx.run('DELETE FROM recovery_codes WHERE user_id=?', [req.account.id]);
      for (const code of codes) await tx.run('INSERT INTO recovery_codes(user_id,code_hash,created_at) VALUES(?,?,?)', [req.account.id, hash(code), Date.now()]);
      await tx.run('INSERT INTO mutations(user_id,request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)', [req.account.id, b.requestId, 'recovery.issue', hash('issued'), '{"success":true}', Date.now()]);
      await audit(tx, req.account.id, 'recovery.issue', req.account.id);
    }); return { codes };
  });
  api.get('/auth/recovery', async req => ({ prompt: !req.account.guest && !req.account.recovery_prompt_seen, question: (await db.one('SELECT question FROM recovery_questions WHERE user_id=?', [req.account.id]))?.question || null, codesRemaining: Number((await db.one('SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id=?', [req.account.id]))!.count), questions: ['What was your favorite school subject?', 'What is a memorable personal preference?', 'Custom question'] }));
  api.post('/auth/recovery-acknowledge', async req => {
    z.object({ requestId }).parse(req.body);
    if (req.account.guest) fail(403, 'GUEST_ACCOUNT', 'Register before setting up recovery.');
    await db.run('UPDATE users SET recovery_prompt_seen=1 WHERE id=?', [req.account.id]); return { success: true };
  });
  api.post('/auth/recovery-question', async req => {
    const b = z.object({ password: z.string().max(128), question: z.string().trim().min(5).max(200), answer: z.string().min(1).max(200), requestId }).parse(req.body); await verifyCurrent(req.account, b.password);
    const encoded = await passwordHash(normalizeAnswer(b.answer));
    return service.mutate(req.account.id, b.requestId, 'recovery.question', { question: b.question, answer: hash(normalizeAnswer(b.answer)) }, async tx => {
      await tx.run('INSERT INTO recovery_questions(user_id,question,answer_hash) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET question=excluded.question,answer_hash=excluded.answer_hash', [req.account.id, b.question, encoded]);
      await audit(tx, req.account.id, 'recovery.question', req.account.id); return { success: true };
    });
  });
  api.get('/admin/users', async req => { await administrator(db, req.account.id); return { users: (await db.all('SELECT * FROM users ORDER BY created_at LIMIT 250')).map(publicUser) }; });
  api.get('/admin/audit', async req => { await administrator(db, req.account.id); const before = z.coerce.number().int().positive().optional().parse((req.query as any).before); return { events: await db.all('SELECT * FROM audit_log WHERE created_at<? ORDER BY created_at DESC LIMIT 100', [before || Date.now() + 1]) }; });
  api.post('/admin/users/:id', async req => {
    const targetId = id.parse((req.params as any).id), b = z.object({ action: z.enum(['ban', 'unban', 'revoke', 'resetPassword']), requestId }).parse(req.body);
    await administrator(db, req.account.id);
    const temporaryPassword = b.action === 'resetPassword' ? token().slice(0, 20) : null;
    const encoded = temporaryPassword ? await passwordHash(temporaryPassword) : null;
    await db.transaction(async tx => {
      await administrator(tx, req.account.id);
      if (await tx.one('SELECT request_id FROM mutations WHERE user_id=? AND request_id=?', [req.account.id, b.requestId])) fail(409, 'ALREADY_APPLIED', 'Administrative action was already applied.');
      const target = await tx.one('SELECT * FROM users WHERE id=?', [targetId]);
      if (!target || target.instance_admin) fail(403, 'PROTECTED_ACCOUNT', 'The global administrator cannot be modified by this operation.');
      if (b.action === 'ban' || b.action === 'unban') await tx.run('UPDATE users SET banned=? WHERE id=?', [b.action === 'ban' ? 1 : 0, targetId]);
      if (encoded) { if (target!.guest) fail(400, 'GUEST_ACCOUNT', 'Convert the guest account before setting a password.'); await tx.run('UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?', [encoded, targetId]); await tx.run('DELETE FROM recovery_codes WHERE user_id=?', [targetId]); }
      if (b.action !== 'unban') { await tx.run('DELETE FROM sessions WHERE user_id=?', [targetId]); await tx.run('DELETE FROM voice_members WHERE user_id=?', [targetId]); }
      await tx.run('INSERT INTO mutations(user_id,request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)', [req.account.id, b.requestId, 'admin.user', hash(JSON.stringify({ targetId, action: b.action })), '{"success":true}', Date.now()]);
      await audit(tx, req.account.id, `admin.${b.action}`, targetId);
    }); await disconnect(); await service.notify('voice:changed', {}); await service.notify('state:changed', {});
    return { success: true, ...(temporaryPassword ? { temporaryPassword } : {}) };
  });
}
