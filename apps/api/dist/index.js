import {
  config,
  openDatabase
} from "./chunk-GXUPFVZD.js";

// apps/api/src/app.ts
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import { Server as SocketServer } from "socket.io";
import { z as z3, ZodError } from "zod";
import { randomUUID as randomUUID2 } from "crypto";
import { existsSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from "fs";
import { mkdir, writeFile, unlink, readdir, stat } from "fs/promises";
import path from "path";
import sharp from "sharp";

// packages/contracts/src/index.ts
import { z } from "zod";
var id = z.string().min(1).max(80);
var requestId = z.string().uuid();
var credentialsSchema = z.object({ username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/), password: z.string().min(10).max(128) });
var registerSchema = credentialsSchema.extend({ displayName: z.string().trim().min(1).max(48), requestId });
var messageSchema = z.object({ conversationId: id, content: z.string().trim().min(1).max(4e3), replyTo: id.nullable().optional(), requestId });
var signalSchema = z.object({ channelId: id, to: id, epoch: id, description: z.object({ type: z.enum(["offer", "answer", "pranswer", "rollback"]), sdp: z.string().max(1e5).optional() }).optional(), candidate: z.object({ candidate: z.string().max(4096).optional(), sdpMid: z.string().nullable().optional(), sdpMLineIndex: z.number().int().nullable().optional(), usernameFragment: z.string().nullable().optional() }).nullable().optional(), streams: z.array(z.object({ streamId: id, kind: z.enum(["audio", "screen"]), leaseId: id.optional() })).max(3).optional(), subscription: z.object({ leaseId: id, enabled: z.boolean() }).optional() });
var rank = { member: 0, moderator: 1, administrator: 2, owner: 3 };
function basePermissions(role) {
  return { view: true, write: true, speak: true, share: true, manageChannels: rank[role] >= 2, manageMembers: rank[role] >= 1, moderate: rank[role] >= 1 };
}
function resolvePermissions(role, overrides = {}) {
  return role === "owner" ? basePermissions(role) : { ...basePermissions(role), ...overrides };
}
function canManage(actor, target) {
  return rank[actor] > rank[target];
}

// apps/api/src/service.ts
import { randomUUID, createHmac } from "crypto";
import { z as z2 } from "zod";

// apps/api/src/security.ts
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import argon2 from "argon2";
var AppError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
  status;
  code;
};
var fail = (status, code, message) => {
  throw new AppError(status, code, message);
};
var token = () => randomBytes(32).toString("base64url");
var hash = (value) => createHash("sha256").update(value).digest("hex");
var equal = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
var active = 0;
async function passwordHash(password) {
  return limited(() => argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }));
}
async function passwordVerify(encoded, password) {
  return limited(() => argon2.verify(encoded, password));
}
async function limited(fn) {
  if (active >= 2) fail(429, "AUTH_BUSY", "Authentication is busy. Please retry shortly.");
  active++;
  try {
    return await fn();
  } finally {
    active--;
  }
}

// apps/api/src/service.ts
var publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.display_name, bio: u.bio, avatar: u.avatar, status: u.status, instanceAdmin: Boolean(u.instance_admin) });
var Service = class {
  constructor(db, c) {
    this.db = db;
    this.c = c;
  }
  db;
  c;
  notify = async () => {
  };
  async mutate(userId, requestId2, operation, payload, fn) {
    requestId.parse(requestId2);
    const fingerprint = hash(JSON.stringify(payload));
    return this.db.transaction(async (tx) => {
      const old = await tx.one("SELECT * FROM mutations WHERE user_id=? AND request_id=?", [userId, requestId2]);
      if (old) {
        if (old.operation !== operation || old.fingerprint !== fingerprint) fail(409, "IDEMPOTENCY_CONFLICT", "Request identifier was already used with different input.");
        return JSON.parse(old.response);
      }
      const result = await fn(tx);
      await tx.run("INSERT INTO mutations(user_id,request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)", [userId, requestId2, operation, fingerprint, JSON.stringify(result), Date.now()]);
      return result;
    });
  }
  async member(tx, userId, serverId, permission) {
    const m = await tx.one("SELECT * FROM members WHERE server_id=? AND user_id=?", [serverId, userId]);
    if (!m || permission && !basePermissions(m.role)[permission]) fail(403, "FORBIDDEN", "You do not have permission.");
    return m;
  }
  async channel(tx, userId, channelId, permission = "view") {
    const ch = await tx.one("SELECT * FROM channels WHERE id=?", [channelId]);
    if (!ch) fail(404, "NOT_FOUND", "Channel not found.");
    const m = await this.member(tx, userId, ch.server_id);
    const override = await tx.one("SELECT permissions FROM channel_overrides WHERE channel_id=? AND role=?", [channelId, m.role]);
    const permissions = resolvePermissions(m.role, override ? JSON.parse(override.permissions) : {});
    if (!permissions.view || !permissions[permission]) fail(403, "FORBIDDEN", "Channel permission denied.");
    return { ...ch, role: m.role, permissions };
  }
  async conversation(tx, userId, conversationId, write = false) {
    const cv = await tx.one("SELECT * FROM conversations WHERE id=?", [conversationId]);
    if (!cv) fail(404, "NOT_FOUND", "Conversation not found.");
    if (cv.kind === "dm") {
      if (!await tx.one("SELECT user_id FROM dm_members WHERE conversation_id=? AND user_id=?", [conversationId, userId])) fail(403, "FORBIDDEN", "Private conversation.");
    } else {
      const ch = await tx.one("SELECT id FROM channels WHERE conversation_id=?", [conversationId]);
      if (!ch) fail(404, "NOT_FOUND", "Channel not found.");
      await this.channel(tx, userId, ch.id, write ? "write" : "view");
    }
    return cv;
  }
  async bootstrap(userId) {
    return this.db.transaction(async (tx) => {
      const me = await tx.one("SELECT * FROM users WHERE id=?", [userId]);
      const servers = (await tx.all("SELECT s.*,m.role FROM servers s JOIN members m ON m.server_id=s.id WHERE m.user_id=? ORDER BY s.created_at", [userId])).map((s) => ({ id: s.id, name: s.name, ownerId: s.owner_id, role: s.role }));
      const allChannels = await tx.all("SELECT c.* FROM channels c JOIN members m ON c.server_id=m.server_id WHERE m.user_id=? ORDER BY c.created_at", [userId]);
      const channels = [];
      for (const ch of allChannels) {
        try {
          const access = await this.channel(tx, userId, ch.id);
          channels.push({ id: ch.id, serverId: ch.server_id, name: ch.name, kind: ch.kind, conversationId: ch.conversation_id, permissions: access.permissions });
        } catch {
        }
      }
      const dms = await tx.all("SELECT d.conversation_id,u.id,u.username,u.display_name,u.bio,u.avatar,u.status,u.instance_admin FROM dm_members d JOIN dm_members other ON other.conversation_id=d.conversation_id AND other.user_id<>d.user_id JOIN users u ON u.id=other.user_id WHERE d.user_id=?", [userId]);
      const unread = {};
      for (const conversationId of [...channels.map((c) => c.conversationId).filter(Boolean), ...dms.map((d) => d.conversation_id)]) {
        const cv = await tx.one("SELECT sequence FROM conversations WHERE id=?", [conversationId]);
        const read = await tx.one("SELECT sequence FROM read_cursors WHERE conversation_id=? AND user_id=?", [conversationId, userId]);
        unread[conversationId] = { sequence: Number(cv?.sequence || 0), readSequence: Number(read?.sequence || 0) };
      }
      return { me: publicUser(me), servers, channels, voicePresence: await this.voiceDirectory(userId, tx), dms: dms.map((d) => ({ id: d.conversation_id, user: publicUser(d) })), users: (await tx.all("SELECT * FROM users ORDER BY username LIMIT 100")).map(publicUser), unread, mediaTransport: this.c.mediaTransport, limits: { users: this.c.maxUsers, online: this.c.maxOnline, voice: this.c.maxVoice, roomShares: this.c.roomShares, globalShares: this.c.globalShares } };
    });
  }
  async createServer(userId, requestId2, name) {
    const result = await this.mutate(userId, requestId2, "server.create", { name }, async (tx) => {
      const count = await tx.one("SELECT COUNT(*) AS count FROM members WHERE user_id=?", [userId]);
      if (count.count >= 20) fail(409, "LIMIT", "You may join at most 20 servers.");
      const serverId = randomUUID();
      const now = Date.now();
      await tx.run("INSERT INTO servers(id,name,owner_id,created_at) VALUES(?,?,?,?)", [serverId, name, userId, now]);
      await tx.run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)", [serverId, userId, "owner", now]);
      await this.insertChannel(tx, serverId, "general", "text");
      await this.insertChannel(tx, serverId, "Lounge", "voice");
      return { id: serverId };
    });
    await this.notify("state:changed", {});
    return result;
  }
  async insertChannel(tx, serverId, name, kind) {
    const channelId = randomUUID(), conversationId = kind === "text" ? randomUUID() : null, now = Date.now();
    if (conversationId) await tx.run("INSERT INTO conversations(id,kind,created_at) VALUES(?,?,?)", [conversationId, "channel", now]);
    await tx.run("INSERT INTO channels(id,server_id,name,kind,conversation_id,created_at) VALUES(?,?,?,?,?,?)", [channelId, serverId, name, kind, conversationId, now]);
    return { id: channelId };
  }
  async changeServer(userId, requestId2, serverId, body) {
    const result = await this.mutate(userId, requestId2, "server.change", { serverId, ...body }, async (tx) => {
      const m = await this.member(tx, userId, serverId, "manageChannels");
      if (body.delete) {
        if (m.role !== "owner") fail(403, "FORBIDDEN", "Only the owner can delete a server.");
        const cvs = await tx.all("SELECT conversation_id FROM channels WHERE server_id=?", [serverId]);
        await tx.run("DELETE FROM servers WHERE id=?", [serverId]);
        for (const cv of cvs) if (cv.conversation_id) await tx.run("DELETE FROM conversations WHERE id=?", [cv.conversation_id]);
      } else await tx.run("UPDATE servers SET name=? WHERE id=?", [body.name, serverId]);
      return { success: true };
    });
    await this.notify("state:changed", {});
    await this.notify("voice:changed", {});
    return result;
  }
  async createChannel(userId, requestId2, serverId, name, kind) {
    const result = await this.mutate(userId, requestId2, "channel.create", { serverId, name, kind }, async (tx) => {
      await this.member(tx, userId, serverId, "manageChannels");
      const count = await tx.one("SELECT COUNT(*) AS count FROM channels WHERE server_id=?", [serverId]);
      if (count.count >= 50) fail(409, "LIMIT", "Server channel limit reached.");
      return this.insertChannel(tx, serverId, name, kind);
    });
    await this.notify("state:changed", {});
    return result;
  }
  async changeChannel(userId, requestId2, channelId, body) {
    const result = await this.mutate(userId, requestId2, "channel.change", { channelId, ...body }, async (tx) => {
      const ch = await this.channel(tx, userId, channelId, "manageChannels");
      if (body.delete) {
        await tx.run("DELETE FROM channels WHERE id=?", [channelId]);
        if (ch.conversation_id) await tx.run("DELETE FROM conversations WHERE id=?", [ch.conversation_id]);
      } else {
        if (body.name) await tx.run("UPDATE channels SET name=? WHERE id=?", [body.name, channelId]);
        if (body.role && body.permissions) await tx.run("INSERT INTO channel_overrides(channel_id,role,permissions) VALUES(?,?,?) ON CONFLICT(channel_id,role) DO UPDATE SET permissions=excluded.permissions", [channelId, body.role, JSON.stringify(body.permissions)]);
        for (const vm of await tx.all("SELECT * FROM voice_members WHERE channel_id=?", [channelId])) {
          try {
            await this.channel(tx, vm.user_id, channelId);
          } catch {
            await tx.run("DELETE FROM voice_members WHERE user_id=?", [vm.user_id]);
            continue;
          }
          try {
            await this.channel(tx, vm.user_id, channelId, "speak");
          } catch {
            await tx.run("UPDATE voice_members SET server_muted=1 WHERE user_id=?", [vm.user_id]);
          }
          try {
            await this.channel(tx, vm.user_id, channelId, "share");
          } catch {
            await tx.run("DELETE FROM share_leases WHERE user_id=?", [vm.user_id]);
          }
        }
      }
      return { success: true };
    });
    await this.notify("state:changed", {});
    await this.notify("voice:changed", {});
    return result;
  }
  async invite(userId, requestId2, serverId, value, expiresHours, uses) {
    return this.mutate(userId, requestId2, "invite.create", { serverId, expiresHours, uses }, async (tx) => {
      await this.member(tx, userId, serverId, "manageMembers");
      await tx.run("INSERT INTO invites(hash,server_id,expires_at,remaining,created_by) VALUES(?,?,?,?,?)", [hash(value), serverId, Date.now() + expiresHours * 36e5, uses, userId]);
      return { code: value, url: `${this.c.publicUrl}/?invite=${value}` };
    });
  }
  async joinInvite(userId, requestId2, code) {
    const result = await this.mutate(userId, requestId2, "invite.join", { code }, async (tx) => {
      const inv = await tx.one("SELECT * FROM invites WHERE hash=?", [hash(code)]);
      if (!inv || inv.expires_at < Date.now() || inv.remaining < 1) fail(404, "INVITE_EXPIRED", "Invite is invalid, expired, or exhausted.");
      if (await tx.one("SELECT role FROM members WHERE user_id=? AND server_id=?", [userId, inv.server_id])) return { id: inv.server_id };
      if ((await tx.one("SELECT COUNT(*) AS count FROM members WHERE user_id=?", [userId])).count >= 20) fail(409, "LIMIT", "Server membership limit reached.");
      await tx.run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)", [inv.server_id, userId, "member", Date.now()]);
      await tx.run("UPDATE invites SET remaining=remaining-1 WHERE hash=?", [hash(code)]);
      return { id: inv.server_id };
    });
    await this.notify("state:changed", {});
    return result;
  }
  async members(userId, serverId) {
    await this.member(this.db, userId, serverId);
    return (await this.db.all("SELECT u.*,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.server_id=? ORDER BY m.joined_at", [serverId])).map((u) => ({ user: publicUser(u), role: u.role }));
  }
  async changeMember(actorId, requestId2, serverId, targetId, body) {
    const result = await this.mutate(actorId, requestId2, "member.change", { serverId, targetId, ...body }, async (tx) => {
      const actor = await this.member(tx, actorId, serverId, "manageMembers"), target = await this.member(tx, targetId, serverId);
      if (!canManage(actor.role, target.role) || body.role && (!canManage(actor.role, body.role) || body.role === "owner")) fail(403, "HIERARCHY", "You cannot manage this role.");
      if (body.remove) {
        await tx.run("DELETE FROM members WHERE server_id=? AND user_id=?", [serverId, targetId]);
        await tx.run("DELETE FROM voice_members WHERE user_id=? AND channel_id IN (SELECT id FROM channels WHERE server_id=?)", [targetId, serverId]);
      } else {
        await tx.run("UPDATE members SET role=? WHERE server_id=? AND user_id=?", [body.role, serverId, targetId]);
        const voice = await tx.one("SELECT channel_id FROM voice_members WHERE user_id=? AND channel_id IN (SELECT id FROM channels WHERE server_id=?)", [targetId, serverId]);
        if (voice) {
          try {
            const access = await this.channel(tx, targetId, voice.channel_id);
            if (!access.permissions.speak) await tx.run("UPDATE voice_members SET server_muted=1 WHERE user_id=?", [targetId]);
            if (!access.permissions.share) await tx.run("DELETE FROM share_leases WHERE user_id=?", [targetId]);
          } catch {
            await tx.run("DELETE FROM voice_members WHERE user_id=?", [targetId]);
          }
        }
      }
      return { success: true };
    });
    await this.notify("state:changed", {});
    await this.notify("voice:changed", {});
    return result;
  }
  async dm(userId, requestId2, otherId) {
    return this.mutate(userId, requestId2, "dm.create", { otherId }, async (tx) => {
      if (otherId === userId || !await tx.one("SELECT id FROM users WHERE id=?", [otherId])) fail(400, "INVALID_USER", "Select another registered user.");
      const pair = [userId, otherId].sort().join(":");
      const old = await tx.one("SELECT conversation_id FROM dm_pairs WHERE pair_key=?", [pair]);
      if (old) return { id: old.conversation_id };
      const cv = randomUUID();
      await tx.run("INSERT INTO conversations(id,kind,created_at) VALUES(?,?,?)", [cv, "dm", Date.now()]);
      for (const u of [userId, otherId]) await tx.run("INSERT INTO dm_members(conversation_id,user_id) VALUES(?,?)", [cv, u]);
      await tx.run("INSERT INTO dm_pairs(pair_key,conversation_id) VALUES(?,?)", [pair, cv]);
      return { id: cv };
    });
  }
  async messageView(tx, messageId) {
    const m = await tx.one("SELECT m.*,u.username,u.display_name,u.bio,u.avatar,u.status,u.instance_admin FROM messages m JOIN users u ON m.user_id=u.id WHERE m.id=?", [messageId]);
    if (!m) fail(404, "NOT_FOUND", "Message not found.");
    const reactions = {};
    for (const r of await tx.all("SELECT emoji,user_id FROM reactions WHERE message_id=?", [messageId])) (reactions[r.emoji] ||= []).push(r.user_id);
    return { id: m.id, conversationId: m.conversation_id, sequence: Number(m.sequence), author: publicUser({ ...m, id: m.user_id }), content: m.deleted ? "" : m.content, replyTo: m.reply_to, createdAt: Number(m.created_at), editedAt: m.edited_at ? Number(m.edited_at) : null, deleted: Boolean(m.deleted), reactions: Object.entries(reactions).map(([emoji, userIds]) => ({ emoji, userIds })) };
  }
  async event(tx, conversationId, kind, payload) {
    await tx.run("UPDATE conversations SET sequence=sequence+1 WHERE id=?", [conversationId]);
    const cv = await tx.one("SELECT sequence FROM conversations WHERE id=?", [conversationId]);
    const event = { conversationId, sequence: Number(cv.sequence), kind, payload };
    if ((await tx.one("SELECT COUNT(*) AS count FROM events")).count >= 5e4) await tx.run("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY created_at LIMIT 200)");
    await tx.run("INSERT INTO events(id,conversation_id,sequence,kind,payload,created_at) VALUES(?,?,?,?,?,?)", [randomUUID(), conversationId, event.sequence, kind, JSON.stringify(payload), Date.now()]);
    return event;
  }
  async send(userId, requestId2, conversationId, content, replyTo) {
    const event = await this.mutate(userId, requestId2, "message.send", { conversationId, content, replyTo }, async (tx) => {
      const cv = await this.conversation(tx, userId, conversationId, true);
      if (replyTo && !await tx.one("SELECT id FROM messages WHERE id=? AND conversation_id=?", [replyTo, conversationId])) fail(400, "INVALID_REPLY", "Reply target is unavailable.");
      if ((await tx.one("SELECT COUNT(*) AS count FROM messages")).count >= this.c.maxMessages) {
        await tx.run("DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY created_at LIMIT 200)");
      }
      const messageId = randomUUID();
      await tx.run("INSERT INTO messages(id,conversation_id,sequence,user_id,content,reply_to,created_at) VALUES(?,?,?,?,?,?,?)", [messageId, conversationId, Number(cv.sequence) + 1, userId, content, replyTo || null, Date.now()]);
      return this.event(tx, conversationId, "message", await this.messageView(tx, messageId));
    });
    await this.notify("conversation:event", event);
    return event;
  }
  async changeMessage(userId, requestId2, messageId, body) {
    const event = await this.mutate(userId, requestId2, "message.change", { messageId, ...body }, async (tx) => {
      const m = await tx.one("SELECT * FROM messages WHERE id=?", [messageId]);
      if (!m) fail(404, "NOT_FOUND", "Message not found.");
      const cv = await this.conversation(tx, userId, m.conversation_id, true);
      if (body.emoji) {
        if (m.deleted) fail(409, "DELETED", "Message has been deleted.");
        if (body.removeReaction) await tx.run("DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?", [messageId, userId, body.emoji]);
        else {
          if ((await tx.one("SELECT COUNT(*) AS count FROM reactions WHERE message_id=?", [messageId])).count >= 100) fail(409, "LIMIT", "Reaction limit reached.");
          await tx.run("INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?) ON CONFLICT DO NOTHING", [messageId, userId, body.emoji]);
        }
      } else {
        if (m.user_id !== userId) {
          const ch = cv.kind === "channel" ? await tx.one("SELECT id FROM channels WHERE conversation_id=?", [m.conversation_id]) : void 0;
          if (!body.delete || !ch) fail(403, "FORBIDDEN", "You can edit only your own messages.");
          await this.channel(tx, userId, ch.id, "moderate");
        }
        if (m.deleted) fail(409, "DELETED", "Message has been deleted.");
        await tx.run("UPDATE messages SET content=?,deleted=?,edited_at=? WHERE id=?", [body.delete ? "" : body.content, body.delete ? 1 : 0, Date.now(), messageId]);
        if (body.delete) await tx.run("DELETE FROM reactions WHERE message_id=?", [messageId]);
      }
      return this.event(tx, m.conversation_id, "message", await this.messageView(tx, messageId));
    });
    await this.notify("conversation:event", event);
    return event;
  }
  async history(userId, conversationId, before, after) {
    return this.db.transaction(async (tx) => {
      const cv = await this.conversation(tx, userId, conversationId);
      if (after !== void 0) {
        const min = await tx.one("SELECT MIN(sequence) AS first FROM events WHERE conversation_id=?", [conversationId]);
        if (after > Number(cv.sequence) || after < Number(cv.sequence) && (min?.first == null || Number(min.first) > after + 1)) return { reset: true, sequence: Number(cv.sequence), events: [] };
        const rows2 = await tx.all("SELECT * FROM events WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT 200", [conversationId, after]);
        return { reset: false, sequence: Number(cv.sequence), events: rows2.map((e) => ({ conversationId, sequence: Number(e.sequence), kind: e.kind, payload: JSON.parse(e.payload) })) };
      }
      const rows = await tx.all("SELECT id FROM messages WHERE conversation_id=? AND sequence<? ORDER BY sequence DESC LIMIT 50", [conversationId, before || Number.MAX_SAFE_INTEGER]);
      const messages = [];
      for (const m of rows.reverse()) messages.push(await this.messageView(tx, m.id));
      return { messages, sequence: Number(cv.sequence), hasMore: rows.length === 50 };
    });
  }
  async read(userId, requestId2, conversationId, sequence) {
    return this.mutate(userId, requestId2, "conversation.read", { conversationId, sequence }, async (tx) => {
      const cv = await this.conversation(tx, userId, conversationId);
      const old = await tx.one("SELECT sequence FROM read_cursors WHERE conversation_id=? AND user_id=?", [conversationId, userId]);
      await tx.run("INSERT INTO read_cursors(conversation_id,user_id,sequence) VALUES(?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET sequence=excluded.sequence", [conversationId, userId, Math.max(Number(old?.sequence || 0), Math.min(sequence, Number(cv.sequence)))]);
      return { success: true };
    });
  }
  async maintainRoom(tx, channelId) {
    const now = Date.now();
    await tx.run("DELETE FROM share_leases WHERE expires_at<?", [now]);
    await tx.run("DELETE FROM voice_members WHERE heartbeat<?", [now - 3e4]);
    const current = await tx.one("SELECT * FROM coordinators WHERE channel_id=?", [channelId]);
    const candidate = await tx.one("SELECT user_id,heartbeat FROM voice_members WHERE channel_id=? AND eligible=1 AND heartbeat>=? ORDER BY joined_at,user_id LIMIT 1", [channelId, now - 15e3]);
    const valid = current?.user_id && await tx.one("SELECT user_id,heartbeat FROM voice_members WHERE channel_id=? AND user_id=? AND eligible=1 AND heartbeat>=?", [channelId, current.user_id, now - 15e3]);
    const chosen = valid || candidate;
    const changed = (current?.user_id || null) !== (chosen?.user_id || null) || current && current.expires_at < now && chosen;
    const epoch = Number(current?.epoch || 0) + (changed || !current ? 1 : 0);
    await tx.run("INSERT INTO coordinators(channel_id,user_id,epoch,expires_at) VALUES(?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET user_id=excluded.user_id,epoch=excluded.epoch,expires_at=excluded.expires_at", [channelId, chosen?.user_id || null, epoch, chosen ? Number(chosen.heartbeat) + 15e3 : 0]);
  }
  async voiceDirectory(userId, tx = this.db) {
    const rooms = [], now = Date.now();
    for (const ch of await tx.all("SELECT DISTINCT channel_id FROM voice_members WHERE heartbeat>=?", [now - 3e4])) {
      try {
        await this.channel(tx, userId, ch.channel_id);
      } catch {
        continue;
      }
      const members = (await tx.all("SELECT v.*,u.username,u.display_name,u.bio,u.avatar,u.status FROM voice_members v JOIN users u ON u.id=v.user_id WHERE v.channel_id=? AND v.heartbeat>=? ORDER BY v.joined_at", [ch.channel_id, now - 3e4])).map((vm) => ({ user: publicUser({ ...vm, id: vm.user_id }), muted: Boolean(vm.muted), deafened: Boolean(vm.deafened), serverMuted: Boolean(vm.server_muted) }));
      const shares = await tx.one("SELECT COUNT(*) AS count FROM share_leases WHERE channel_id=? AND expires_at>=?", [ch.channel_id, now]);
      rooms.push({ channelId: ch.channel_id, members, shares: Number(shares.count) });
    }
    return rooms;
  }
  async room(userId, channelId) {
    return this.db.transaction(async (tx) => {
      await this.channel(tx, userId, channelId);
      await this.maintainRoom(tx, channelId);
      return this.roomView(tx, channelId);
    });
  }
  async roomView(tx, channelId) {
    const members = [];
    for (const vm of await tx.all("SELECT v.*,u.username,u.display_name,u.bio,u.avatar,u.status,u.instance_admin FROM voice_members v JOIN users u ON u.id=v.user_id WHERE v.channel_id=? ORDER BY v.joined_at", [channelId])) {
      let canShare = false;
      try {
        canShare = (await this.channel(tx, vm.user_id, channelId, "share")).permissions.share;
      } catch {
      }
      members.push({ user: publicUser({ ...vm, id: vm.user_id }), muted: Boolean(vm.muted), deafened: Boolean(vm.deafened), serverMuted: Boolean(vm.server_muted), canShare, epoch: vm.epoch, eligible: Boolean(vm.eligible), joinedAt: Number(vm.joined_at) });
    }
    const shares = (await tx.all("SELECT * FROM share_leases WHERE channel_id=? AND expires_at>=?", [channelId, Date.now()])).map((s) => ({ id: s.id, channelId: s.channel_id, userId: s.user_id, expiresAt: Number(s.expires_at) }));
    const coordinator = await tx.one("SELECT * FROM coordinators WHERE channel_id=?", [channelId]);
    return { channelId, members, shares, coordinatorId: coordinator?.user_id || null, coordinatorEpoch: Number(coordinator?.epoch || 0), transport: this.c.mediaTransport };
  }
  async joinVoice(userId, socketId, channelId, eligible) {
    const result = await this.db.transaction(async (tx) => {
      const ch = await this.channel(tx, userId, channelId);
      if (ch.kind !== "voice") fail(400, "NOT_VOICE", "Select a voice channel.");
      await this.maintainRoom(tx, channelId);
      const previous = await tx.one("SELECT * FROM voice_members WHERE user_id=?", [userId]);
      if (previous && previous.socket_id === socketId && previous.channel_id === channelId) return { epoch: previous.epoch, room: await this.roomView(tx, channelId) };
      const count = await tx.one("SELECT COUNT(*) AS count FROM voice_members WHERE channel_id=? AND user_id<>?", [channelId, userId]);
      if (count.count >= this.c.maxVoice) fail(409, "ROOM_FULL", "Voice channel is full.");
      await tx.run("DELETE FROM voice_members WHERE user_id=?", [userId]);
      const epoch = randomUUID(), now = Date.now();
      await tx.run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,server_muted,eligible,heartbeat,joined_at) VALUES(?,?,?,?,?,?,?,?)", [userId, channelId, socketId, epoch, ch.permissions.speak ? 0 : 1, eligible ? 1 : 0, now, now]);
      if (previous && previous.channel_id !== channelId) await this.maintainRoom(tx, previous.channel_id);
      await this.maintainRoom(tx, channelId);
      return { epoch, room: await this.roomView(tx, channelId) };
    });
    await this.notify("voice:changed", {});
    return { ...result, iceServers: this.iceServers(userId) };
  }
  iceServers(userId) {
    const servers = this.c.stunUrls.length ? [{ urls: this.c.stunUrls }] : [];
    if (this.c.turnUrls.length) {
      const username = this.c.turnSecret ? `${Math.floor(Date.now() / 1e3) + 3600}:${userId}` : this.c.turnUsername;
      const credential = this.c.turnSecret ? createHmac("sha1", this.c.turnSecret).update(username).digest("base64") : this.c.turnPassword;
      servers.push({ urls: this.c.turnUrls, username, credential });
    }
    return servers;
  }
  async voiceAction(userId, socketId, action, body = {}) {
    const result = await this.db.transaction(async (tx) => {
      const vm = await tx.one("SELECT * FROM voice_members WHERE user_id=? AND socket_id=?", [userId, socketId]);
      if (!vm) fail(409, "NOT_IN_VOICE", "Voice session is no longer active.");
      if (action === "leave") await tx.run("DELETE FROM voice_members WHERE user_id=?", [userId]);
      else {
        try {
          await this.channel(tx, userId, vm.channel_id);
        } catch {
          await tx.run("DELETE FROM voice_members WHERE user_id=?", [userId]);
          return { removed: true };
        }
        await tx.run("UPDATE voice_members SET heartbeat=?,muted=?,deafened=?,eligible=? WHERE user_id=?", [Date.now(), body.muted === void 0 ? vm.muted : Number(body.muted), body.deafened === void 0 ? vm.deafened : Number(body.deafened), body.eligible === void 0 ? vm.eligible : Number(body.eligible), userId]);
        await tx.run("UPDATE share_leases SET expires_at=? WHERE user_id=? AND expires_at>=?", [Date.now() + 3e4, userId, Date.now()]);
      }
      await this.maintainRoom(tx, vm.channel_id);
      return { room: await this.roomView(tx, vm.channel_id) };
    });
    if (action !== "heartbeat") await this.notify("voice:changed", {});
    return result;
  }
  async share(userId, socketId, requestId2, stop = false) {
    const result = await this.mutate(userId, requestId2, stop ? "share.stop" : "share.start", {}, async (tx) => {
      const vm = await tx.one("SELECT * FROM voice_members WHERE user_id=? AND socket_id=?", [userId, socketId]);
      if (!vm) fail(409, "NOT_IN_VOICE", "Join voice before sharing.");
      if (stop) {
        await tx.run("DELETE FROM share_leases WHERE user_id=?", [userId]);
        return { lease: null };
      }
      await this.channel(tx, userId, vm.channel_id, "share");
      await this.maintainRoom(tx, vm.channel_id);
      const old = await tx.one("SELECT * FROM share_leases WHERE user_id=?", [userId]);
      if (old) return { lease: { id: old.id, channelId: old.channel_id, userId, expiresAt: Number(old.expires_at) } };
      const global = await tx.one("SELECT COUNT(*) AS count FROM share_leases"), room = await tx.one("SELECT COUNT(*) AS count FROM share_leases WHERE channel_id=?", [vm.channel_id]);
      if (global.count >= this.c.globalShares || room.count >= this.c.roomShares) fail(409, "SHARE_LIMIT", "Screen-sharing capacity is full.");
      const lease = { id: randomUUID(), channelId: vm.channel_id, userId, expiresAt: Date.now() + 3e4 };
      await tx.run("INSERT INTO share_leases(id,user_id,channel_id,expires_at) VALUES(?,?,?,?)", [lease.id, userId, lease.channelId, lease.expiresAt]);
      return { lease };
    });
    await this.notify("voice:changed", {});
    return result;
  }
  async moderate(userId, requestId2, channelId, targetId, action) {
    const result = await this.mutate(userId, requestId2, "voice.moderate", { channelId, targetId, action }, async (tx) => {
      const ch = await this.channel(tx, userId, channelId, "moderate"), target = await this.member(tx, targetId, ch.server_id);
      if (userId !== targetId && !canManage(ch.role, target.role)) fail(403, "HIERARCHY", "Cannot moderate this member.");
      if (action === "kick") await tx.run("DELETE FROM voice_members WHERE channel_id=? AND user_id=?", [channelId, targetId]);
      if (action === "stopShare") await tx.run("DELETE FROM share_leases WHERE channel_id=? AND user_id=?", [channelId, targetId]);
      if (action === "mute" || action === "unmute") {
        if (action === "unmute") await this.channel(tx, targetId, channelId, "speak");
        await tx.run("UPDATE voice_members SET server_muted=? WHERE channel_id=? AND user_id=?", [action === "mute" ? 1 : 0, channelId, targetId]);
      }
      await this.maintainRoom(tx, channelId);
      return { success: true };
    });
    await this.notify("voice:changed", {});
    return result;
  }
  async cleanup() {
    await this.db.transaction(async (tx) => {
      const now = Date.now();
      await tx.run("DELETE FROM sessions WHERE expires_at<?", [now]);
      await tx.run("DELETE FROM used_refresh WHERE expires_at<?", [now]);
      await tx.run("DELETE FROM invites WHERE expires_at<? OR remaining<1", [now]);
      await tx.run("DELETE FROM mutations WHERE created_at<?", [now - 864e5]);
      await tx.run("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE created_at<? ORDER BY created_at LIMIT 1000)", [now - 7 * 864e5]);
      await tx.run("DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE created_at<? ORDER BY created_at LIMIT 500)", [now - this.c.retentionDays * 864e5]);
      for (const ch of await tx.all("SELECT id FROM channels WHERE kind='voice'")) await this.maintainRoom(tx, ch.id);
    });
  }
};
var schemas = {
  name: z2.string().trim().min(1).max(64),
  profile: z2.object({ displayName: z2.string().trim().min(1).max(48), bio: z2.string().max(500), status: z2.enum(["online", "idle", "busy"]), requestId }),
  channel: z2.object({ name: z2.string().trim().min(1).max(64), kind: z2.enum(["text", "voice"]), requestId }),
  role: z2.enum(["owner", "administrator", "moderator", "member"]),
  permissions: z2.object({ view: z2.boolean().optional(), write: z2.boolean().optional(), speak: z2.boolean().optional(), share: z2.boolean().optional(), manageChannels: z2.boolean().optional(), manageMembers: z2.boolean().optional(), moderate: z2.boolean().optional() }).strict()
};

// apps/api/src/sfu.ts
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
var Sfu = class {
  constructor(c, service) {
    this.c = c;
    this.service = service;
    this.client = c.mediaTransport === "livekit" ? new RoomServiceClient(c.livekitUrl.replace(/^ws/, "http"), c.livekitKey, c.livekitSecret) : null;
  }
  c;
  service;
  client;
  async credentials(userId, socketId, channelId) {
    if (!this.client) fail(409, "SFU_DISABLED", "This instance uses peer-to-peer media.");
    const vm = await this.service.db.one("SELECT * FROM voice_members WHERE user_id=? AND socket_id=? AND channel_id=? AND heartbeat>=?", [userId, socketId, channelId, Date.now() - 3e4]);
    if (!vm) fail(403, "FORBIDDEN", "An active voice session is required.");
    const access = await this.service.channel(this.service.db, userId, channelId);
    const lease = await this.service.db.one("SELECT id FROM share_leases WHERE user_id=? AND expires_at>=?", [userId, Date.now()]);
    const sources = [];
    if (access.permissions.speak && !vm.server_muted) sources.push(TrackSource.MICROPHONE);
    if (access.permissions.share && lease) sources.push(TrackSource.SCREEN_SHARE);
    const jwt = new AccessToken(this.c.livekitKey, this.c.livekitSecret, { identity: `${userId}:${vm.epoch}`, ttl: 60, name: userId });
    jwt.addGrant({ roomJoin: true, room: channelId, canSubscribe: true, canPublish: sources.length > 0, canPublishSources: sources, canPublishData: false, canUpdateOwnMetadata: false });
    return { url: this.c.livekitUrl, token: await jwt.toJwt(), identity: `${userId}:${vm.epoch}` };
  }
  async synchronize() {
    if (!this.client) return;
    const rooms = await this.client.listRooms();
    for (const room of rooms) {
      if (!await this.service.db.one("SELECT id FROM channels WHERE id=? AND kind='voice'", [room.name])) continue;
      for (const participant of await this.client.listParticipants(room.name)) {
        const [userId, epoch] = participant.identity.split(":");
        const vm = await this.service.db.one("SELECT * FROM voice_members WHERE user_id=? AND epoch=? AND channel_id=? AND heartbeat>=?", [userId, epoch, room.name, Date.now() - 3e4]);
        if (!vm) {
          await this.client.removeParticipant(room.name, participant.identity);
          continue;
        }
        const ch = await this.service.channel(this.service.db, userId, room.name);
        const lease = await this.service.db.one("SELECT id FROM share_leases WHERE user_id=? AND expires_at>=?", [userId, Date.now()]);
        const sources = [];
        if (ch.permissions.speak && !vm.server_muted) sources.push(TrackSource.MICROPHONE);
        if (ch.permissions.share && lease) sources.push(TrackSource.SCREEN_SHARE);
        await this.client.updateParticipant(room.name, participant.identity, { permission: { canSubscribe: true, canPublish: sources.length > 0, canPublishSources: sources, canPublishData: false, canUpdateMetadata: false } });
      }
    }
  }
};

// apps/api/src/app.ts
async function createApp(c = config(), options = {}) {
  const app2 = Fastify({ logger: options.logger ?? !process.env.VITEST, bodyLimit: 128 * 1024, trustProxy: false, requestTimeout: 15e3 });
  await mkdir(c.dataDir, { recursive: true });
  const lockPath = path.join(c.dataDir, "instance.lock");
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid instance.lock. Verify no server is running before removing it.");
    try {
      process.kill(pid, 0);
      throw new Error("Another server already owns this data directory.");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
      unlinkSync(lockPath);
    }
  }
  const lock = openSync(lockPath, "wx");
  writeSync(lock, String(process.pid));
  closeSync(lock);
  const db = await openDatabase(c), service = new Service(db, c), sfu = new Sfu(c, service);
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM voice_members");
    await tx.run("UPDATE coordinators SET user_id=NULL,epoch=epoch+1,expires_at=0");
  });
  const avatarDir = path.join(c.dataDir, "avatars");
  await mkdir(avatarDir, { recursive: true });
  async function storageStatus() {
    const databaseBytes = c.databaseUrl ? null : Number((await db.one("PRAGMA page_count")).page_count) * Number((await db.one("PRAGMA page_size")).page_size);
    let avatarBytes = 0;
    for (const name of await readdir(avatarDir)) avatarBytes += (await stat(path.join(avatarDir, name))).size;
    const databaseBudgetBytes = c.maxDatabaseMiB * 1048576, avatarBudgetBytes = c.maxAvatarsMiB * 1048576;
    const warnings = [];
    if (databaseBytes !== null && databaseBytes >= databaseBudgetBytes * 0.8) warnings.push("Database is at least 80% of its page budget. Prune data or migrate storage.");
    if (avatarBytes >= avatarBudgetBytes * 0.8) warnings.push("Avatar storage is at least 80% of its budget.");
    return { databaseBytes, databaseBudgetBytes: c.databaseUrl ? null : databaseBudgetBytes, avatarBytes, avatarBudgetBytes, warnings };
  }
  await app2.register(cookie);
  const allowed = (origin) => !origin || c.origins.includes(origin);
  await app2.register(cors, { origin: (origin, cb) => cb(null, allowed(origin)), credentials: true, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "X-Request-Id", "X-Dorham-Native"] });
  await app2.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:", "blob:"], connectSrc: ["'self'", "https:", "wss:", ...c.production ? [] : ["http:", "ws:"]], mediaSrc: ["'self'", "blob:"], objectSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginEmbedderPolicy: false });
  await app2.register(rateLimit, { global: options.rateLimit !== false, max: 600, timeWindow: "1 minute" });
  await app2.register(multipart, { limits: { fileSize: 256 * 1024, files: 1, fields: 0 } });
  app2.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: "VALIDATION", message: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 400) } });
    if (error instanceof AppError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error.code === "SQLITE_FULL") return reply.code(507).send({ error: { code: "STORAGE_FULL", message: "Storage is full. Contact the instance administrator." } });
    if (error.code?.includes("CONSTRAINT") || error.code === "23505") return reply.code(409).send({ error: { code: "CONFLICT", message: "The record already exists or changed. Refresh and retry." } });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: { code: "REQUEST_ERROR", message: error.message } });
    app2.log.error({ err: error }, "Request failed");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "The request could not be completed." } });
  });
  app2.addHook("onRequest", async (req, reply) => {
    if (!allowed(req.headers.origin)) return reply.code(403).send({ error: { code: "ORIGIN", message: "Origin is not allowed." } });
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  });
  async function resolveSession(raw) {
    if (!raw || raw.length > 512) return void 0;
    const session = await db.one("SELECT * FROM sessions WHERE access_hash=? AND access_expires>=? AND expires_at>=?", [hash(raw), Date.now(), Date.now()]);
    if (!session) return void 0;
    const account = await db.one("SELECT * FROM users WHERE id=?", [session.user_id]);
    return account ? { session, account } : void 0;
  }
  async function authenticate(req, _reply) {
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : void 0;
    const resolved = await resolveSession(bearer || req.cookies.dorham_session);
    if (!resolved) fail(401, "UNAUTHENTICATED", "Please sign in.");
    req.account = resolved.account;
    req.session = resolved.session;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !bearer) {
      if (!req.headers.origin || !allowed(req.headers.origin) || !equal(String(req.headers["x-csrf-token"] || ""), req.session.csrf)) fail(403, "CSRF", "Refresh your session and retry.");
    }
  }
  const setCookie = (reply, access) => reply.setCookie("dorham_session", access, { httpOnly: true, secure: c.secure, sameSite: "lax", path: "/", maxAge: 30 * 86400 });
  async function sessionFor(userId, native, reply) {
    const access = token(), refresh = native ? token() : null, csrf = token(), now = Date.now();
    await db.transaction(async (tx) => {
      const old = await tx.all("SELECT id FROM sessions WHERE user_id=? ORDER BY created_at DESC", [userId]);
      for (const s of old.slice(2)) await tx.run("DELETE FROM sessions WHERE id=?", [s.id]);
      await tx.run("INSERT INTO sessions(id,user_id,access_hash,refresh_hash,csrf,native,access_expires,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)", [randomUUID2(), userId, hash(access), refresh ? hash(refresh) : null, csrf, Number(native), now + (native ? 15 * 6e4 : 30 * 864e5), now + 30 * 864e5, now]);
    });
    const account = await db.one("SELECT * FROM users WHERE id=?", [userId]);
    if (!native) setCookie(reply, access);
    return { user: publicUser(account), csrf, ...native ? { accessToken: access, refreshToken: refresh } : {} };
  }
  app2.get("/health", async () => ({ status: "ok" }));
  app2.get("/ready", async () => {
    await db.one("SELECT version FROM schema_migrations LIMIT 1");
    return { status: "ready", database: db.dialect };
  });
  app2.get("/api/v1/config", async () => ({ registrationOpen: c.registrationOpen, mediaTransport: c.mediaTransport, publicUrl: c.publicUrl }));
  const authRate = options.rateLimit === false ? {} : { rateLimit: { max: 60, timeWindow: "15 minutes" } };
  app2.post("/api/v1/auth/register", { config: authRate }, async (req, reply) => {
    if (!c.registrationOpen) fail(403, "REGISTRATION_CLOSED", "Registration is closed.");
    const body = registerSchema.parse(req.body), username = body.username.toLowerCase();
    const encoded = await passwordHash(body.password);
    const userId = await db.transaction(async (tx) => {
      const count = await tx.one("SELECT COUNT(*) AS count FROM users");
      if (count.count >= c.maxUsers) fail(409, "ACCOUNT_LIMIT", "This instance has reached its account limit.");
      if (await tx.one("SELECT id FROM users WHERE username=?", [username])) fail(409, "USERNAME_TAKEN", "This username is unavailable.");
      const userId2 = randomUUID2();
      await tx.run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)", [userId2, username, body.displayName, encoded, Date.now()]);
      return userId2;
    });
    await service.notify("state:changed", {});
    return reply.code(201).send(await sessionFor(userId, req.headers["x-dorham-native"] === "1", reply));
  });
  app2.post("/api/v1/auth/login", { config: authRate }, async (req, reply) => {
    const body = credentialsSchema.extend({ requestId }).parse(req.body);
    const user = await db.one("SELECT * FROM users WHERE username=?", [body.username.toLowerCase()]);
    if (!user) {
      await passwordHash(body.password);
      fail(401, "INVALID_CREDENTIALS", "Username or password is incorrect.");
    }
    if (!await passwordVerify(user.password_hash, body.password)) fail(401, "INVALID_CREDENTIALS", "Username or password is incorrect.");
    return sessionFor(user.id, req.headers["x-dorham-native"] === "1", reply);
  });
  app2.post("/api/v1/auth/refresh", { config: authRate }, async (req) => {
    const body = z3.object({ refreshToken: z3.string().min(20).max(512), requestId }).parse(req.body), fingerprint = hash(body.refreshToken);
    const outcome = await db.transaction(async (tx) => {
      const reused = await tx.one("SELECT session_id FROM used_refresh WHERE hash=?", [fingerprint]);
      if (reused) {
        await tx.run("DELETE FROM sessions WHERE id=?", [reused.session_id]);
        return null;
      }
      const old = await tx.one("SELECT * FROM sessions WHERE refresh_hash=? AND native=1 AND expires_at>=?", [fingerprint, Date.now()]);
      if (!old) return null;
      const accessToken = token(), refreshToken = token();
      await tx.run("INSERT INTO used_refresh(hash,session_id,expires_at) VALUES(?,?,?)", [fingerprint, old.id, old.expires_at]);
      await tx.run("UPDATE sessions SET access_hash=?,refresh_hash=?,access_expires=? WHERE id=?", [hash(accessToken), hash(refreshToken), Date.now() + 15 * 6e4, old.id]);
      return { accessToken, refreshToken, csrf: old.csrf };
    });
    if (!outcome) fail(401, "REFRESH_INVALID", "Session expired. Sign in again.");
    return outcome;
  });
  await app2.register(async (api) => {
    api.addHook("preHandler", authenticate);
    api.get("/auth/me", async (req) => ({ user: publicUser(req.account), csrf: req.session.csrf }));
    api.post("/auth/logout", async (req, reply) => {
      z3.object({ requestId }).parse(req.body);
      await db.run("DELETE FROM sessions WHERE id=?", [req.session.id]);
      for (const s of io.sockets.sockets.values()) if (s.data.sessionId === req.session.id) s.disconnect(true);
      reply.clearCookie("dorham_session", { path: "/" });
      return { success: true };
    });
    api.post("/auth/password", async (req) => {
      const b = z3.object({ currentPassword: z3.string().max(128), password: z3.string().min(10).max(128), requestId }).parse(req.body);
      if (!await passwordVerify(req.account.password_hash, b.currentPassword)) fail(401, "INVALID_CREDENTIALS", "Current password is incorrect.");
      const encoded = await passwordHash(b.password);
      const result = await service.mutate(req.account.id, b.requestId, "password.change", { fingerprint: hash(b.password) }, async (tx) => {
        await tx.run("UPDATE users SET password_hash=? WHERE id=?", [encoded, req.account.id]);
        await tx.run("DELETE FROM sessions WHERE user_id=? AND id<>?", [req.account.id, req.session.id]);
        return { success: true };
      });
      await disconnectInvalidSessions();
      return result;
    });
    api.post("/admin/claim", async (req) => {
      const b = z3.object({ secret: z3.string().max(256), requestId }).parse(req.body);
      if (!c.bootstrapSecret || !equal(c.bootstrapSecret, b.secret)) fail(403, "FORBIDDEN", "Bootstrap secret is invalid.");
      return service.mutate(req.account.id, b.requestId, "admin.claim", {}, async (tx) => {
        if (await tx.one("SELECT value FROM meta WHERE key='admin_claimed'")) fail(409, "ALREADY_CLAIMED", "Instance administration has already been claimed.");
        await tx.run("UPDATE users SET instance_admin=1 WHERE id=?", [req.account.id]);
        await tx.run("INSERT INTO meta(key,value) VALUES('admin_claimed',?)", [req.account.id]);
        return { success: true };
      });
    });
    api.get("/bootstrap", async (req) => service.bootstrap(req.account.id));
    api.patch("/profile", async (req) => {
      const b = schemas.profile.parse(req.body);
      const result = await service.mutate(req.account.id, b.requestId, "profile.change", b, async (tx) => {
        await tx.run("UPDATE users SET display_name=?,bio=?,status=? WHERE id=?", [b.displayName, b.bio, b.status, req.account.id]);
        return { success: true };
      });
      await service.notify("state:changed", {});
      return result;
    });
    api.post("/profile/avatar", async (req) => {
      const rid = requestId.parse(req.headers["x-request-id"]);
      const file = await req.file();
      if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.mimetype)) fail(400, "IMAGE_REQUIRED", "Upload a PNG, JPEG, or WebP image.");
      const bytes = await file.toBuffer();
      let image;
      try {
        image = await sharp(bytes, { limitInputPixels: 16e6 }).rotate().resize(128, 128, { fit: "cover" }).webp({ quality: 80 }).toBuffer();
      } catch {
        fail(400, "INVALID_IMAGE", "Image could not be decoded.");
      }
      if (image.length > 96 * 1024) fail(400, "IMAGE_TOO_LARGE", "Compressed avatar is too large.");
      const result = await service.mutate(req.account.id, rid, "avatar.change", { hash: hash(bytes.toString("base64")) }, async (tx) => {
        let size = 0;
        for (const f of await readdir(avatarDir)) size += (await stat(path.join(avatarDir, f))).size;
        if (size + image.length > c.maxAvatarsMiB * 1024 * 1024) fail(507, "AVATAR_QUOTA", "Avatar storage is full.");
        const name = `${randomUUID2()}.webp`;
        await writeFile(path.join(avatarDir, name), image, { flag: "wx" });
        const old = await tx.one("SELECT avatar FROM users WHERE id=?", [req.account.id]);
        await tx.run("UPDATE users SET avatar=? WHERE id=?", [`/avatars/${name}`, req.account.id]);
        if (old?.avatar) await unlink(path.join(avatarDir, path.basename(old.avatar))).catch(() => {
        });
        return { avatar: `/avatars/${name}` };
      });
      await service.notify("state:changed", {});
      return result;
    });
    api.post("/servers", async (req) => {
      const b = z3.object({ name: schemas.name, requestId }).parse(req.body);
      return service.createServer(req.account.id, b.requestId, b.name);
    });
    api.patch("/servers/:id", async (req) => {
      const b = z3.object({ name: schemas.name.optional(), delete: z3.boolean().optional(), requestId }).refine((b2) => b2.name || b2.delete).parse(req.body);
      return service.changeServer(req.account.id, b.requestId, id.parse(req.params.id), b);
    });
    api.post("/servers/:id/channels", async (req) => {
      const b = schemas.channel.parse(req.body);
      return service.createChannel(req.account.id, b.requestId, id.parse(req.params.id), b.name, b.kind);
    });
    api.patch("/channels/:id", async (req) => {
      const b = z3.object({ name: schemas.name.optional(), delete: z3.boolean().optional(), role: schemas.role.optional(), permissions: schemas.permissions.optional(), requestId }).refine((b2) => b2.name || b2.delete || b2.role && b2.permissions).parse(req.body);
      return service.changeChannel(req.account.id, b.requestId, id.parse(req.params.id), b);
    });
    api.post("/servers/:id/invites", async (req) => {
      const b = z3.object({ hours: z3.number().int().min(1).max(168).default(24), uses: z3.number().int().min(1).max(100).default(10), requestId }).parse(req.body);
      return service.invite(req.account.id, b.requestId, id.parse(req.params.id), token(), b.hours, b.uses);
    });
    api.post("/invites/join", async (req) => {
      const b = z3.object({ code: z3.string().min(10).max(100), requestId }).parse(req.body);
      return service.joinInvite(req.account.id, b.requestId, b.code);
    });
    api.get("/servers/:id/members", async (req) => service.members(req.account.id, id.parse(req.params.id)));
    api.patch("/servers/:serverId/members/:userId", async (req) => {
      const b = z3.object({ role: schemas.role.optional(), remove: z3.boolean().optional(), requestId }).refine((b2) => b2.role || b2.remove).parse(req.body), p = req.params;
      return service.changeMember(req.account.id, b.requestId, id.parse(p.serverId), id.parse(p.userId), b);
    });
    api.post("/dms", async (req) => {
      const b = z3.object({ userId: id, requestId }).parse(req.body);
      const result = await service.dm(req.account.id, b.requestId, b.userId);
      await service.notify("state:changed", {});
      return result;
    });
    api.get("/conversations/:id/messages", async (req) => {
      const b = z3.object({ before: z3.coerce.number().int().min(1).optional(), after: z3.coerce.number().int().min(0).optional() }).parse(req.query);
      return service.history(req.account.id, id.parse(req.params.id), b.before, b.after);
    });
    api.post("/messages", async (req) => {
      const b = messageSchema.parse(req.body);
      return service.send(req.account.id, b.requestId, b.conversationId, b.content, b.replyTo);
    });
    api.patch("/messages/:id", async (req) => {
      const b = z3.object({ content: z3.string().trim().min(1).max(4e3).optional(), delete: z3.boolean().optional(), emoji: z3.enum(["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F389}", "\u{1F440}", "\u2705"]).optional(), removeReaction: z3.boolean().optional(), requestId }).refine((b2) => b2.content || b2.delete || b2.emoji).parse(req.body);
      return service.changeMessage(req.account.id, b.requestId, id.parse(req.params.id), b);
    });
    api.post("/conversations/:id/read", async (req) => {
      const b = z3.object({ sequence: z3.number().int().min(0), requestId }).parse(req.body);
      return service.read(req.account.id, b.requestId, id.parse(req.params.id), b.sequence);
    });
    api.get("/voice/:id", async (req) => service.room(req.account.id, id.parse(req.params.id)));
    api.post("/voice/:id/moderate", async (req) => {
      const b = z3.object({ userId: id, action: z3.enum(["mute", "unmute", "kick", "stopShare"]), requestId }).parse(req.body);
      return service.moderate(req.account.id, b.requestId, id.parse(req.params.id), b.userId, b.action);
    });
    api.get("/admin/metrics", async (req) => {
      if (!req.account.instance_admin) fail(403, "FORBIDDEN", "Instance administrator required.");
      let disk = 0;
      for (const f of await readdir(c.dataDir)) {
        const s = await stat(path.join(c.dataDir, f));
        if (s.isFile()) disk += s.size;
      }
      return { uptimeSeconds: process.uptime(), memory: process.memoryUsage(), cpu: process.cpuUsage(), dataBytes: disk, storage: await storageStatus(), connectedUsers: new Set([...io.sockets.sockets.values()].map((s) => s.data.userId)).size, accounts: (await db.one("SELECT COUNT(*) AS count FROM users")).count, messages: (await db.one("SELECT COUNT(*) AS count FROM messages")).count, shares: (await db.one("SELECT COUNT(*) AS count FROM share_leases")).count };
    });
  }, { prefix: "/api/v1" });
  const io = new SocketServer(app2.server, { cors: { origin: c.origins, credentials: true }, maxHttpBufferSize: 128 * 1024, connectionStateRecovery: { maxDisconnectionDuration: 12e4, skipMiddlewares: false }, pingInterval: 2e4, pingTimeout: 1e4, allowRequest: (req, callback) => callback(null, allowed(req.headers.origin)) });
  io.use(async (socket, next) => {
    try {
      const cookieValue = String(socket.handshake.headers.cookie || "").split(";").map((s) => s.trim()).find((s) => s.startsWith("dorham_session="))?.split("=")[1];
      const resolved = await resolveSession(socket.handshake.auth.token || cookieValue);
      if (!resolved) throw new Error("Please sign in.");
      if (!socket.handshake.auth.token && !equal(String(socket.handshake.auth.csrf || ""), resolved.session.csrf)) throw new Error("Invalid session proof.");
      socket.data.userId = resolved.account.id;
      socket.data.sessionId = resolved.session.id;
      const users = new Set([...io.sockets.sockets.values()].map((s) => s.data.userId));
      if (!users.has(socket.data.userId) && users.size >= c.maxOnline) throw new Error("This instance is at its online capacity.");
      next();
    } catch (error) {
      next(new Error(error.message));
    }
  });
  async function validSocket(socket) {
    const session = await db.one("SELECT id FROM sessions WHERE id=? AND expires_at>=? AND access_expires>=?", [socket.data.sessionId, Date.now(), Date.now()]);
    if (!session) {
      socket.disconnect(true);
      fail(401, "UNAUTHENTICATED", "Session expired.");
    }
  }
  async function disconnectInvalidSessions() {
    for (const s of io.sockets.sockets.values()) {
      try {
        await validSocket(s);
      } catch {
      }
    }
  }
  service.notify = async (kind, payload) => {
    if (kind === "conversation:event") {
      for (const s of io.sockets.sockets.values()) {
        try {
          await service.conversation(db, s.data.userId, payload.conversationId);
          s.emit(kind, payload);
        } catch {
        }
      }
    } else if (kind === "voice:changed") {
      for (const s of io.sockets.sockets.values()) {
        s.emit("voice:directory", await service.voiceDirectory(s.data.userId));
        if (!s.data.voiceChannel) continue;
        const vm = await db.one("SELECT channel_id FROM voice_members WHERE user_id=? AND socket_id=?", [s.data.userId, s.id]);
        if (!vm) {
          s.emit("voice:removed", {});
          s.data.voiceChannel = null;
          continue;
        }
        try {
          s.emit("voice:room", await service.room(s.data.userId, vm.channel_id));
        } catch {
          s.emit("voice:removed", {});
          s.data.voiceChannel = null;
        }
      }
      if (sfu.client) {
        try {
          await sfu.synchronize();
        } catch (err) {
          app2.log.error({ err }, "SFU permission synchronization failed");
          fail(503, "SFU_UNAVAILABLE", "Control changes were saved, but SFU enforcement could not be confirmed. Retry when the media server is available.");
        }
      }
    } else io.emit(kind, payload);
  };
  io.on("connection", (socket) => {
    const connected = new Set([...io.sockets.sockets.values()].map((s) => s.data.userId));
    if (connected.size > c.maxOnline) {
      socket.emit("capacity", { message: "Online capacity reached." });
      socket.disconnect(true);
      return;
    }
    io.emit("presence", { userId: socket.data.userId, online: true });
    let windowStart = Date.now(), eventCount = 0;
    const handle = (event, fn) => socket.on(event, async (body, ack) => {
      if (typeof ack !== "function") return;
      try {
        if (Date.now() - windowStart > 1e4) {
          windowStart = Date.now();
          eventCount = 0;
        }
        if (++eventCount > 400) fail(429, "RATE_LIMIT", "Too many real-time actions.");
        await validSocket(socket);
        const result = await fn(body);
        ack({ ok: true, data: result });
      } catch (e) {
        ack({ ok: false, error: { code: e.code || "INVALID_REQUEST", message: e instanceof ZodError ? "Invalid real-time payload." : e.status && e.status < 500 ? e.message : "Real-time action failed." } });
      }
    });
    handle("message:send", async (b) => {
      const m = messageSchema.parse(b);
      return service.send(socket.data.userId, m.requestId, m.conversationId, m.content, m.replyTo);
    });
    handle("typing", async (b) => {
      const v = z3.object({ conversationId: id, active: z3.boolean() }).parse(b);
      await service.conversation(db, socket.data.userId, v.conversationId, true);
      for (const s of io.sockets.sockets.values()) {
        if (s.id === socket.id) continue;
        try {
          await service.conversation(db, s.data.userId, v.conversationId);
          s.emit("typing", { ...v, userId: socket.data.userId });
        } catch {
        }
      }
      return {};
    });
    handle("voice:join", async (b) => {
      const v = z3.object({ channelId: id, eligible: z3.boolean() }).parse(b);
      const result = await service.joinVoice(socket.data.userId, socket.id, v.channelId, v.eligible);
      socket.data.voiceChannel = v.channelId;
      return result;
    });
    handle("voice:leave", async (b) => {
      z3.object({ requestId }).parse(b);
      const result = await service.voiceAction(socket.data.userId, socket.id, "leave");
      socket.data.voiceChannel = null;
      return result;
    });
    handle("voice:heartbeat", async (b) => {
      const v = z3.object({ eligible: z3.boolean().optional() }).parse(b);
      const result = await service.voiceAction(socket.data.userId, socket.id, "heartbeat", v);
      if ("room" in result) socket.emit("voice:room", result.room);
      return result;
    });
    handle("voice:state", async (b) => {
      const v = z3.object({ muted: z3.boolean(), deafened: z3.boolean(), requestId }).parse(b);
      return service.voiceAction(socket.data.userId, socket.id, "state", v);
    });
    handle("share:start", async (b) => {
      const v = z3.object({ requestId }).parse(b);
      return service.share(socket.data.userId, socket.id, v.requestId);
    });
    handle("share:stop", async (b) => {
      const v = z3.object({ requestId }).parse(b);
      return service.share(socket.data.userId, socket.id, v.requestId, true);
    });
    handle("voice:sfu", async (b) => {
      const v = z3.object({ channelId: id }).parse(b);
      return sfu.credentials(socket.data.userId, socket.id, v.channelId);
    });
    handle("voice:signal", async (b) => {
      const v = signalSchema.parse(b), sender = await db.one("SELECT * FROM voice_members WHERE user_id=? AND socket_id=? AND channel_id=? AND epoch=?", [socket.data.userId, socket.id, v.channelId, v.epoch]);
      if (!sender) fail(403, "STALE_EPOCH", "Voice session is no longer current.");
      await service.channel(db, socket.data.userId, v.channelId);
      const target = await db.one("SELECT * FROM voice_members WHERE user_id=? AND channel_id=?", [v.to, v.channelId]);
      if (!target) fail(404, "PEER_LEFT", "Peer left the room.");
      await service.channel(db, target.user_id, v.channelId);
      for (const stream of v.streams || []) if (stream.kind === "screen") {
        if (!await db.one("SELECT id FROM share_leases WHERE id=? AND user_id=? AND channel_id=? AND expires_at>=?", [stream.leaseId, socket.data.userId, v.channelId, Date.now()])) fail(403, "SHARE_EXPIRED", "Screen-share authorization expired.");
      }
      io.to(target.socket_id).emit("voice:signal", { ...v, from: socket.data.userId });
      return {};
    });
    socket.on("disconnect", async () => {
      try {
        const vm = await db.one("SELECT channel_id FROM voice_members WHERE socket_id=?", [socket.id]);
        if (vm) {
          await service.voiceAction(socket.data.userId, socket.id, "leave");
          await service.notify("voice:changed", {});
        }
        if (![...io.sockets.sockets.values()].some((s) => s.data.userId === socket.data.userId)) io.emit("presence", { userId: socket.data.userId, online: false });
      } catch (err) {
        app2.log.error({ err }, "Disconnect cleanup failed");
      }
    });
  });
  app2.get("/api/v1/presence", { preHandler: authenticate }, async () => ({ online: [...new Set([...io.sockets.sockets.values()].map((s) => s.data.userId))] }));
  await app2.register(staticPlugin, { root: avatarDir, prefix: "/avatars/", decorateReply: false, maxAge: 36e5, immutable: true });
  const webRoot = path.resolve("apps/web/dist");
  if (existsSync(webRoot)) {
    await app2.register(staticPlugin, { root: webRoot, prefix: "/" });
    app2.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/avatars/")) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found." } });
      return reply.sendFile("index.html");
    });
  }
  let maintenanceRunning = false, nextStorageCheck = 0, storageWasPressured = false;
  const maintenance = setInterval(async () => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      await service.cleanup();
      await disconnectInvalidSessions();
      await service.notify("voice:changed", {});
      if (Date.now() >= nextStorageCheck) {
        nextStorageCheck = Date.now() + 6e4;
        const storage = await storageStatus();
        if (storage.warnings.length && !storageWasPressured) app2.log.warn({ storage }, "Storage pressure: act before writes fail");
        storageWasPressured = storage.warnings.length > 0;
      }
    } catch (err) {
      app2.log.error({ err }, "Maintenance failed");
    } finally {
      maintenanceRunning = false;
    }
  }, 5e3);
  maintenance.unref();
  app2.addHook("preClose", async () => {
    clearInterval(maintenance);
    io.engine.close();
  });
  app2.addHook("onClose", async () => {
    await new Promise((resolve) => io.close(() => resolve()));
    await db.close();
    if (existsSync(lockPath) && readFileSync(lockPath, "utf8") === String(process.pid)) unlinkSync(lockPath);
  });
  return { app: app2, db, service, io, config: c };
}

// apps/api/src/index.ts
import { writeFile as writeFile2 } from "fs/promises";
import path2 from "path";
var { app, config: config2 } = await createApp();
await app.listen({ port: config2.port, host: config2.host });
await writeFile2(path2.join(config2.dataDir, "runtime-status.json"), JSON.stringify({
  startedAt: (/* @__PURE__ */ new Date()).toISOString(),
  node: process.version,
  platform: process.platform,
  pid: process.pid,
  host: config2.host,
  port: config2.port,
  publicUrl: config2.publicUrl,
  database: config2.databaseUrl ? "postgresql" : "sqlite",
  rssBytes: process.memoryUsage().rss
}, null, 2), { mode: 384 }).catch((error) => app.log.warn({ error }, "Could not save startup evidence"));
for (const event of ["SIGINT", "SIGTERM"]) process.once(event, () => {
  void app.close().then(() => process.exit(0));
});
//# sourceMappingURL=index.js.map