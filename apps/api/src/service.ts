import { randomUUID, createHmac } from 'node:crypto';
import { z } from 'zod';
import { resolveCustomPermissions, canManage, requestId as requestIdSchema, type Role, type Permission, type PublicUser, type Message, type VoiceRoom, type VoicePresence, type CustomRole } from '@dorham/contracts';
import type { Connection, Database, Row } from './db';
import type { Config } from './config';
import { fail, hash } from './security';
import { CloudflareTurn, cloudflareTurnTtl } from './turn';
import { audit } from './accounts';

export const publicUser = (u: Row): PublicUser => ({ id: u.id, username: u.username, displayName: u.display_name, bio: u.bio, avatar: u.avatar, status: u.status, instanceAdmin: Boolean(u.instance_admin), guest: Boolean(u.guest), banned: Boolean(u.banned), language: u.language === 'fa-IR' ? 'fa-IR' : u.language === 'en-US' ? 'en-US' : undefined, mustChangePassword: Boolean(u.must_change_password) });
export class Service {
  notify: (kind: string, payload: any) => Promise<void> = async () => {};
  private cloudflareTurn: CloudflareTurn | null;
  constructor(public db: Database, public c: Config) { this.cloudflareTurn = c.cloudflareTurnKeyId ? new CloudflareTurn(c.cloudflareTurnKeyId, c.cloudflareTurnApiToken) : null; }
  async mutate<T>(userId: string, requestId: string, operation: string, payload: unknown, fn: (tx: Connection) => Promise<T>): Promise<T> {
    requestIdSchema.parse(requestId);
    const fingerprint = hash(JSON.stringify(payload));
    return this.db.transaction(async tx => {
      if (!await tx.one('SELECT id FROM users WHERE id=? AND banned=0', [userId])) fail(403, 'FORBIDDEN', 'Account access is unavailable.');
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
    const account = await tx.one('SELECT * FROM users WHERE id=? AND banned=0', [userId]);
    if (!account) fail(403, 'FORBIDDEN', 'Account access is unavailable.');
    if (account!.instance_admin) { if (!await tx.one('SELECT id FROM servers WHERE id=?', [serverId])) fail(404, 'NOT_FOUND', 'Server not found.'); return { server_id: serverId, user_id: userId, role: 'owner', globalAdmin: true }; }
    if (account!.guest && permission && ['manageChannels', 'manageMembers', 'moderate', 'createInvites'].includes(permission)) fail(403, 'GUEST_ACCOUNT', 'Register before using administration controls.');
    if (account!.guest && !(await tx.one('SELECT allow_guests FROM servers WHERE id=?', [serverId]))?.allow_guests) fail(403, 'GUESTS_DISABLED', 'This server does not allow guests.');
    const m = await tx.one('SELECT * FROM members WHERE server_id=? AND user_id=?', [serverId, userId]);
    if (!m || (permission && !(await this.memberPermissions(tx, m.role, userId, serverId))[permission])) fail(403, 'FORBIDDEN', 'You do not have permission.');
    return m!;
  }
  async assignedRoles(tx: Connection, userId: string, serverId: string): Promise<CustomRole[]> {
    return (await tx.all('SELECT r.* FROM custom_roles r JOIN member_roles mr ON mr.role_id=r.id AND mr.server_id=r.server_id WHERE mr.user_id=? AND r.server_id=? ORDER BY r.name', [userId, serverId])).map(r => ({ id: r.id, serverId: r.server_id, name: r.name, color: r.color, permissions: JSON.parse(r.permissions) }));
  }
  async memberPermissions(tx: Connection, role: Role, userId: string, serverId: string) {
    return resolveCustomPermissions(role, (await this.assignedRoles(tx, userId, serverId)).map(r => r.permissions));
  }
  async authority(tx: Connection, member: Row): Promise<Role> {
    if (member.role !== 'member') return member.role;
    const p = await this.memberPermissions(tx, member.role, member.user_id, member.server_id);
    return p.moderate || p.manageMembers ? 'moderator' : 'member';
  }
  async channel(tx: Connection, userId: string, channelId: string, permission: Permission = 'view'): Promise<Row & { role: Role; permissions: Record<Permission, boolean> }> {
    const ch = await tx.one('SELECT * FROM channels WHERE id=?', [channelId]);
    if (!ch) fail(404, 'NOT_FOUND', 'Channel not found.');
    const m = await this.member(tx, userId, ch!.server_id);
    const override = await tx.one('SELECT permissions FROM channel_overrides WHERE channel_id=? AND role=?', [channelId, m.role]);
    const permissions = resolveCustomPermissions(m.role, (await this.assignedRoles(tx, userId, ch!.server_id)).map(r => r.permissions), override ? JSON.parse(override.permissions) : {});
    if ((await tx.one('SELECT guest FROM users WHERE id=?', [userId]))?.guest) { permissions.manageChannels = false; permissions.manageMembers = false; permissions.moderate = false; permissions.createInvites = false; }
    const restriction = await tx.one('SELECT sharing_allowed FROM voice_restrictions WHERE channel_id=? AND user_id=?', [channelId, userId]);
    if (restriction && !restriction.sharing_allowed) permissions.share = false;
    if (ch!.kind === 'voice' && m.role !== 'owner') {
      const required = await tx.all('SELECT tag_id FROM channel_tags WHERE channel_id=?', [channelId]);
      if (required.length) { const assigned = new Set((await tx.all('SELECT tag_id FROM user_tags WHERE user_id=?', [userId])).map(t => t.tag_id)); const allowed = ch!.tag_mode === 'ALL' ? required.every(t => assigned.has(t.tag_id)) : required.some(t => assigned.has(t.tag_id)); if (!allowed) fail(403, 'TAG_REQUIRED', 'This voice channel requires an assigned tag.'); }
    }
    if (!permissions.view || !permissions[permission]) fail(403, 'FORBIDDEN', 'Channel permission denied.');
    return { ...ch!, role: m.role as Role, permissions };
  }
  async conversation(tx: Connection, userId: string, conversationId: string, write = false) {
    const cv = await tx.one('SELECT * FROM conversations WHERE id=?', [conversationId]);
    if (!cv) fail(404, 'NOT_FOUND', 'Conversation not found.');
    if (cv!.kind === 'dm') {
      if (!await tx.one('SELECT user_id FROM dm_members WHERE conversation_id=? AND user_id=?', [conversationId, userId])) fail(403, 'FORBIDDEN', 'Private conversation.');
      if (write) { const other = await tx.one('SELECT user_id FROM dm_members WHERE conversation_id=? AND user_id<>?', [conversationId, userId]); if (other) await this.allowDirectMessage(tx, userId, other.user_id); }
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
      const servers = (await tx.all('SELECT s.*,m.role FROM servers s LEFT JOIN members m ON m.server_id=s.id AND m.user_id=? WHERE m.user_id IS NOT NULL OR ?=1 ORDER BY s.created_at', [userId, me!.instance_admin])).map(s => ({ id: s.id, name: s.name, ownerId: s.owner_id, role: me!.instance_admin ? 'owner' : s.role, allowGuests: Boolean(s.allow_guests) }));
      for (const server of servers) Object.assign(server, { permissions: await this.memberPermissions(tx, server.role as Role, userId, server.id) });
      const allChannels = await tx.all('SELECT c.* FROM channels c LEFT JOIN members m ON c.server_id=m.server_id AND m.user_id=? WHERE m.user_id IS NOT NULL OR ?=1 ORDER BY c.created_at', [userId, me!.instance_admin]);
      const channels = [];
      for (const ch of allChannels) {
        try { const access = await this.channel(tx, userId, ch.id); channels.push({ id: ch.id, serverId: ch.server_id, name: ch.name, kind: ch.kind, conversationId: ch.conversation_id, permissions: access.permissions, locked: Boolean(ch.locked), userLimit: Math.min(ch.user_limit, this.c.maxVoice), tagMode: ch.tag_mode, requiredTags: (await tx.all('SELECT tag_id FROM channel_tags WHERE channel_id=?', [ch.id])).map(t => t.tag_id) }); } catch { /* Hidden channel */ }
      }
      const dms = await tx.all('SELECT d.conversation_id,u.id,u.username,u.display_name,u.bio,u.avatar,u.status,u.instance_admin FROM dm_members d JOIN dm_members other ON other.conversation_id=d.conversation_id AND other.user_id<>d.user_id JOIN users u ON u.id=other.user_id WHERE d.user_id=? AND d.hidden=0', [userId]);
      const blockedUsers = (await tx.all('SELECT u.* FROM users u JOIN user_blocks b ON b.blocked_id=u.id WHERE b.user_id=?', [userId])).map(publicUser);
      const blockedPeers = new Set((await tx.all('SELECT user_id,blocked_id FROM user_blocks WHERE user_id=? OR blocked_id=?', [userId, userId])).map(b => b.user_id === userId ? b.blocked_id : b.user_id));
      const unread: Record<string, { sequence: number; readSequence: number }> = {};
      for (const conversationId of [...channels.map(c => c.conversationId).filter(Boolean), ...dms.map(d => d.conversation_id)]) {
        const cv = await tx.one('SELECT sequence FROM conversations WHERE id=?', [conversationId]);
        const read = await tx.one('SELECT sequence FROM read_cursors WHERE conversation_id=? AND user_id=?', [conversationId, userId]);
        unread[conversationId] = { sequence: Number(cv?.sequence || 0), readSequence: Number(read?.sequence || 0) };
      }
      return { me: publicUser(me!), servers, channels, voicePresence: await this.voiceDirectory(userId, tx), dms: dms.map(d => ({ id: d.conversation_id, user: publicUser(d), blocked: blockedPeers.has(d.id), blockedByMe: blockedUsers.some(u => u.id === d.id) })), blockedUsers, users: (await tx.all('SELECT * FROM users ORDER BY username LIMIT 250')).map(publicUser), unread, mediaTransport: this.c.mediaTransport, screenPolicy: { maxBitrate: this.c.screenMaxBitrate, maxFrameRate: this.c.screenMaxFrameRate }, limits: { users: this.c.maxUsers, online: this.c.maxOnline, voice: this.c.maxVoice, roomShares: this.c.roomShares, globalShares: this.c.globalShares } };
    });
  }
  async createServer(userId: string, requestId: string, name: string) {
    const result = await this.mutate(userId, requestId, 'server.create', { name }, async tx => {
      if ((await tx.one('SELECT guest FROM users WHERE id=?', [userId]))?.guest) fail(403, 'GUEST_ACCOUNT', 'Register before creating a server.');
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
  async changeServer(userId: string, requestId: string, serverId: string, body: { name?: string; delete?: boolean; allowGuests?: boolean }) {
    const result = await this.mutate(userId, requestId, 'server.change', { serverId, ...body }, async tx => {
      const m = await this.member(tx, userId, serverId, 'manageChannels');
      if (body.delete) {
        if (m.role !== 'owner') fail(403, 'FORBIDDEN', 'Only the owner can delete a server.');
        const cvs = await tx.all('SELECT conversation_id FROM channels WHERE server_id=?', [serverId]);
        await tx.run('DELETE FROM servers WHERE id=?', [serverId]);
        for (const cv of cvs) if (cv.conversation_id) await tx.run('DELETE FROM conversations WHERE id=?', [cv.conversation_id]);
      } else { if (body.name) await tx.run('UPDATE servers SET name=? WHERE id=?', [body.name, serverId]); if (body.allowGuests !== undefined) { await tx.run('UPDATE servers SET allow_guests=? WHERE id=?', [Number(body.allowGuests), serverId]); await this.revalidateVoice(tx, serverId); } }
      await audit(tx, userId, 'server.change', serverId, { delete: Boolean(body.delete), allowGuests: body.allowGuests });
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
      if (body.role && !canManage(ch.role, body.role)) fail(403, 'HIERARCHY', 'You cannot manage this role.');
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
      await this.member(tx, userId, serverId, 'createInvites');
      if ((await tx.one('SELECT COUNT(*) AS count FROM invites WHERE server_id=? AND expires_at>? AND remaining>0', [serverId, Date.now()]))!.count >= 50) fail(409, 'LIMIT', 'Revoke an active invitation before creating another.');
      await tx.run('INSERT INTO invites(hash,server_id,expires_at,remaining,created_by,code) VALUES(?,?,?,?,?,?)', [hash(value), serverId, Date.now() + expiresHours * 3600000, uses, userId, value]);
      return { code: value, url: `${this.c.publicUrl}/?invite=${value}` };
    });
  }
  async invitations(userId: string, serverId: string) {
    await this.member(this.db, userId, serverId, 'createInvites');
    return { invites: (await this.db.all('SELECT code,expires_at,remaining FROM invites WHERE server_id=? AND expires_at>? AND remaining>0 AND code IS NOT NULL ORDER BY expires_at DESC', [serverId, Date.now()])).map(r => ({ code: r.code, url: `${this.c.publicUrl}/?invite=${r.code}`, expiresAt: Number(r.expires_at), remaining: r.remaining })) };
  }
  async revokeInvitation(userId: string, rid: string, serverId: string, code: string) {
    return this.mutate(userId, rid, 'invite.revoke', { serverId, code }, async tx => {
      await this.member(tx, userId, serverId, 'createInvites');
      await tx.run('DELETE FROM invites WHERE server_id=? AND hash=?', [serverId, hash(code)]);
      await audit(tx, userId, 'invite.revoke', serverId); return { success: true };
    });
  }
  async customRoles(userId: string, serverId: string) {
    await this.member(this.db, userId, serverId);
    return { roles: (await this.db.all('SELECT * FROM custom_roles WHERE server_id=? ORDER BY name', [serverId])).map(r => ({ id: r.id, serverId, name: r.name, color: r.color, permissions: JSON.parse(r.permissions) })) };
  }
  async changeCustomRole(userId: string, rid: string, serverId: string, body: { roleId?: string; name?: string; color?: string; permissions?: Partial<Record<Permission, boolean>>; delete?: boolean; userId?: string; assigned?: boolean }) {
    const result = await this.mutate(userId, rid, 'role.change', { serverId, ...body }, async tx => {
      const actor = await this.member(tx, userId, serverId);
      if (!['owner', 'administrator'].includes(actor.role) || (await tx.one('SELECT guest FROM users WHERE id=?', [userId]))?.guest) fail(403, 'FORBIDDEN', 'Only owners and administrators can manage custom roles.');
      const existing = body.roleId ? await tx.one('SELECT * FROM custom_roles WHERE id=? AND server_id=?', [body.roleId, serverId]) : undefined;
      if (body.roleId && !existing) fail(404, 'NOT_FOUND', 'Role not found.');
      const roleId = body.roleId || randomUUID();
      if (body.userId) {
        if (!existing || body.assigned === undefined) fail(400, 'INVALID_ROLE', 'Choose a role and assignment.');
        const target = await this.member(tx, body.userId, serverId);
        if (!await tx.one('SELECT user_id FROM members WHERE server_id=? AND user_id=?', [serverId, body.userId])) fail(404, 'NOT_FOUND', 'Member not found.');
        if (actor.role !== 'owner' && !canManage(actor.role, target.role)) fail(403, 'HIERARCHY', 'You cannot manage this member.');
        if ((await tx.one('SELECT guest FROM users WHERE id=?', [body.userId]))?.guest) fail(403, 'GUEST_ROLE', 'Register the guest before assigning custom roles.');
        if (body.assigned) await tx.run('INSERT INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?) ON CONFLICT DO NOTHING', [serverId, body.userId, roleId]);
        else await tx.run('DELETE FROM member_roles WHERE server_id=? AND user_id=? AND role_id=?', [serverId, body.userId, roleId]);
      } else if (body.delete) {
        if (!existing) fail(404, 'NOT_FOUND', 'Role not found.');
        await tx.run('DELETE FROM custom_roles WHERE id=?', [roleId]);
      } else {
        if (!body.name || !body.color || !body.permissions) fail(400, 'INVALID_ROLE', 'Set a name, color and permissions.');
        if (await tx.one('SELECT id FROM custom_roles WHERE server_id=? AND name=? AND id<>?', [serverId, body.name, roleId])) fail(409, 'ROLE_NAME', 'A role with this name already exists.');
        if (!existing && (await tx.one('SELECT COUNT(*) AS count FROM custom_roles WHERE server_id=?', [serverId]))!.count >= 32) fail(409, 'LIMIT', 'A server can have up to 32 custom roles.');
        await tx.run('INSERT INTO custom_roles(id,server_id,name,color,permissions) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,permissions=excluded.permissions', [roleId, serverId, body.name, body.color, JSON.stringify(body.permissions)]);
      }
      await this.revalidateVoice(tx, serverId); await audit(tx, userId, 'role.change', roleId, { serverId, ...body }); return { id: roleId };
    }); await this.notify('state:changed', {}); await this.notify('voice:changed', {}); return result;
  }
  async joinInvite(userId: string, requestId: string, code: string) {
    const result = await this.mutate(userId, requestId, 'invite.join', { code }, async tx => {
      const inv = await tx.one('SELECT * FROM invites WHERE hash=?', [hash(code)]);
      if (!inv || inv.expires_at < Date.now() || inv.remaining < 1) fail(404, 'INVITE_EXPIRED', 'Invite is invalid, expired, or exhausted.');
      const account = await tx.one('SELECT guest FROM users WHERE id=?', [userId]);
      if (account!.guest && !(await tx.one('SELECT allow_guests FROM servers WHERE id=?', [inv!.server_id]))?.allow_guests) fail(403, 'GUESTS_DISABLED', 'This server does not allow guests.');
      if (await tx.one('SELECT role FROM members WHERE user_id=? AND server_id=?', [userId, inv!.server_id])) return { id: inv!.server_id };
      if ((await tx.one('SELECT COUNT(*) AS count FROM members WHERE user_id=?', [userId]))!.count >= 20) fail(409, 'LIMIT', 'Server membership limit reached.');
      await tx.run('INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)', [inv!.server_id, userId, 'member', Date.now()]);
      await tx.run('UPDATE invites SET remaining=remaining-1 WHERE hash=?', [hash(code)]); return { id: inv!.server_id };
    }); await this.notify('state:changed', {}); return result;
  }
  async members(userId: string, serverId: string) {
    await this.member(this.db, userId, serverId);
    const rows = await this.db.all('SELECT u.*,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.server_id=? ORDER BY m.joined_at', [serverId]);
    return Promise.all(rows.map(async u => ({ user: { ...publicUser(u), tags: (await this.db.all('SELECT t.* FROM tags t JOIN user_tags ut ON ut.tag_id=t.id WHERE ut.user_id=? AND t.server_id=?', [u.id, serverId])).map(t => ({ id: t.id, serverId: t.server_id, name: t.name, color: t.color })) }, role: u.role, customRoles: await this.assignedRoles(this.db, u.id, serverId) })));
  }
  async changeMember(actorId: string, requestId: string, serverId: string, targetId: string, body: { role?: Role; remove?: boolean }) {
    const result = await this.mutate(actorId, requestId, 'member.change', { serverId, targetId, ...body }, async tx => {
      const actor = await this.member(tx, actorId, serverId, 'manageMembers'), target = await this.member(tx, targetId, serverId);
      if (body.role && body.role !== 'member' && (await tx.one('SELECT guest FROM users WHERE id=?', [targetId]))?.guest) fail(403, 'GUEST_ROLE', 'Register the guest before granting an administrative role.');
      if ((!actor.globalAdmin && (await tx.one('SELECT instance_admin FROM users WHERE id=?', [targetId]))?.instance_admin) || !canManage(await this.authority(tx, actor), await this.authority(tx, target)) || (body.role && (!canManage(await this.authority(tx, actor), body.role) || body.role === 'owner'))) fail(403, 'HIERARCHY', 'You cannot manage this role.');
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
      await audit(tx, actorId, 'member.change', targetId, { serverId, ...body });
      return { success: true };
    }); await this.notify('state:changed', {}); await this.notify('voice:changed', {}); return result;
  }
  async leaveServer(userId: string, rid: string, serverId: string) {
    const result = await this.mutate(userId, rid, 'server.leave', { serverId }, async tx => {
      const server = await tx.one('SELECT owner_id FROM servers WHERE id=?', [serverId]);
      if (server?.owner_id === userId) fail(403, 'OWNER_LEAVE', 'Owners must delete their server before leaving.');
      if (!await tx.one('SELECT user_id FROM members WHERE server_id=? AND user_id=?', [serverId, userId])) fail(404, 'NOT_FOUND', 'You are not a member of this server.');
      await tx.run('DELETE FROM voice_members WHERE user_id=? AND channel_id IN (SELECT id FROM channels WHERE server_id=?)', [userId, serverId]);
      await tx.run('DELETE FROM user_tags WHERE user_id=? AND tag_id IN (SELECT id FROM tags WHERE server_id=?)', [userId, serverId]);
      await tx.run('DELETE FROM members WHERE server_id=? AND user_id=?', [serverId, userId]);
      await audit(tx, userId, 'server.leave', serverId); return { success: true };
    }); await this.notify('state:changed', {}); await this.notify('voice:changed', {}); return result;
  }
  async allowDirectMessage(tx: Connection, userId: string, otherId: string) {
    if (await tx.one('SELECT user_id FROM user_blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)', [userId, otherId, otherId, userId])) fail(403, 'DM_BLOCKED', 'Direct messaging is blocked between these accounts.');
  }
  async closeDirectMessage(userId: string, rid: string, conversationId: string) {
    const result = await this.mutate(userId, rid, 'dm.close', { conversationId }, async tx => {
      const cv = await this.conversation(tx, userId, conversationId);
      if (cv.kind !== 'dm') fail(400, 'NOT_DM', 'Only a direct chat can be closed.');
      await tx.run('UPDATE dm_members SET hidden=1 WHERE conversation_id=? AND user_id=?', [conversationId, userId]);
      await tx.run('INSERT INTO read_cursors(conversation_id,user_id,sequence) VALUES(?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET sequence=excluded.sequence', [conversationId, userId, cv.sequence]);
      return { success: true };
    }); await this.notify('state:changed', {}); return result;
  }
  async blockUser(userId: string, rid: string, targetId: string, blocked: boolean) {
    const result = await this.mutate(userId, rid, 'user.block', { targetId, blocked }, async tx => {
      if (targetId === userId) fail(400, 'SELF_BLOCK', 'You cannot block yourself.');
      if (!await tx.one('SELECT id FROM users WHERE id=?', [targetId])) fail(404, 'NOT_FOUND', 'Account not found.');
      if (blocked) await tx.run('INSERT INTO user_blocks(user_id,blocked_id) VALUES(?,?) ON CONFLICT DO NOTHING', [userId, targetId]);
      else await tx.run('DELETE FROM user_blocks WHERE user_id=? AND blocked_id=?', [userId, targetId]);
      return { success: true };
    }); await this.notify('state:changed', {}); return result;
  }
  async dm(userId: string, requestId: string, otherId: string) {
    return this.mutate(userId, requestId, 'dm.create', { otherId }, async tx => {
      if (otherId === userId || !await tx.one('SELECT id FROM users WHERE id=?', [otherId])) fail(400, 'INVALID_USER', 'Select another registered user.');
      await this.allowDirectMessage(tx, userId, otherId);
      const guests = await tx.one('SELECT COUNT(*) AS count FROM users WHERE id IN (?,?) AND guest=1', [userId, otherId]);
      if (guests!.count && !await tx.one('SELECT a.server_id FROM members a JOIN members b ON a.server_id=b.server_id JOIN servers s ON s.id=a.server_id WHERE a.user_id=? AND b.user_id=? AND s.allow_guests=1', [userId, otherId])) fail(403, 'GUEST_DM', 'Guests can message only people in a shared guest-enabled server.');
      const pair = [userId, otherId].sort().join(':');
      const old = await tx.one('SELECT conversation_id FROM dm_pairs WHERE pair_key=?', [pair]);
      if (old) { await tx.run('UPDATE dm_members SET hidden=0 WHERE conversation_id=? AND user_id=?', [old.conversation_id, userId]); return { id: old.conversation_id }; }
      const cv = randomUUID(); await tx.run('INSERT INTO conversations(id,kind,created_at) VALUES(?,?,?)', [cv, 'dm', Date.now()]);
      for (const u of [userId, otherId]) await tx.run('INSERT INTO dm_members(conversation_id,user_id) VALUES(?,?)', [cv, u]);
      await tx.run('INSERT INTO dm_pairs(pair_key,conversation_id) VALUES(?,?)', [pair, cv]); return { id: cv };
    });
  }
  async messageView(tx: Connection, messageId: string): Promise<Message> {
    const m = await tx.one('SELECT m.*,u.username,u.display_name,u.bio,u.avatar,u.status,u.instance_admin,u.guest,u.language FROM messages m JOIN users u ON m.user_id=u.id WHERE m.id=?', [messageId]);
    if (!m) fail(404, 'NOT_FOUND', 'Message not found.');
    const reactions: Record<string, string[]> = {};
    for (const r of await tx.all('SELECT emoji,user_id FROM reactions WHERE message_id=?', [messageId])) (reactions[r.emoji] ||= []).push(r.user_id);
    return { id: m!.id, conversationId: m!.conversation_id, sequence: Number(m!.sequence), author: publicUser({ ...m!, id: m!.user_id }), content: m!.deleted ? '' : m!.content, replyTo: m!.reply_to, createdAt: Number(m!.created_at), editedAt: m!.edited_at ? Number(m!.edited_at) : null, deleted: Boolean(m!.deleted), reactions: Object.entries(reactions).map(([emoji, userIds]) => ({ emoji, userIds })), attachments: m!.deleted ? [] : (await tx.all('SELECT * FROM attachments WHERE message_id=?', [messageId])).map(a => ({ id: a.id, name: a.name, size: Number(a.size), expiresAt: Number(a.expires_at), available: a.state === 'ready' && Number(a.expires_at) > Date.now() })) };
  }
  async event(tx: Connection, conversationId: string, kind: string, payload: unknown) {
    await tx.run('UPDATE conversations SET sequence=sequence+1 WHERE id=?', [conversationId]);
    const cv = await tx.one('SELECT sequence,kind FROM conversations WHERE id=?', [conversationId]);
    const event = { conversationId, sequence: Number(cv!.sequence), kind, payload, direct: cv!.kind === 'dm' };
    if ((await tx.one('SELECT COUNT(*) AS count FROM events'))!.count >= 50000) await tx.run('DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY created_at LIMIT 200)');
    await tx.run('INSERT INTO events(id,conversation_id,sequence,kind,payload,created_at) VALUES(?,?,?,?,?,?)', [randomUUID(), conversationId, event.sequence, kind, JSON.stringify(payload), Date.now()]); return event;
  }
  async send(userId: string, requestId: string, conversationId: string, content: string, replyTo?: string | null, attachmentIds: string[] = []) {
    let reopened = false;
    const event = await this.mutate(userId, requestId, 'message.send', { conversationId, content, replyTo, attachmentIds }, async tx => {
      const cv = await this.conversation(tx, userId, conversationId, true);
      const account = await tx.one('SELECT guest FROM users WHERE id=?', [userId]);
      if (account!.guest && (await tx.one('SELECT COUNT(*) AS count FROM messages WHERE user_id=? AND created_at>?', [userId, Date.now() - 60000]))!.count >= 20) fail(429, 'GUEST_RATE', 'Guests may send at most 20 messages per minute.');
      if (account!.guest && attachmentIds.length) fail(403, 'GUEST_UPLOAD', 'Guests cannot upload files.');
      for (const a of attachmentIds) if (!await tx.one("SELECT id FROM attachments WHERE id=? AND user_id=? AND conversation_id=? AND state='ready' AND message_id IS NULL AND expires_at>?", [a, userId, conversationId, Date.now()])) fail(400, 'ATTACHMENT_INVALID', 'An attachment is unavailable or belongs to another conversation.');
      if (replyTo && !await tx.one('SELECT id FROM messages WHERE id=? AND conversation_id=?', [replyTo, conversationId])) fail(400, 'INVALID_REPLY', 'Reply target is unavailable.');
      if ((await tx.one('SELECT COUNT(*) AS count FROM messages'))!.count >= this.c.maxMessages) {
        await tx.run('DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY created_at LIMIT 200)');
      }
      const messageId = randomUUID();
      await tx.run('INSERT INTO messages(id,conversation_id,sequence,user_id,content,reply_to,created_at) VALUES(?,?,?,?,?,?,?)', [messageId, conversationId, Number(cv.sequence) + 1, userId, content, replyTo || null, Date.now()]);
      for (const a of attachmentIds) await tx.run('UPDATE attachments SET message_id=? WHERE id=?', [messageId, a]);
      if (cv.kind === 'dm') { reopened = Boolean(await tx.one('SELECT user_id FROM dm_members WHERE conversation_id=? AND hidden=1', [conversationId])); await tx.run('UPDATE dm_members SET hidden=0 WHERE conversation_id=?', [conversationId]); }
      return this.event(tx, conversationId, 'message', await this.messageView(tx, messageId));
    }); if (reopened) await this.notify('state:changed', {}); await this.notify('conversation:event', event); return event;
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
        if (body.delete) { await tx.run('DELETE FROM reactions WHERE message_id=?', [messageId]); await tx.run("UPDATE attachments SET state='unavailable' WHERE message_id=?", [messageId]); }
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
  async voiceDirectory(userId: string, tx: Connection = this.db): Promise<VoicePresence[]> {
    const rooms: VoicePresence[] = [], now = Date.now();
    for (const ch of await tx.all('SELECT DISTINCT channel_id FROM voice_members WHERE heartbeat>=?', [now - 30000])) {
      try { await this.channel(tx, userId, ch.channel_id); } catch { continue; }
      const members = (await tx.all('SELECT v.*,u.username,u.display_name,u.bio,u.avatar,u.status FROM voice_members v JOIN users u ON u.id=v.user_id WHERE v.channel_id=? AND v.heartbeat>=? ORDER BY v.joined_at', [ch.channel_id, now - 30000])).map(vm => ({ user: publicUser({ ...vm, id: vm.user_id }), muted: Boolean(vm.muted), deafened: Boolean(vm.deafened), serverMuted: Boolean(vm.server_muted) }));
      const shares = await tx.one('SELECT COUNT(*) AS count FROM share_leases WHERE channel_id=? AND expires_at>=?', [ch.channel_id, now]);
      rooms.push({ channelId: ch.channel_id, members, shares: Number(shares!.count) });
    }
    return rooms;
  }
  async room(userId: string, channelId: string): Promise<VoiceRoom> {
    return this.db.transaction(async tx => { await this.channel(tx, userId, channelId); await this.maintainRoom(tx, channelId); return this.roomView(tx, channelId); });
  }
  async roomView(tx: Connection, channelId: string): Promise<VoiceRoom> {
    const members = [];
    for (const vm of await tx.all('SELECT v.*,u.username,u.display_name,u.bio,u.avatar,u.status,u.instance_admin FROM voice_members v JOIN users u ON u.id=v.user_id WHERE v.channel_id=? ORDER BY v.joined_at', [channelId])) {
      let canShare = false; try { canShare = (await this.channel(tx, vm.user_id, channelId, 'share')).permissions.share; } catch { /* permission removed */ }
      members.push({ user: publicUser({ ...vm, id: vm.user_id }), muted: Boolean(vm.muted), deafened: Boolean(vm.deafened), serverMuted: Boolean(vm.server_muted), serverDeafened: Boolean(vm.server_deafened), canShare, epoch: vm.epoch, eligible: Boolean(vm.eligible), joinedAt: Number(vm.joined_at) });
    }
    const shares = (await tx.all('SELECT * FROM share_leases WHERE channel_id=? AND expires_at>=?', [channelId, Date.now()])).map(s => ({ id: s.id, channelId: s.channel_id, userId: s.user_id, expiresAt: Number(s.expires_at) }));
    const coordinator = await tx.one('SELECT * FROM coordinators WHERE channel_id=?', [channelId]);
    return { channelId, members, shares, coordinatorId: coordinator?.user_id || null, coordinatorEpoch: Number(coordinator?.epoch || 0), transport: this.c.mediaTransport };
  }
  async joinVoice(userId: string, socketId: string, channelId: string, eligible: boolean) {
    const access = await this.channel(this.db, userId, channelId);
    if (access.kind !== 'voice') fail(400, 'NOT_VOICE', 'Select a voice channel.');
    // Fetch outside the write transaction and before creating membership. Revalidate below.
    const iceServers = this.c.mediaTransport === 'mesh' && this.cloudflareTurn ? await this.cloudflareTurn.forUser(userId) : this.iceServers(userId);
    const result = await this.db.transaction(async tx => {
      const ch = await this.channel(tx, userId, channelId);
      if (ch.kind !== 'voice') fail(400, 'NOT_VOICE', 'Select a voice channel.');
      await this.maintainRoom(tx, channelId);
      const previous = await tx.one('SELECT * FROM voice_members WHERE user_id=?', [userId]);
      if (previous && previous.socket_id === socketId && previous.channel_id === channelId) return { epoch: previous.epoch, room: await this.roomView(tx, channelId) };
      const count = await tx.one('SELECT COUNT(*) AS count FROM voice_members WHERE channel_id=? AND user_id<>?', [channelId, userId]);
      if (ch.locked && !['owner', 'administrator'].includes(ch.role)) fail(403, 'VOICE_LOCKED', 'This voice channel is locked.');
      if (count!.count >= Math.min(ch.user_limit, this.c.maxVoice)) fail(409, 'ROOM_FULL', 'Voice channel is full.');
      await tx.run('DELETE FROM voice_members WHERE user_id=?', [userId]);
      const epoch = randomUUID(), now = Date.now();
      const restriction = await tx.one('SELECT * FROM voice_restrictions WHERE channel_id=? AND user_id=?', [channelId, userId]);
      await tx.run('INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,server_muted,server_deafened,eligible,heartbeat,joined_at) VALUES(?,?,?,?,?,?,?,?,?)', [userId, channelId, socketId, epoch, ch.permissions.speak && !restriction?.muted ? 0 : 1, restriction?.deafened || 0, eligible ? 1 : 0, now, now]);
      if (previous && previous.channel_id !== channelId) await this.maintainRoom(tx, previous.channel_id);
      await this.maintainRoom(tx, channelId); return { epoch, room: await this.roomView(tx, channelId) };
    }); await this.notify('voice:changed', {}); return { ...result, iceServers, ...(this.cloudflareTurn ? { iceServersExpiresAt: Date.now() + (cloudflareTurnTtl - 60) * 1000 } : {}) };
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
      if ((this.c.globalShares > 0 && global!.count >= this.c.globalShares) || (this.c.roomShares > 0 && room!.count >= this.c.roomShares)) fail(409, 'SHARE_LIMIT', 'Screen-sharing capacity is full.');
      const lease = { id: randomUUID(), channelId: vm!.channel_id, userId, expiresAt: Date.now() + 30000 };
      await tx.run('INSERT INTO share_leases(id,user_id,channel_id,expires_at) VALUES(?,?,?,?)', [lease.id, userId, lease.channelId, lease.expiresAt]); return { lease };
    }); await this.notify('voice:changed', {}); return result;
  }
  async moderate(userId: string, requestId: string, channelId: string, targetId: string, action: string) {
    const result = await this.mutate(userId, requestId, 'voice.moderate', { channelId, targetId, action }, async tx => {
      const ch = await this.channel(tx, userId, channelId, 'moderate'), target = await this.member(tx, targetId, ch.server_id);
      const actor = await tx.one('SELECT instance_admin FROM users WHERE id=?', [userId]), targetAccount = await tx.one('SELECT instance_admin FROM users WHERE id=?', [targetId]);
      if (!actor!.instance_admin && (targetAccount!.instance_admin || (userId !== targetId && !canManage(await this.authority(tx, { role: ch.role, user_id: userId, server_id: ch.server_id }), await this.authority(tx, target))))) fail(403, 'HIERARCHY', 'Cannot moderate this member.');
      if (!await tx.one('SELECT user_id FROM voice_members WHERE channel_id=? AND user_id=?', [channelId, targetId])) fail(409, 'NOT_IN_VOICE', 'The participant has left this channel.');
      if (['mute', 'unmute', 'deafen', 'undeafen', 'denyShare', 'allowShare'].includes(action)) {
        await tx.run('INSERT INTO voice_restrictions(channel_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING', [channelId, targetId]);
        if (action === 'mute' || action === 'unmute') await tx.run('UPDATE voice_restrictions SET muted=? WHERE channel_id=? AND user_id=?', [Number(action === 'mute'), channelId, targetId]);
        if (action === 'deafen' || action === 'undeafen') await tx.run('UPDATE voice_restrictions SET deafened=? WHERE channel_id=? AND user_id=?', [Number(action === 'deafen'), channelId, targetId]);
        if (action === 'denyShare' || action === 'allowShare') await tx.run('UPDATE voice_restrictions SET sharing_allowed=? WHERE channel_id=? AND user_id=?', [Number(action === 'allowShare'), channelId, targetId]);
      }
      if (action === 'kick') await tx.run('DELETE FROM voice_members WHERE channel_id=? AND user_id=?', [channelId, targetId]);
      if (action === 'stopShare') await tx.run('DELETE FROM share_leases WHERE channel_id=? AND user_id=?', [channelId, targetId]);
      if (action === 'denyShare') await tx.run('DELETE FROM share_leases WHERE channel_id=? AND user_id=?', [channelId, targetId]);
      if (action === 'mute' || action === 'unmute') {
        if (action === 'unmute') await this.channel(tx, targetId, channelId, 'speak');
        await tx.run('UPDATE voice_members SET server_muted=? WHERE channel_id=? AND user_id=?', [action === 'mute' ? 1 : 0, channelId, targetId]);
      }
      if (action === 'deafen' || action === 'undeafen') await tx.run('UPDATE voice_members SET server_deafened=? WHERE channel_id=? AND user_id=?', [Number(action === 'deafen'), channelId, targetId]);
      await audit(tx, userId, `voice.${action}`, targetId, { channelId });
      await this.maintainRoom(tx, channelId); return { success: true };
    }); await this.notify('voice:changed', {}); return result;
  }
  async revalidateVoice(tx: Connection, serverId: string) {
    for (const vm of await tx.all('SELECT v.* FROM voice_members v JOIN channels c ON c.id=v.channel_id WHERE c.server_id=?', [serverId])) {
      try {
        const access = await this.channel(tx, vm.user_id, vm.channel_id);
        const restriction = await tx.one('SELECT muted FROM voice_restrictions WHERE channel_id=? AND user_id=?', [vm.channel_id, vm.user_id]);
        await tx.run('UPDATE voice_members SET server_muted=? WHERE user_id=?', [Number(!access.permissions.speak || Boolean(restriction?.muted)), vm.user_id]);
        if (!access.permissions.share) await tx.run('DELETE FROM share_leases WHERE user_id=?', [vm.user_id]);
      } catch { await tx.run('DELETE FROM voice_members WHERE user_id=?', [vm.user_id]); }
    }
  }
  async voicePolicy(actorId: string, rid: string, channelId: string, body: { locked: boolean; userLimit: number; tagMode: 'ANY' | 'ALL'; requiredTags: string[] }) {
    const result = await this.mutate(actorId, rid, 'voice.policy', { channelId, ...body }, async tx => {
      const ch = await this.channel(tx, actorId, channelId, 'manageChannels');
      if (ch.kind !== 'voice') fail(400, 'NOT_VOICE', 'Select a voice channel.');
      for (const tag of body.requiredTags) if (!await tx.one('SELECT id FROM tags WHERE id=? AND server_id=?', [tag, ch.server_id])) fail(400, 'INVALID_TAG', 'Tags must belong to this server.');
      await tx.run('UPDATE channels SET locked=?,user_limit=?,tag_mode=? WHERE id=?', [Number(body.locked), Math.min(body.userLimit, this.c.maxVoice), body.tagMode, channelId]);
      await tx.run('DELETE FROM channel_tags WHERE channel_id=?', [channelId]);
      for (const tag of new Set(body.requiredTags)) await tx.run('INSERT INTO channel_tags(channel_id,tag_id) VALUES(?,?)', [channelId, tag]);
      await this.revalidateVoice(tx, ch.server_id); await audit(tx, actorId, 'voice.policy', channelId, body); return { success: true };
    }); await this.notify('state:changed', {}); await this.notify('voice:changed', {}); return result;
  }
  async tags(userId: string, serverId: string) {
    await this.member(this.db, userId, serverId);
    return (await this.db.all('SELECT * FROM tags WHERE server_id=? ORDER BY name', [serverId])).map(t => ({ id: t.id, serverId: t.server_id, name: t.name, color: t.color }));
  }
  async changeTag(actorId: string, rid: string, serverId: string, body: { tagId?: string; name?: string; color?: string; delete?: boolean; userId?: string; assigned?: boolean }) {
    const result = await this.mutate(actorId, rid, 'tag.change', { serverId, ...body }, async tx => {
      const actor = await this.member(tx, actorId, serverId, 'manageChannels');
      if (body.tagId && !await tx.one('SELECT id FROM tags WHERE id=? AND server_id=?', [body.tagId, serverId])) fail(404, 'NOT_FOUND', 'Tag not found.');
      const tagId = body.tagId || randomUUID();
      if (body.userId) {
        const target = await this.member(tx, body.userId, serverId);
        if (actorId !== body.userId && !actor.globalAdmin && !canManage(actor.role, target.role)) fail(403, 'HIERARCHY', 'Cannot assign tags to this role.');
        if (!body.tagId) fail(400, 'INVALID_TAG', 'Choose a tag.');
        if (body.assigned) await tx.run('INSERT INTO user_tags(user_id,tag_id) VALUES(?,?) ON CONFLICT DO NOTHING', [body.userId, tagId]);
        else await tx.run('DELETE FROM user_tags WHERE user_id=? AND tag_id=?', [body.userId, tagId]);
      } else if (body.delete) await tx.run('DELETE FROM tags WHERE id=?', [tagId]);
      else if (!body.tagId) {
        if ((await tx.one('SELECT COUNT(*) AS count FROM tags WHERE server_id=?', [serverId]))!.count >= 32) fail(409, 'LIMIT', 'This server has reached its tag limit.');
        if (!body.name) fail(400, 'VALIDATION', 'Enter a tag name.');
        await tx.run('INSERT INTO tags(id,server_id,name,color) VALUES(?,?,?,?)', [tagId, serverId, body.name, body.color || '#a99bff']);
      } else {
        if (body.name) await tx.run('UPDATE tags SET name=? WHERE id=?', [body.name, tagId]);
        if (body.color) await tx.run('UPDATE tags SET color=? WHERE id=?', [body.color, tagId]);
      }
      await this.revalidateVoice(tx, serverId); await audit(tx, actorId, 'tag.change', tagId, { serverId, userId: body.userId, assigned: body.assigned, delete: body.delete }); return { id: tagId };
    }); await this.notify('state:changed', {}); await this.notify('voice:changed', {}); return result;
  }
  async moveVoice(actorId: string, rid: string, fromChannel: string, targetId: string, toChannel: string) {
    const result = await this.mutate(actorId, rid, 'voice.move', { fromChannel, targetId, toChannel }, async tx => {
      const from = await this.channel(tx, actorId, fromChannel, 'moderate'), to = await this.channel(tx, actorId, toChannel, 'moderate');
      const target = await this.member(tx, targetId, from.server_id), actor = await tx.one('SELECT instance_admin FROM users WHERE id=?', [actorId]);
      if (from.server_id !== to.server_id || to.kind !== 'voice' || fromChannel === toChannel) fail(400, 'INVALID_MOVE', 'Choose another voice channel in this server.');
      if (!actor!.instance_admin && ((await tx.one('SELECT instance_admin FROM users WHERE id=?', [targetId]))!.instance_admin || !canManage(await this.authority(tx, { role: from.role, user_id: actorId, server_id: from.server_id }), await this.authority(tx, target)))) fail(403, 'HIERARCHY', 'Cannot move this member.');
      const access = await this.channel(tx, targetId, toChannel);
      if (access.locked && !['owner', 'administrator'].includes(access.role)) fail(403, 'VOICE_LOCKED', 'The destination is locked.');
      await this.maintainRoom(tx, toChannel);
      if ((await tx.one('SELECT COUNT(*) AS count FROM voice_members WHERE channel_id=?', [toChannel]))!.count >= Math.min(access.user_limit, this.c.maxVoice)) fail(409, 'ROOM_FULL', 'The destination is full.');
      const vm = await tx.one('SELECT * FROM voice_members WHERE user_id=? AND channel_id=?', [targetId, fromChannel]);
      if (!vm) fail(409, 'NOT_IN_VOICE', 'The participant has left this channel.');
      await tx.run('DELETE FROM voice_members WHERE user_id=?', [targetId]);
      await audit(tx, actorId, 'voice.move', targetId, { fromChannel, toChannel }); return { socketId: vm!.socket_id, channelId: toChannel };
    });
    await this.notify('voice:move', result); await this.notify('voice:changed', {}); return { success: true };
  }
  async cleanup() {
    await this.db.transaction(async tx => {
      const now = Date.now();
      await tx.run('DELETE FROM recovery_attempts WHERE expires_at<?', [now]);
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
  profile: z.object({ displayName: z.string().trim().min(1).max(48), bio: z.string().max(500), status: z.enum(['online', 'idle', 'busy']), language: z.enum(['en-US', 'fa-IR']).optional(), requestId: requestIdSchema }),
  channel: z.object({ name: z.string().trim().min(1).max(64), kind: z.enum(['text', 'voice']), requestId: requestIdSchema }),
  role: z.enum(['owner', 'administrator', 'moderator', 'member']),
  permissions: z.object({ view: z.boolean().optional(), write: z.boolean().optional(), speak: z.boolean().optional(), share: z.boolean().optional(), manageChannels: z.boolean().optional(), manageMembers: z.boolean().optional(), moderate: z.boolean().optional(), createInvites: z.boolean().optional() }).strict()
};
