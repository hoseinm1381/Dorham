import { randomUUID, createHmac } from 'node:crypto';
import { z } from 'zod';
import { basePermissions, resolvePermissions, canManage, requestId as requestIdSchema, type Role, type Permission, type PublicUser, type Message, type VoiceRoom } from '@dorham/contracts';
import type { Connection, Database, Row } from './db';
import type { Config } from './config';
import { fail, hash } from './security';

export const publicUser = (u: Row): PublicUser => ({ id: u.id, username: u.username, displayName: u.display_name, bio: u.bio, avatar: u.avatar, status: u.status, instanceAdmin: Boolean(u.instance_admin) });
export class Service {
  notify: (kind: string, payload: any) => Promise<void> = async () => {};
  constructor(public db: Database, public c: Config) {}
  async mutate<T>(userId: string, requestId: string, operation: string, payload: unknown, fn: (tx: Connection) => Promise<T>): Promise<T> {
    requestIdSchema.parse(requestId);
    const fingerprint = hash(JSON.stringify(payload));
    return this.db.transaction(async tx => {
      const old = await tx.one('SELECT * FROM mutations WHERE user_id=? AND request_id=?', [userId, requestId]);
      if (old) {
        if (old.operation !== operation || old.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'Request identifier was already used with different input.');
        return JSON.parse(old.response) as T;
      }
      const result = await fn(tx);
      await tx.run('INSERT INTO mutations(user_id,request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)', [userId, requestId, operation, fingerprint, JSON.stringify(result), Date.now()]);
      return result;
    });
  }
  async member(tx: Connection, userId: string, serverId: string, permission?: Permission): Promise<Row> {
    const m = await tx.one('SELECT * FROM members WHERE server_id=? AND user_id=?', [serverId, userId]);
    if (!m || (permission && !basePermissions(m.role)[permission])) fail(403, 'FORBIDDEN', 'You do not have permission.');
    return m!;
  }
  async channel(tx: Connection, userId: string, channelId: string, permission: Permission = 'view'): Promise<Row & { role: Role; permissions: Record<Permission, boolean> }> {
    const ch = await tx.one('SELECT * FROM channels WHERE id=?', [channelId]);
    if (!ch) fail(404, 'NOT_FOUND', 'Channel not found.');
    const m = await this.member(tx, userId, ch!.server_id);
    const override = await tx.one('SELECT permissions FROM channel_overrides WHERE channel_id=? AND role=?', [channelId, m.role]);
    const permissions = resolvePermissions(m.role, override ? JSON.parse(override.permissions) : {});
    if (!permissions.view || !permissions[permission]) fail(403, 'FORBIDDEN', 'Channel permission denied.');
    return { ...ch!, role: m.role as Role, permissions };
  }
  async conversation(tx: Connection, userId: string, conversationId: string, write = false) {
    const cv = await tx.one('SELECT * FROM conversations WHERE id=?', [conversationId]);
    if (!cv) fail(404, 'NOT_FOUND', 'Conversation not found.');
    if (cv!.kind === 'dm') {
      if (!await tx.one('SELECT user_id FROM dm_members WHERE conversation_id=? AND user_id=?', [conversationId, userId])) fail(403, 'FORBIDDEN', 'Private conversation.');
    } else {
      const ch = await tx.one('SELECT id FROM channels WHERE conversation_id=?', [conversationId]);
      if (!ch) fail(404, 'NOT_FOUND', 'Channel not found.');
      await this.channel(tx, userId, ch!.id, write ? 'write' : 'view');
    }
    return cv!;
  }
  async bootstrap(userId: string) {
    return this.db.transaction(async tx => {
      const me = await tx.one('SELECT * FROM users WHERE id=?', [userId]);
      const servers = (await tx.all('SELECT s.*,m.role FROM servers s JOIN members m ON m.server_id=s.id WHERE m.user_id=? ORDER BY s.created_at', [userId])).map(s => ({ id: s.id, name: s.name, ownerId: s.owner_id, role: s.role }));
      const allChannels = await tx.all('SELECT c.* FROM channels c JOIN members m ON c.server_id=m.server_id WHERE m.user_id=? ORDER BY c.created_at', [userId]);
      const channels = [];
      for (const ch of allChannels) {
        try { const access = await this.channel(tx, userId, ch.id); channels.push({ id: ch.id, serverId: ch.server_id, name: ch.name, kind: ch.kind, conversationId: ch.conversation_id, permissions: access.permissions }); } catch { /* Hidden channel */ }
      }
      const dms = await tx.all('SELECT d.conversation_id,u.id,u.username,u.display_name,u.bio,u.avatar,u.status,u.instance_admin FROM dm_members d JOIN dm_members other ON other.conversation_id=d.conversation_id AND other.user_id<>d.user_id JOIN users u ON u.id=other.user_id WHERE d.user_id=?', [userId]);
      const unread: Record<string, { sequence: number; readSequence: number }> = {};
      for (const conversationId of [...channels.map(c => c.conversationId).filter(Boolean), ...dms.map(d => d.conversation_id)]) {
        const cv = await tx.one('SELECT sequence FROM conversations WHERE id=?', [conversationId]);
        const read = await tx.one('SELECT sequence FROM read_cursors WHERE conversation_id=? AND user_id=?', [conversationId, userId]);
        unread[conversationId] = { sequence: Number(cv?.sequence || 0), readSequence: Number(read?.sequence || 0) };
      }
      return { me: publicUser(me!), servers, channels, dms: dms.map(d => ({ id: d.conversation_id, user: publicUser(d) })), users: (await tx.all('SELECT * FROM users ORDER BY username LIMIT 100')).map(publicUser), unread, mediaTransport: this.c.mediaTransport, limits: { users: this.c.maxUsers, online: this.c.maxOnline, voice: this.c.maxVoice, roomShares: this.c.roomShares, globalShares: this.c.globalShares } };
    });
  }
  async createServer(userId: string, requestId: string, name: string) {
    const result = await this.mutate(userId, requestId, 'server.create', { name }, async tx => {
      const count = await tx.one('SELECT COUNT(*) AS count FROM members WHERE user_id=?', [userId]);
      if (count!.count >= 20) fail(409, 'LIMIT', 'You may join at most 20 servers.');
      const serverId = randomUUID(); const now = Date.now();
      await tx.run('INSERT INTO servers(id,name,owner_id,created_at) VALUES(?,?,?,?)', [serverId, name, userId, now]);
      await tx.run('INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)', [serverId, userId, 'owner', now]);
      await this.insertChannel(tx, serverId, 'general', 'text'); await this.insertChannel(tx, serverId, 'Lounge', 'voice');
      return { id: serverId };
    });
    await this.notify('state:changed', {}); return result;
  }
  async insertChannel(tx: Connection, serverId: string, name: string, kind: 'text' | 'voice') {
    const channelId = randomUUID(), conversationId = kind === 'text' ? randomUUID() : null, now = Date.now();
    if (conversationId) await tx.run('INSERT INTO conversations(id,kind,created_at) VALUES(?,?,?)', [conversationId, 'channel', now]);
    await tx.run('INSERT INTO channels(id,server_id,name,kind,conversation_id,created_at) VALUES(?,?,?,?,?,?)', [channelId, serverId, name, kind, conversationId, now]); return { id: channelId };
  }
  async changeServer(userId: string, requestId: string, serverId: string, body: { name?: string; delete?: boolean }) {
    const result = await this.mutate(userId, requestId, 'server.change', { serverId, ...body }, async tx => {
      const m = await this.member(tx, userId, serverId, 'manageChannels');
      if (body.delete) {
        if (m.role !== 'owner') fail(403, 'FORBIDDEN', 'Only the owner can delete a server.');
        const cvs = await tx.all('SELECT conversation_id FROM channels WHERE server_id=?', [serverId]);
        await tx.run('DELETE FROM servers WHERE id=?', [serverId]);
        for (const cv of cvs) if (cv.conversation_id) await tx.run('DELETE FROM conversations WHERE id=?', [cv.conversation_id]);
      } else await tx.run('UPDATE servers SET name=? WHERE id=?', [body.name!, serverId]);
      return { success: true };
    }); await this.notify('state:changed', {}); await this.notify('voice:changed', {}); return result;
  }
  async createChannel(userId: string, requestId: string, serverId: string, name: string, kind: 'text' | 'voice') {
    const result = await this.mutate(userId, requestId, 'channel.create', { serverId, name, kind }, async tx => {
      await this.member(tx, userId, serverId, 'manageChannels');
      const count = await tx.one('SELECT COUNT(*) AS count FROM channels WHERE server_id=?', [serverId]);
      if (count!.count >= 50) fail(409, 'LIMIT', 'Server channel limit reached.');
      return this.insertChannel(tx, serverId, name, kind);
    }); await this.notify('state:changed', {}); return result;
  }
  async changeChannel(userId: string, requestId: string, channelId: string, body: { name?: string; delete?: boolean; role?: Role; permissions?: Partial<Record<Permission, boolean>> }) {
    const result = await this.mutate(userId, requestId, 'channel.change', { channelId, ...body }, async tx => {
      const ch = await this.channel(tx, userId, channelId, 'manageChannels');
      if (body.delete) { await tx.run('DELETE FROM channels WHERE id=?', [channelId]); if (ch.conversation_id) await tx.run('DELETE FROM conversations WHERE id=?', [ch.conversation_id]); }
      else {
        if (body.name) await tx.run('UPDATE channels SET name=? WHERE id=?', [body.name, channelId]);
        if (body.role && body.permissions) await tx.run('INSERT INTO channel_overrides(channel_id,role,permissions) VALUES(?,?,?) ON CONFLICT(channel_id,role) DO UPDATE SET permissions=excluded.permissions', [channelId, body.role, JSON.stringify(body.permissions)]);
        for (const vm of await tx.all('SELECT * FROM voice_members WHERE channel_id=?', [channelId])) {
          try { await this.channel(tx, vm.user_id, channelId); } catch { await tx.run('DELETE FROM voice_members WHERE user_id=?', [vm.user_id]); continue; }
          try { await this.channel(tx, vm.user_id, channelId, 'speak'); } catch { await tx.run('UPDATE voice_members SET server_muted=1 WHERE user_id=?', [vm.user_id]); }
          try { await this.channel(tx, vm.user_id, channelId, 'share'); } catch { await tx.run('DELETE FROM share_leases WHERE user_id=?', [vm.user_id]); }
        }
      }
      return { success: true };
    }); await this.notify('state:changed', {}); await this.notify('voice:changed', {}); return result;
  }
  async invite(userId: string, requestId: string, serverId: string, value: string, expiresHours: number, uses: number) {
    return this.mutate(userId, requestId, 'invite.create', { serverId, expiresHours, uses }, async tx => {
      await this.member(tx, userId, serverId, 'manageMembers');
      await tx.run('INSERT INTO invites(hash,server_id,expires_at,remaining,created_by) VALUES(?,?,?,?,?)', [hash(value), serverId, Date.now() + expiresHours * 3600000, uses, userId]);
      return { code: value, url: `${this.c.publicUrl}/?invite=${value}` };
    });
  }
  async joinInvite(userId: string, requestId: string, code: string) {
    const result = await this.mutate(userId, requestId, 'invite.join', { code }, async tx => {
      const inv = await tx.one('SELECT * FROM invites WHERE hash=?', [hash(code)]);
      if (!inv || inv.expires_at < Date.now() || inv.remaining < 1) fail(404, 'INVITE_EXPIRED', 'Invite is invalid, expired, or exhausted.');
      if (await tx.one('SELECT role FROM members WHERE user_id=? AND server_id=?', [userId, inv!.server_id])) return { id: inv!.server_id };
      if ((await tx.one('SELECT COUNT(*) AS count FROM members WHERE user_id=?', [userId]))!.count >= 20) fail(409, 'LIMIT', 'Server membership limit reached.');
      await tx.run('INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)', [inv!.server_id, userId, 'member', Date.now()]);
      await tx.run('UPDATE invites SET remaining=remaining-1 WHERE hash=?', [hash(code)]); return { id: inv!.server_id };
    }); await this.notify('state:changed', {}); return result;
  }
  async members(userId: string, serverId: string) {
    await this.member(this.db, userId, serverId);
    return (await this.db.all('SELECT u.*,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.server_id=? ORDER BY m.joined_at', [serverId])).map(u => ({ user: publicUser(u), role: u.role }));
  }
  async changeMember(actorId: string, requestId: string, serverId: string, targetId: string, body: { role?: Role; remove?: boolean }) {
    const result = await this.mutate(actorId, requestId, 'member.change', { serverId, targetId, ...body }, async tx => {
      const actor = await this.member(tx, actorId, serverId, 'manageMembers'), target = await this.member(tx, targetId, serverId);
      if (!canManage(actor.role, target.role) || (body.role && (!canManage(actor.role, body.role) || body.role === 'owner'))) fail(403, 'HIERARCHY', 'You cannot manage this role.');
      if (body.remove) {
        await tx.run('DELETE FROM members WHERE server_id=? AND user_id=?', [serverId, targetId]);
        await tx.run('DELETE FROM voice_members WHERE user_id=? AND channel_id IN (SELECT id FROM channels WHERE server_id=?)', [targetId, serverId]);
      } else {
        await tx.run('UPDATE members SET role=? WHERE server_id=? AND user_id=?', [body.role!, serverId, targetId]);
        const voice = await tx.one('SELECT channel_id FROM voice_members WHERE user_id=? AND channel_id IN (SELECT id FROM channels WHERE server_id=?)', [targetId, serverId]);
        if (voice) {
          try {
            const access = await this.channel(tx, targetId, voice.channel_id);
            if (!access.permissions.speak) await tx.run('UPDATE voice_members SET server_muted=1 WHERE user_id=?', [targetId]);
            if (!access.permissions.share) await tx.run('DELETE FROM share_leases WHERE user_id=?', [targetId]);
          } catch { await tx.run('DELETE FROM voice_members WHERE user_id=?', [targetId]); }
        }
      }
      return { success: true };
    }); await this.notify('state:changed', {}); await this.notify('voice:changed', {}); return result;
  }
  async dm(userId: string, requestId: string, otherId: string) {
    return this.mutate(userId, requestId, 'dm.create', { otherId }, async tx => {
      if (otherId === userId || !await tx.one('SELECT id FROM users WHERE id=?', [otherId])) fail(400, 'INVALID_USER', 'Select another registered user.');
      const pair = [userId, otherId].sort().join(':');
      const old = await tx.one('SELECT conversation_id FROM dm_pairs WHERE pair_key=?', [pair]);
      if (old) return { id: old.conversation_id };
      const cv = randomUUID(); await tx.run('INSERT INTO conversations(id,kind,created_at) VALUES(?,?,?)', [cv, 'dm', Date.now()]);
      for (const u of [userId, otherId]) await tx.run('INSERT INTO dm_members(conversation_id,user_id) VALUES(?,?)', [cv, u]);
      await tx.run('INSERT INTO dm_pairs(pair_key,conversation_id) VALUES(?,?)', [pair, cv]); return { id: cv };
    });
  }
  async messageView(tx: Connection, messageId: string): Promise<Message> {
    const m = await tx.one('SELECT m.*,u.username,u.display_name,u.bio,u.avatar,u.status,u.instance_admin FROM messages m JOIN users u ON m.user_id=u.id WHERE m.id=?', [messageId]);
    if (!m) fail(404, 'NOT_FOUND', 'Message not found.');
    const reactions: Record<string, string[]> = {};
    for (const r of await tx.all('SELECT emoji,user_id FROM reactions WHERE message_id=?', [messageId])) (reactions[r.emoji] ||= []).push(r.user_id);
    return { id: m!.id, conversationId: m!.conversation_id, sequence: Number(m!.sequence), author: publicUser({ ...m!, id: m!.user_id }), content: m!.deleted ? '' : m!.content, replyTo: m!.reply_to, createdAt: Number(m!.created_at), editedAt: m!.edited_at ? Number(m!.edited_at) : null, deleted: Boolean(m!.deleted), reactions: Object.entries(reactions).map(([emoji, userIds]) => ({ emoji, userIds })) };
  }
  async event(tx: Connection, conversationId: string, kind: string, payload: unknown) {
    await tx.run('UPDATE conversations SET sequence=sequence+1 WHERE id=?', [conversationId]);
    const cv = await tx.one('SELECT sequence FROM conversations WHERE id=?', [conversationId]);
    const event = { conversationId, sequence: Number(cv!.sequence), kind, payload };
    if ((await tx.one('SELECT COUNT(*) AS count FROM events'))!.count >= 50000) await tx.run('DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY created_at LIMIT 200)');
    await tx.run('INSERT INTO events(id,conversation_id,sequence,kind,payload,created_at) VALUES(?,?,?,?,?,?)', [randomUUID(), conversationId, event.sequence, kind, JSON.stringify(payload), Date.now()]); return event;
  }
  async send(userId: string, requestId: string, conversationId: string, content: string, replyTo?: string | null) {
    const event = await this.mutate(userId, requestId, 'message.send', { conversationId, content, replyTo }, async tx => {
      const cv = await this.conversation(tx, userId, conversationId, true);
      if (replyTo && !await tx.one('SELECT id FROM messages WHERE id=? AND conversation_id=?', [replyTo, conversationId])) fail(400, 'INVALID_REPLY', 'Reply target is unavailable.');
      if ((await tx.one('SELECT COUNT(*) AS count FROM messages'))!.count >= this.c.maxMessages) {
        await tx.run('DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY created_at LIMIT 200)');
      }
      const messageId = randomUUID();
      await tx.run('INSERT INTO messages(id,conversation_id,sequence,user_id,content,reply_to,created_at) VALUES(?,?,?,?,?,?,?)', [messageId, conversationId, Number(cv.sequence) + 1, userId, content, replyTo || null, Date.now()]);
      return this.event(tx, conversationId, 'message', await this.messageView(tx, messageId));
    }); await this.notify('conversation:event', event); return event;
  }
  async changeMessage(userId: string, requestId: string, messageId: string, body: { content?: string; delete?: boolean; emoji?: string; removeReaction?: boolean }) {
    const event = await this.mutate(userId, requestId, 'message.change', { messageId, ...body }, async tx => {
      const m = await tx.one('SELECT * FROM messages WHERE id=?', [messageId]);
      if (!m) fail(404, 'NOT_FOUND', 'Message not found.');
      const cv = await this.conversation(tx, userId, m!.conversation_id, true);
      if (body.emoji) {
        if (m!.deleted) fail(409, 'DELETED', 'Message has been deleted.');
        if (body.removeReaction) await tx.run('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', [messageId, userId, body.emoji]);
        else {
          if ((await tx.one('SELECT COUNT(*) AS count FROM reactions WHERE message_id=?', [messageId]))!.count >= 100) fail(409, 'LIMIT', 'Reaction limit reached.');
          await tx.run('INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?) ON CONFLICT DO NOTHING', [messageId, userId, body.emoji]);
        }
      } else {
        if (m!.user_id !== userId) {
          const ch = cv.kind === 'channel' ? await tx.one('SELECT id FROM channels WHERE conversation_id=?', [m!.conversation_id]) : undefined;
          if (!body.delete || !ch) fail(403, 'FORBIDDEN', 'You can edit only your own messages.');
          await this.channel(tx, userId, ch!.id, 'moderate');
        }
        if (m!.deleted) fail(409, 'DELETED', 'Message has been deleted.');
        await tx.run('UPDATE messages SET content=?,deleted=?,edited_at=? WHERE id=?', [body.delete ? '' : body.content!, body.delete ? 1 : 0, Date.now(), messageId]);
        if (body.delete) await tx.run('DELETE FROM reactions WHERE message_id=?', [messageId]);
      }
      return this.event(tx, m!.conversation_id, 'message', await this.messageView(tx, messageId));
    }); await this.notify('conversation:event', event); return event;
  }
  async history(userId: string, conversationId: string, before?: number, after?: number) {
    return this.db.transaction(async tx => {
      const cv = await this.conversation(tx, userId, conversationId);
      if (after !== undefined) {
        const min = await tx.one('SELECT MIN(sequence) AS first FROM events WHERE conversation_id=?', [conversationId]);
        if (after > Number(cv.sequence) || (after < Number(cv.sequence) && (min?.first == null || Number(min.first) > after + 1))) return { reset: true, sequence: Number(cv.sequence), events: [] };
        const rows = await tx.all('SELECT * FROM events WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT 200', [conversationId, after]);
        return { reset: false, sequence: Number(cv.sequence), events: rows.map(e => ({ conversationId, sequence: Number(e.sequence), kind: e.kind, payload: JSON.parse(e.payload) })) };
      }
      const rows = await tx.all('SELECT id FROM messages WHERE conversation_id=? AND sequence<? ORDER BY sequence DESC LIMIT 50', [conversationId, before || Number.MAX_SAFE_INTEGER]);
      const messages = []; for (const m of rows.reverse()) messages.push(await this.messageView(tx, m.id));
      return { messages, sequence: Number(cv.sequence), hasMore: rows.length === 50 };
    });
  }
  async read(userId: string, requestId: string, conversationId: string, sequence: number) {
    return this.mutate(userId, requestId, 'conversation.read', { conversationId, sequence }, async tx => {
      const cv = await this.conversation(tx, userId, conversationId); const old = await tx.one('SELECT sequence FROM read_cursors WHERE conversation_id=? AND user_id=?', [conversationId, userId]);
      await tx.run('INSERT INTO read_cursors(conversation_id,user_id,sequence) VALUES(?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET sequence=excluded.sequence', [conversationId, userId, Math.max(Number(old?.sequence || 0), Math.min(sequence, Number(cv.sequence)))]); return { success: true };
    });
  }
  async maintainRoom(tx: Connection, channelId: string) {
    const now = Date.now();
    await tx.run('DELETE FROM share_leases WHERE expires_at<?', [now]);
    await tx.run('DELETE FROM voice_members WHERE heartbeat<?', [now - 30000]);
    const current = await tx.one('SELECT * FROM coordinators WHERE channel_id=?', [channelId]);
    const candidate = await tx.one('SELECT user_id,heartbeat FROM voice_members WHERE channel_id=? AND eligible=1 AND heartbeat>=? ORDER BY joined_at,user_id LIMIT 1', [channelId, now - 15000]);
    const valid = current?.user_id && await tx.one('SELECT user_id,heartbeat FROM voice_members WHERE channel_id=? AND user_id=? AND eligible=1 AND heartbeat>=?', [channelId, current.user_id, now - 15000]);
    const chosen = valid || candidate;
    const changed = (current?.user_id || null) !== (chosen?.user_id || null) || (current && current.expires_at < now && chosen);
    const epoch = Number(current?.epoch || 0) + (changed || !current ? 1 : 0);
    await tx.run('INSERT INTO coordinators(channel_id,user_id,epoch,expires_at) VALUES(?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET user_id=excluded.user_id,epoch=excluded.epoch,expires_at=excluded.expires_at', [channelId, chosen?.user_id || null, epoch, chosen ? Number(chosen.heartbeat) + 15000 : 0]);
  }
  async room(userId: string, channelId: string): Promise<VoiceRoom> {
    return this.db.transaction(async tx => { await this.channel(tx, userId, channelId); await this.maintainRoom(tx, channelId); return this.roomView(tx, channelId); });
  }
  async roomView(tx: Connection, channelId: string): Promise<VoiceRoom> {
    const members = [];
    for (const vm of await tx.all('SELECT v.*,u.username,u.display_name,u.bio,u.avatar,u.status,u.instance_admin FROM voice_members v JOIN users u ON u.id=v.user_id WHERE v.channel_id=? ORDER BY v.joined_at', [channelId])) {
      let canShare = false; try { canShare = (await this.channel(tx, vm.user_id, channelId, 'share')).permissions.share; } catch { /* permission removed */ }
      members.push({ user: publicUser({ ...vm, id: vm.user_id }), muted: Boolean(vm.muted), deafened: Boolean(vm.deafened), serverMuted: Boolean(vm.server_muted), canShare, epoch: vm.epoch, eligible: Boolean(vm.eligible), joinedAt: Number(vm.joined_at) });
    }
    const shares = (await tx.all('SELECT * FROM share_leases WHERE channel_id=? AND expires_at>=?', [channelId, Date.now()])).map(s => ({ id: s.id, channelId: s.channel_id, userId: s.user_id, expiresAt: Number(s.expires_at) }));
    const coordinator = await tx.one('SELECT * FROM coordinators WHERE channel_id=?', [channelId]);
    return { channelId, members, shares, coordinatorId: coordinator?.user_id || null, coordinatorEpoch: Number(coordinator?.epoch || 0), transport: this.c.mediaTransport };
  }
  async joinVoice(userId: string, socketId: string, channelId: string, eligible: boolean) {
    const result = await this.db.transaction(async tx => {
      const ch = await this.channel(tx, userId, channelId);
      if (ch.kind !== 'voice') fail(400, 'NOT_VOICE', 'Select a voice channel.');
      await this.maintainRoom(tx, channelId);
      const previous = await tx.one('SELECT * FROM voice_members WHERE user_id=?', [userId]);
      if (previous && previous.socket_id === socketId && previous.channel_id === channelId) return { epoch: previous.epoch, room: await this.roomView(tx, channelId) };
      const count = await tx.one('SELECT COUNT(*) AS count FROM voice_members WHERE channel_id=? AND user_id<>?', [channelId, userId]);
      if (count!.count >= this.c.maxVoice) fail(409, 'ROOM_FULL', 'Voice channel is full.');
      await tx.run('DELETE FROM voice_members WHERE user_id=?', [userId]);
      const epoch = randomUUID(), now = Date.now();
      await tx.run('INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,server_muted,eligible,heartbeat,joined_at) VALUES(?,?,?,?,?,?,?,?)', [userId, channelId, socketId, epoch, ch.permissions.speak ? 0 : 1, eligible ? 1 : 0, now, now]);
      if (previous && previous.channel_id !== channelId) await this.maintainRoom(tx, previous.channel_id);
      await this.maintainRoom(tx, channelId); return { epoch, room: await this.roomView(tx, channelId) };
    }); await this.notify('voice:changed', {}); return { ...result, iceServers: this.iceServers(userId) };
  }
  iceServers(userId: string) {
    const servers: RTCIceServer[] = this.c.stunUrls.length ? [{ urls: this.c.stunUrls }] : [];
    if (this.c.turnUrls.length) {
      const username = this.c.turnSecret ? `${Math.floor(Date.now() / 1000) + 3600}:${userId}` : this.c.turnUsername;
      const credential = this.c.turnSecret ? createHmac('sha1', this.c.turnSecret).update(username).digest('base64') : this.c.turnPassword;
      servers.push({ urls: this.c.turnUrls, username, credential });
    } return servers;
  }
  async voiceAction(userId: string, socketId: string, action: 'heartbeat' | 'leave' | 'state', body: { muted?: boolean; deafened?: boolean; eligible?: boolean } = {}) {
    const result = await this.db.transaction(async tx => {
      const vm = await tx.one('SELECT * FROM voice_members WHERE user_id=? AND socket_id=?', [userId, socketId]);
      if (!vm) fail(409, 'NOT_IN_VOICE', 'Voice session is no longer active.');
      if (action === 'leave') await tx.run('DELETE FROM voice_members WHERE user_id=?', [userId]);
      else {
        try { await this.channel(tx, userId, vm!.channel_id); } catch { await tx.run('DELETE FROM voice_members WHERE user_id=?', [userId]); return { removed: true }; }
        await tx.run('UPDATE voice_members SET heartbeat=?,muted=?,deafened=?,eligible=? WHERE user_id=?', [Date.now(), body.muted === undefined ? vm!.muted : Number(body.muted), body.deafened === undefined ? vm!.deafened : Number(body.deafened), body.eligible === undefined ? vm!.eligible : Number(body.eligible), userId]);
        await tx.run('UPDATE share_leases SET expires_at=? WHERE user_id=? AND expires_at>=?', [Date.now() + 30000, userId, Date.now()]);
      }
      await this.maintainRoom(tx, vm!.channel_id); return { room: await this.roomView(tx, vm!.channel_id) };
    }); if (action !== 'heartbeat') await this.notify('voice:changed', {}); return result;
  }
  async share(userId: string, socketId: string, requestId: string, stop = false) {
    const result = await this.mutate(userId, requestId, stop ? 'share.stop' : 'share.start', {}, async tx => {
      const vm = await tx.one('SELECT * FROM voice_members WHERE user_id=? AND socket_id=?', [userId, socketId]);
      if (!vm) fail(409, 'NOT_IN_VOICE', 'Join voice before sharing.');
      if (stop) { await tx.run('DELETE FROM share_leases WHERE user_id=?', [userId]); return { lease: null }; }
      await this.channel(tx, userId, vm!.channel_id, 'share'); await this.maintainRoom(tx, vm!.channel_id);
      const old = await tx.one('SELECT * FROM share_leases WHERE user_id=?', [userId]);
      if (old) return { lease: { id: old.id, channelId: old.channel_id, userId, expiresAt: Number(old.expires_at) } };
      const global = await tx.one('SELECT COUNT(*) AS count FROM share_leases'), room = await tx.one('SELECT COUNT(*) AS count FROM share_leases WHERE channel_id=?', [vm!.channel_id]);
      if (global!.count >= this.c.globalShares || room!.count >= this.c.roomShares) fail(409, 'SHARE_LIMIT', 'Screen-sharing capacity is full.');
      const lease = { id: randomUUID(), channelId: vm!.channel_id, userId, expiresAt: Date.now() + 30000 };
      await tx.run('INSERT INTO share_leases(id,user_id,channel_id,expires_at) VALUES(?,?,?,?)', [lease.id, userId, lease.channelId, lease.expiresAt]); return { lease };
    }); await this.notify('voice:changed', {}); return result;
  }
  async moderate(userId: string, requestId: string, channelId: string, targetId: string, action: string) {
    const result = await this.mutate(userId, requestId, 'voice.moderate', { channelId, targetId, action }, async tx => {
      const ch = await this.channel(tx, userId, channelId, 'moderate'), target = await this.member(tx, targetId, ch.server_id);
      if (userId !== targetId && !canManage(ch.role, target.role)) fail(403, 'HIERARCHY', 'Cannot moderate this member.');
      if (action === 'kick') await tx.run('DELETE FROM voice_members WHERE channel_id=? AND user_id=?', [channelId, targetId]);
      if (action === 'stopShare') await tx.run('DELETE FROM share_leases WHERE channel_id=? AND user_id=?', [channelId, targetId]);
      if (action === 'mute' || action === 'unmute') {
        if (action === 'unmute') await this.channel(tx, targetId, channelId, 'speak');
        await tx.run('UPDATE voice_members SET server_muted=? WHERE channel_id=? AND user_id=?', [action === 'mute' ? 1 : 0, channelId, targetId]);
      }
      await this.maintainRoom(tx, channelId); return { success: true };
    }); await this.notify('voice:changed', {}); return result;
  }
  async cleanup() {
    await this.db.transaction(async tx => {
      const now = Date.now();
      await tx.run('DELETE FROM sessions WHERE expires_at<?', [now]); await tx.run('DELETE FROM used_refresh WHERE expires_at<?', [now]);
      await tx.run('DELETE FROM invites WHERE expires_at<? OR remaining<1', [now]);
      await tx.run('DELETE FROM mutations WHERE created_at<?', [now - 86400000]);
      await tx.run('DELETE FROM events WHERE id IN (SELECT id FROM events WHERE created_at<? ORDER BY created_at LIMIT 1000)', [now - 7 * 86400000]);
      await tx.run('DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE created_at<? ORDER BY created_at LIMIT 500)', [now - this.c.retentionDays * 86400000]);
      for (const ch of await tx.all("SELECT id FROM channels WHERE kind='voice'")) await this.maintainRoom(tx, ch.id);
    });
  }
}

export const schemas = {
  name: z.string().trim().min(1).max(64),
  profile: z.object({ displayName: z.string().trim().min(1).max(48), bio: z.string().max(500), status: z.enum(['online', 'idle', 'busy']), requestId: requestIdSchema }),
  channel: z.object({ name: z.string().trim().min(1).max(64), kind: z.enum(['text', 'voice']), requestId: requestIdSchema }),
  role: z.enum(['owner', 'administrator', 'moderator', 'member']),
  permissions: z.object({ view: z.boolean().optional(), write: z.boolean().optional(), speak: z.boolean().optional(), share: z.boolean().optional(), manageChannels: z.boolean().optional(), manageMembers: z.boolean().optional(), moderate: z.boolean().optional() }).strict()
};
