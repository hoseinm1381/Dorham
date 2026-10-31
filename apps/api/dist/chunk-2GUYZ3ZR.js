// packages/contracts/src/index.ts
import { z } from "zod";
var id = z.string().min(1).max(80);
var requestId = z.string().uuid();
var permissions = ["view", "write", "speak", "share", "manageChannels", "manageMembers", "moderate", "createInvites"];
var shareStartSchema = z.object({ requestId, protocolVersion: z.literal(2), includeAudio: z.boolean().default(false) }).strict();
var shareUpdateSchema = z.object({ requestId, leaseId: id, expectedRevision: z.number().int().positive(), frameRate: z.union([z.literal(15), z.literal(30)]).optional(), includeAudio: z.literal(false).optional() }).strict();
var passwordSchema = z.string().min(8).max(128);
var credentialsSchema = z.object({ username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/), password: passwordSchema });
var registerSchema = credentialsSchema.extend({ displayName: z.string().trim().min(1).max(48), language: z.enum(["en-US", "fa-IR"]).optional(), requestId });
var messageSchema = z.object({ conversationId: id, content: z.string().trim().max(4e3), replyTo: id.nullable().optional(), attachmentIds: z.array(z.string().uuid()).max(4).default([]), requestId }).refine((v) => v.content.length > 0 || v.attachmentIds.length > 0, { message: "Write a message or attach a file." });
var signalSchema = z.object({ channelId: id, to: id, epoch: id, description: z.object({ type: z.enum(["offer", "answer", "pranswer", "rollback"]), sdp: z.string().max(1e5).optional() }).optional(), candidate: z.object({ candidate: z.string().max(4096).optional(), sdpMid: z.string().nullable().optional(), sdpMLineIndex: z.number().int().nullable().optional(), usernameFragment: z.string().nullable().optional() }).nullable().optional(), streams: z.array(z.object({ streamId: id, kind: z.enum(["audio", "screen"]), leaseId: id.optional() })).max(3).optional(), subscription: z.object({ leaseId: id, enabled: z.boolean() }).optional() });
var rank = { member: 0, moderator: 1, administrator: 2, owner: 3 };
function basePermissions(role) {
  return { view: true, write: true, speak: true, share: true, manageChannels: rank[role] >= 2, manageMembers: rank[role] >= 1, moderate: rank[role] >= 1, createInvites: true };
}
function canManage(actor, target) {
  return rank[actor] > rank[target];
}
function resolveCustomPermissions(role, assigned, channel = {}) {
  if (role === "owner") return basePermissions(role);
  const result = basePermissions(role);
  for (const p of permissions) {
    if (assigned.some((r) => r[p] === false)) result[p] = false;
    else if (assigned.some((r) => r[p] === true)) result[p] = true;
  }
  return { ...result, ...channel };
}

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

// apps/api/src/accounts.ts
import { randomUUID as randomUUID2 } from "crypto";
import { z as z4 } from "zod";

// apps/api/src/service.ts
import { randomUUID, createHmac } from "crypto";
import { z as z3 } from "zod";

// apps/api/src/turn.ts
import { z as z2 } from "zod";
var cloudflareTurnTtl = 86400;
var iceResponse = z2.object({ iceServers: z2.array(z2.object({
  urls: z2.union([z2.string(), z2.array(z2.string()).min(1).max(12)]),
  username: z2.string().min(1).max(2048).optional(),
  credential: z2.string().min(1).max(2048).optional()
})).min(1).max(8) });
var CloudflareTurn = class {
  constructor(keyId, apiToken, fetcher = fetch, now = Date.now) {
    this.keyId = keyId;
    this.apiToken = apiToken;
    this.fetcher = fetcher;
    this.now = now;
  }
  keyId;
  apiToken;
  fetcher;
  now;
  cache = /* @__PURE__ */ new Map();
  async forUser(userId) {
    const now = this.now(), previous = this.cache.get(userId);
    if (previous && previous.until > now) return structuredClone(await previous.request);
    for (const [id2, entry2] of this.cache) if (entry2.until <= now) this.cache.delete(id2);
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value);
    const entry = { until: now + 6e4, request: this.generate() };
    this.cache.set(userId, entry);
    return structuredClone(await entry.request);
  }
  async generate() {
    try {
      const response = await this.fetcher(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.keyId)}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: cloudflareTurnTtl }),
        signal: AbortSignal.timeout(5e3),
        redirect: "error"
      });
      if (!response.ok || !response.body) throw new Error("TURN response failed");
      const reader = response.body.getReader(), chunks = [];
      let bytes = 0;
      try {
        for (; ; ) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 65536) throw new Error("TURN response exceeded budget");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {
        });
        reader.releaseLock();
      }
      const parsed = iceResponse.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const servers = [];
      for (const server of parsed.iceServers) {
        const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => /^(stun|turn|turns):(?:stun|turn)\.cloudflare\.com:(3478|443|80|5349)(\?transport=(udp|tcp))?$/.test(url));
        if (!urls.length) continue;
        if (urls.some((url) => /^turns?:/.test(url)) && (!server.username || !server.credential)) throw new Error("TURN credentials missing");
        servers.push({ urls, ...server.username ? { username: server.username } : {}, ...server.credential ? { credential: server.credential } : {} });
      }
      if (!servers.some((server) => server.urls.some((url) => /^turns?:/.test(url)))) throw new Error("TURN relay missing");
      return servers;
    } catch {
      return fail(503, "TURN_UNAVAILABLE", "The media relay is unavailable. Please retry shortly or contact the server owner.");
    }
  }
};

// apps/api/src/read-snapshot.ts
function readSnapshot(tx) {
  const cache = /* @__PURE__ */ new Map();
  const read = (kind, query, params, fn) => {
    const key = JSON.stringify([kind, query, params || []]);
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  return {
    all: (q, p) => read("all", q, p, () => tx.all(q, p)),
    one: (q, p) => read("one", q, p, () => tx.one(q, p)),
    run: async (q, p) => {
      cache.clear();
      await tx.run(q, p);
    }
  };
}

// apps/api/src/share-policy.ts
function shareView(row, c) {
  return {
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id,
    expiresAt: Number(row.expires_at),
    tier: row.tier,
    startedAt: Number(row.started_at),
    requestedFrameRate: Number(row.requested_fps),
    maxFrameRate: Math.min(row.tier === "standard" ? 30 : 15, c.screenMaxFrameRate),
    includeAudio: Boolean(row.include_audio),
    policyRevision: Number(row.policy_revision)
  };
}
async function reconcileShares(tx, c) {
  await tx.run("DELETE FROM share_leases WHERE expires_at<?", [Date.now()]);
  const count = await tx.one("SELECT COUNT(*) AS count FROM share_leases WHERE tier='standard'");
  const available = Math.max(0, c.standardShareSlots - Number(count.count));
  if (!available) return;
  const waiting = await tx.all("SELECT id FROM share_leases WHERE tier='fallback' ORDER BY started_at,id LIMIT ?", [available]);
  for (const row of waiting) await tx.run("UPDATE share_leases SET tier='standard',policy_revision=policy_revision+1 WHERE id=? AND tier='fallback'", [row.id]);
}

// apps/api/src/service.ts
var publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.display_name, bio: u.bio, avatar: u.avatar, status: u.status, instanceAdmin: Boolean(u.instance_admin), guest: Boolean(u.guest), banned: Boolean(u.banned), language: u.language === "fa-IR" ? "fa-IR" : u.language === "en-US" ? "en-US" : void 0, mustChangePassword: Boolean(u.must_change_password) });
var Service = class {
  constructor(db, c) {
    this.db = db;
    this.c = c;
    this.cloudflareTurn = c.cloudflareTurnKeyId ? new CloudflareTurn(c.cloudflareTurnKeyId, c.cloudflareTurnApiToken) : null;
  }
  db;
  c;
  notify = async () => {
  };
  cloudflareTurn;
  async mutate(userId, requestId2, operation, payload, fn) {
    requestId.parse(requestId2);
    const fingerprint = hash(JSON.stringify(payload));
    return this.db.transaction(async (tx) => {
      if (!await tx.one("SELECT id FROM users WHERE id=? AND banned=0", [userId])) fail(403, "FORBIDDEN", "Account access is unavailable.");
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
    const account = await tx.one("SELECT * FROM users WHERE id=? AND banned=0", [userId]);
    if (!account) fail(403, "FORBIDDEN", "Account access is unavailable.");
    if (account.instance_admin) {
      if (!await tx.one("SELECT id FROM servers WHERE id=?", [serverId])) fail(404, "NOT_FOUND", "Server not found.");
      return { server_id: serverId, user_id: userId, role: "owner", globalAdmin: true };
    }
    if (account.guest && permission && ["manageChannels", "manageMembers", "moderate"].includes(permission)) fail(403, "GUEST_ACCOUNT", "Register before using administration controls.");
    if (account.guest && !(await tx.one("SELECT allow_guests FROM servers WHERE id=?", [serverId]))?.allow_guests) fail(403, "GUESTS_DISABLED", "This server does not allow guests.");
    const m = await tx.one("SELECT * FROM members WHERE server_id=? AND user_id=?", [serverId, userId]);
    if (!m || permission && !(await this.memberPermissions(tx, m.role, userId, serverId))[permission]) fail(403, "FORBIDDEN", "You do not have permission.");
    return m;
  }
  async assignedRoles(tx, userId, serverId) {
    return (await tx.all("SELECT r.* FROM custom_roles r JOIN member_roles mr ON mr.role_id=r.id AND mr.server_id=r.server_id WHERE mr.user_id=? AND r.server_id=? ORDER BY r.name", [userId, serverId])).map((r) => ({ id: r.id, serverId: r.server_id, name: r.name, color: r.color, permissions: JSON.parse(r.permissions) }));
  }
  async memberPermissions(tx, role, userId, serverId) {
    const permissions2 = resolveCustomPermissions(role, (await this.assignedRoles(tx, userId, serverId)).map((r) => r.permissions));
    if (role !== "owner" && !(await tx.one("SELECT allow_member_invites FROM servers WHERE id=?", [serverId]))?.allow_member_invites) permissions2.createInvites = false;
    if ((await tx.one("SELECT guest FROM users WHERE id=?", [userId]))?.guest) {
      permissions2.manageChannels = false;
      permissions2.manageMembers = false;
      permissions2.moderate = false;
    }
    return permissions2;
  }
  async authority(tx, member) {
    if (member.role !== "member") return member.role;
    const p = await this.memberPermissions(tx, member.role, member.user_id, member.server_id);
    return p.moderate || p.manageMembers ? "moderator" : "member";
  }
  async channel(tx, userId, channelId, permission = "view") {
    const ch = await tx.one("SELECT * FROM channels WHERE id=?", [channelId]);
    if (!ch) fail(404, "NOT_FOUND", "Channel not found.");
    const m = await this.member(tx, userId, ch.server_id);
    const override = await tx.one("SELECT permissions FROM channel_overrides WHERE channel_id=? AND role=?", [channelId, m.role]);
    const permissions2 = resolveCustomPermissions(m.role, (await this.assignedRoles(tx, userId, ch.server_id)).map((r) => r.permissions), override ? JSON.parse(override.permissions) : {});
    if ((await tx.one("SELECT guest FROM users WHERE id=?", [userId]))?.guest) {
      permissions2.manageChannels = false;
      permissions2.manageMembers = false;
      permissions2.moderate = false;
    }
    if (m.role !== "owner" && !(await tx.one("SELECT allow_member_invites FROM servers WHERE id=?", [ch.server_id]))?.allow_member_invites) permissions2.createInvites = false;
    const restriction = await tx.one("SELECT sharing_allowed FROM voice_restrictions WHERE channel_id=? AND user_id=?", [channelId, userId]);
    if (restriction && !restriction.sharing_allowed) permissions2.share = false;
    if (ch.kind === "voice" && m.role !== "owner") {
      const required = await tx.all("SELECT tag_id FROM channel_tags WHERE channel_id=?", [channelId]);
      if (required.length) {
        const assigned = new Set((await tx.all("SELECT tag_id FROM user_tags WHERE user_id=?", [userId])).map((t) => t.tag_id));
        const allowed = ch.tag_mode === "ALL" ? required.every((t) => assigned.has(t.tag_id)) : required.some((t) => assigned.has(t.tag_id));
        if (!allowed) fail(403, "TAG_REQUIRED", "This voice channel requires an assigned tag.");
      }
    }
    if (!permissions2.view || !permissions2[permission]) fail(403, "FORBIDDEN", "Channel permission denied.");
    return { ...ch, role: m.role, permissions: permissions2 };
  }
  async conversation(tx, userId, conversationId, write = false) {
    const cv = await tx.one("SELECT * FROM conversations WHERE id=?", [conversationId]);
    if (!cv) fail(404, "NOT_FOUND", "Conversation not found.");
    if (cv.kind === "dm") {
      if (!await tx.one("SELECT user_id FROM dm_members WHERE conversation_id=? AND user_id=?", [conversationId, userId])) fail(403, "FORBIDDEN", "Private conversation.");
      if (write) {
        const other = await tx.one("SELECT user_id FROM dm_members WHERE conversation_id=? AND user_id<>?", [conversationId, userId]);
        if (other) await this.allowDirectMessage(tx, userId, other.user_id);
      }
    } else {
      const ch = await tx.one("SELECT id FROM channels WHERE conversation_id=?", [conversationId]);
      if (!ch) fail(404, "NOT_FOUND", "Channel not found.");
      await this.channel(tx, userId, ch.id, write ? "write" : "view");
    }
    return cv;
  }
  async conversationAudience(viewers, conversationId, writerId) {
    return this.db.transaction(async (connection) => {
      const tx = readSnapshot(connection), allowed = /* @__PURE__ */ new Map();
      if (writerId) await this.conversation(tx, writerId, conversationId, true);
      const audience = [];
      for (const viewer of viewers) {
        if (!allowed.has(viewer.userId)) {
          try {
            const user = await tx.one("SELECT * FROM users WHERE id=? AND banned=0", [viewer.userId]);
            if (!user || user.must_change_password) fail(403, "FORBIDDEN", "Account access is unavailable.");
            await this.conversation(tx, viewer.userId, conversationId);
            allowed.set(viewer.userId, true);
          } catch {
            allowed.set(viewer.userId, false);
          }
        }
        if (allowed.get(viewer.userId)) audience.push(viewer.socketId);
      }
      return audience;
    });
  }
  async bootstrap(userId) {
    return this.db.transaction(async (connection) => {
      const tx = readSnapshot(connection);
      const me = await tx.one("SELECT * FROM users WHERE id=?", [userId]);
      const servers = (await tx.all("SELECT s.*,m.role FROM servers s LEFT JOIN members m ON m.server_id=s.id AND m.user_id=? WHERE m.user_id IS NOT NULL OR ?=1 ORDER BY s.created_at", [userId, me.instance_admin])).map((s) => ({ id: s.id, name: s.name, ownerId: s.owner_id, icon: s.icon, role: me.instance_admin ? "owner" : s.role, allowGuests: Boolean(s.allow_guests), allowMemberInvites: Boolean(s.allow_member_invites) }));
      for (const server of servers) Object.assign(server, { permissions: await this.memberPermissions(tx, server.role, userId, server.id) });
      const allChannels = await tx.all("SELECT c.* FROM channels c LEFT JOIN members m ON c.server_id=m.server_id AND m.user_id=? WHERE m.user_id IS NOT NULL OR ?=1 ORDER BY c.created_at", [userId, me.instance_admin]);
      const channels = [];
      for (const ch of allChannels) {
        try {
          const access = await this.channel(tx, userId, ch.id);
          channels.push({ id: ch.id, serverId: ch.server_id, name: ch.name, kind: ch.kind, conversationId: ch.conversation_id, permissions: access.permissions, locked: Boolean(ch.locked), userLimit: Math.min(ch.user_limit, this.c.maxVoice), tagMode: ch.tag_mode, requiredTags: (await tx.all("SELECT tag_id FROM channel_tags WHERE channel_id=?", [ch.id])).map((t) => t.tag_id) });
        } catch {
        }
      }
      const dms = await tx.all("SELECT d.conversation_id,u.id,u.username,u.display_name,u.bio,u.avatar,u.status,u.instance_admin,(SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id=d.conversation_id) AS last_message_at FROM dm_members d JOIN dm_members other ON other.conversation_id=d.conversation_id AND other.user_id<>d.user_id JOIN users u ON u.id=other.user_id WHERE d.user_id=? AND d.hidden=0 ORDER BY last_message_at DESC,d.conversation_id", [userId]);
      const blockedUsers = (await tx.all("SELECT u.* FROM users u JOIN user_blocks b ON b.blocked_id=u.id WHERE b.user_id=?", [userId])).map(publicUser);
      const blockedPeers = new Set((await tx.all("SELECT user_id,blocked_id FROM user_blocks WHERE user_id=? OR blocked_id=?", [userId, userId])).map((b) => b.user_id === userId ? b.blocked_id : b.user_id));
      const unread = {};
      for (const conversationId of [...channels.map((c) => c.conversationId).filter(Boolean), ...dms.map((d) => d.conversation_id)]) {
        const cv = await tx.one("SELECT MAX(sequence) AS sequence FROM messages WHERE conversation_id=? AND deleted=0", [conversationId]);
        const read = await tx.one("SELECT sequence FROM read_cursors WHERE conversation_id=? AND user_id=?", [conversationId, userId]);
        unread[conversationId] = { sequence: Number(cv?.sequence || 0), readSequence: Number(read?.sequence || 0) };
      }
      return { me: publicUser(me), servers, channels, voicePresence: await this.voiceDirectory(userId, tx), dms: dms.map((d) => ({ id: d.conversation_id, lastMessageAt: Number(d.last_message_at || 0), user: publicUser(d), blocked: blockedPeers.has(d.id), blockedByMe: blockedUsers.some((u) => u.id === d.id) })), blockedUsers, users: (await tx.all("SELECT * FROM users ORDER BY username LIMIT 250")).map(publicUser), unread, mediaTransport: this.c.mediaTransport, screenPolicy: { maxBitrate: this.c.screenMaxBitrate, maxFrameRate: this.c.screenMaxFrameRate }, limits: { users: this.c.maxUsers, online: this.c.maxOnline, voice: this.c.maxVoice, roomShares: this.c.roomShares, globalShares: this.c.globalShares } };
    });
  }
  async createServer(userId, requestId2, name) {
    const result = await this.mutate(userId, requestId2, "server.create", { name }, async (tx) => {
      if ((await tx.one("SELECT guest FROM users WHERE id=?", [userId]))?.guest) fail(403, "GUEST_ACCOUNT", "Register before creating a server.");
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
      if (body.allowMemberInvites !== void 0 && m.role !== "owner") fail(403, "FORBIDDEN", "Only the owner can change member invitations.");
      if (body.delete) {
        if (m.role !== "owner") fail(403, "FORBIDDEN", "Only the owner can delete a server.");
        const cvs = await tx.all("SELECT conversation_id FROM channels WHERE server_id=?", [serverId]);
        await tx.run("DELETE FROM servers WHERE id=?", [serverId]);
        for (const cv of cvs) if (cv.conversation_id) await tx.run("DELETE FROM conversations WHERE id=?", [cv.conversation_id]);
      } else {
        if (body.name) await tx.run("UPDATE servers SET name=? WHERE id=?", [body.name, serverId]);
        if (body.allowGuests !== void 0) {
          await tx.run("UPDATE servers SET allow_guests=? WHERE id=?", [Number(body.allowGuests), serverId]);
          await this.revalidateVoice(tx, serverId);
        }
      }
      if (!body.delete && body.allowMemberInvites !== void 0) await tx.run("UPDATE servers SET allow_member_invites=? WHERE id=?", [Number(body.allowMemberInvites), serverId]);
      await audit(tx, userId, "server.change", serverId, { delete: Boolean(body.delete), allowGuests: body.allowGuests, allowMemberInvites: body.allowMemberInvites });
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
  async channelOverrides(userId, channelId, role) {
    const ch = await this.channel(this.db, userId, channelId, "manageChannels");
    if (!canManage(ch.role, role)) fail(403, "HIERARCHY", "You cannot manage this role.");
    const row = await this.db.one("SELECT permissions,revision FROM channel_overrides WHERE channel_id=? AND role=?", [channelId, role]);
    return { channelId, role, revision: Number(row?.revision || 0), permissions: row ? JSON.parse(row.permissions) : {} };
  }
  async changeChannel(userId, requestId2, channelId, body) {
    const result = await this.mutate(userId, requestId2, "channel.change", { channelId, ...body }, async (tx) => {
      const ch = await this.channel(tx, userId, channelId, "manageChannels");
      if (body.role && !canManage(ch.role, body.role)) fail(403, "HIERARCHY", "You cannot manage this role.");
      if (body.delete) {
        await tx.run("DELETE FROM channels WHERE id=?", [channelId]);
        if (ch.conversation_id) await tx.run("DELETE FROM conversations WHERE id=?", [ch.conversation_id]);
      } else {
        if (body.name) await tx.run("UPDATE channels SET name=? WHERE id=?", [body.name, channelId]);
        if (body.role && body.permissions) {
          if (body.expectedRevision === void 0) fail(428, "UPGRADE_REQUIRED", "Update Dorham before editing channel permissions.");
          const old = await tx.one("SELECT revision FROM channel_overrides WHERE channel_id=? AND role=?", [channelId, body.role]);
          if (Number(old?.revision || 0) !== body.expectedRevision) fail(409, "STALE_PERMISSIONS", "Permissions changed. Reload them before saving.");
          await tx.run("INSERT INTO channel_overrides(channel_id,role,permissions,revision) VALUES(?,?,?,?) ON CONFLICT(channel_id,role) DO UPDATE SET permissions=excluded.permissions,revision=excluded.revision", [channelId, body.role, JSON.stringify(body.permissions), body.expectedRevision + 1]);
        }
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
  async invite(userId, requestId2, serverId, value, expiresHours, uses, channelId) {
    return this.mutate(userId, requestId2, "invite.create", { serverId, expiresHours, uses, channelId }, async (tx) => {
      await this.member(tx, userId, serverId, "createInvites");
      if ((await tx.one("SELECT COUNT(*) AS count FROM invites WHERE server_id=? AND expires_at>? AND remaining>0", [serverId, Date.now()])).count >= 50) fail(409, "LIMIT", "Revoke an active invitation before creating another.");
      if (channelId) {
        const channel = await this.channel(tx, userId, channelId);
        if (channel.server_id !== serverId) fail(400, "INVALID_CHANNEL", "Choose a channel in this server.");
      }
      await tx.run("INSERT INTO invites(hash,server_id,expires_at,remaining,created_by,code,channel_id) VALUES(?,?,?,?,?,?,?)", [hash(value), serverId, Date.now() + expiresHours * 36e5, uses, userId, value, channelId || null]);
      return { code: value, url: `${this.c.publicUrl}/?invite=${value}` };
    });
  }
  async invitations(userId, serverId) {
    return this.db.transaction(async (tx) => {
      const member = await this.member(tx, userId, serverId, "createInvites"), manageAll = await this.authority(tx, member) !== "member";
      return { invites: (await tx.all("SELECT code,expires_at,remaining,channel_id FROM invites WHERE server_id=? AND expires_at>? AND remaining>0 AND code IS NOT NULL" + (manageAll ? "" : " AND created_by=?") + " ORDER BY expires_at DESC", [serverId, Date.now(), ...manageAll ? [] : [userId]])).map((r) => ({ code: r.code, url: `${this.c.publicUrl}/?invite=${r.code}`, expiresAt: Number(r.expires_at), remaining: r.remaining, channelId: r.channel_id })) };
    });
  }
  async revokeInvitation(userId, rid, serverId, code) {
    return this.mutate(userId, rid, "invite.revoke", { serverId, code }, async (tx) => {
      const member = await this.member(tx, userId, serverId, "createInvites"), manageAll = await this.authority(tx, member) !== "member";
      const invitation = await tx.one("SELECT created_by FROM invites WHERE server_id=? AND hash=?", [serverId, hash(code)]);
      if (invitation && !manageAll && invitation.created_by !== userId) fail(403, "FORBIDDEN", "You can revoke only your own invitations.");
      await tx.run("DELETE FROM invites WHERE server_id=? AND hash=?", [serverId, hash(code)]);
      await audit(tx, userId, "invite.revoke", serverId);
      return { success: true };
    });
  }
  async customRoles(userId, serverId) {
    await this.member(this.db, userId, serverId);
    return { roles: (await this.db.all("SELECT * FROM custom_roles WHERE server_id=? ORDER BY name", [serverId])).map((r) => ({ id: r.id, serverId, name: r.name, color: r.color, permissions: JSON.parse(r.permissions) })) };
  }
  async changeCustomRole(userId, rid, serverId, body) {
    const result = await this.mutate(userId, rid, "role.change", { serverId, ...body }, async (tx) => {
      const actor = await this.member(tx, userId, serverId);
      if (!["owner", "administrator"].includes(actor.role) || (await tx.one("SELECT guest FROM users WHERE id=?", [userId]))?.guest) fail(403, "FORBIDDEN", "Only owners and administrators can manage custom roles.");
      const existing = body.roleId ? await tx.one("SELECT * FROM custom_roles WHERE id=? AND server_id=?", [body.roleId, serverId]) : void 0;
      if (body.roleId && !existing) fail(404, "NOT_FOUND", "Role not found.");
      const roleId = body.roleId || randomUUID();
      if (body.userId) {
        if (!existing || body.assigned === void 0) fail(400, "INVALID_ROLE", "Choose a role and assignment.");
        const target = await this.member(tx, body.userId, serverId);
        if (!await tx.one("SELECT user_id FROM members WHERE server_id=? AND user_id=?", [serverId, body.userId])) fail(404, "NOT_FOUND", "Member not found.");
        if (actor.role !== "owner" && !canManage(actor.role, target.role)) fail(403, "HIERARCHY", "You cannot manage this member.");
        if ((await tx.one("SELECT guest FROM users WHERE id=?", [body.userId]))?.guest) fail(403, "GUEST_ROLE", "Register the guest before assigning custom roles.");
        if (body.assigned) await tx.run("INSERT INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?) ON CONFLICT DO NOTHING", [serverId, body.userId, roleId]);
        else await tx.run("DELETE FROM member_roles WHERE server_id=? AND user_id=? AND role_id=?", [serverId, body.userId, roleId]);
      } else if (body.delete) {
        if (!existing) fail(404, "NOT_FOUND", "Role not found.");
        await tx.run("DELETE FROM custom_roles WHERE id=?", [roleId]);
      } else {
        if (!body.name || !body.color || !body.permissions) fail(400, "INVALID_ROLE", "Set a name, color and permissions.");
        if (await tx.one("SELECT id FROM custom_roles WHERE server_id=? AND name=? AND id<>?", [serverId, body.name, roleId])) fail(409, "ROLE_NAME", "A role with this name already exists.");
        if (!existing && (await tx.one("SELECT COUNT(*) AS count FROM custom_roles WHERE server_id=?", [serverId])).count >= 32) fail(409, "LIMIT", "A server can have up to 32 custom roles.");
        await tx.run("INSERT INTO custom_roles(id,server_id,name,color,permissions) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,permissions=excluded.permissions", [roleId, serverId, body.name, body.color, JSON.stringify(body.permissions)]);
      }
      await this.revalidateVoice(tx, serverId);
      await audit(tx, userId, "role.change", roleId, { serverId, ...body });
      return { id: roleId };
    });
    await this.notify("state:changed", {});
    await this.notify("voice:changed", {});
    return result;
  }
  async joinInvite(userId, requestId2, code) {
    const result = await this.mutate(userId, requestId2, "invite.join", { code }, async (tx) => {
      const inv = await tx.one("SELECT * FROM invites WHERE hash=?", [hash(code)]);
      if (!inv || inv.expires_at < Date.now() || inv.remaining < 1) fail(404, "INVITE_EXPIRED", "Invite is invalid, expired, or exhausted.");
      const account = await tx.one("SELECT guest FROM users WHERE id=?", [userId]);
      if (account.guest && !(await tx.one("SELECT allow_guests FROM servers WHERE id=?", [inv.server_id]))?.allow_guests) fail(403, "GUESTS_DISABLED", "This server does not allow guests.");
      if (await tx.one("SELECT role FROM members WHERE user_id=? AND server_id=?", [userId, inv.server_id])) return { id: inv.server_id, channelId: inv.channel_id };
      if ((await tx.one("SELECT COUNT(*) AS count FROM members WHERE user_id=?", [userId])).count >= 20) fail(409, "LIMIT", "Server membership limit reached.");
      await tx.run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)", [inv.server_id, userId, "member", Date.now()]);
      await tx.run("UPDATE invites SET remaining=remaining-1 WHERE hash=?", [hash(code)]);
      return { id: inv.server_id, channelId: inv.channel_id };
    });
    await this.notify("state:changed", {});
    return result;
  }
  async members(userId, serverId) {
    await this.member(this.db, userId, serverId);
    const rows = await this.db.all("SELECT u.*,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.server_id=? ORDER BY m.joined_at", [serverId]);
    return Promise.all(rows.map(async (u) => ({ user: { ...publicUser(u), tags: (await this.db.all("SELECT t.* FROM tags t JOIN user_tags ut ON ut.tag_id=t.id WHERE ut.user_id=? AND t.server_id=?", [u.id, serverId])).map((t) => ({ id: t.id, serverId: t.server_id, name: t.name, color: t.color })) }, role: u.role, customRoles: await this.assignedRoles(this.db, u.id, serverId) })));
  }
  async changeMember(actorId, requestId2, serverId, targetId, body) {
    const result = await this.mutate(actorId, requestId2, "member.change", { serverId, targetId, ...body }, async (tx) => {
      const actor = await this.member(tx, actorId, serverId, "manageMembers"), target = await this.member(tx, targetId, serverId);
      if (body.role && body.role !== "member" && (await tx.one("SELECT guest FROM users WHERE id=?", [targetId]))?.guest) fail(403, "GUEST_ROLE", "Register the guest before granting an administrative role.");
      if (!actor.globalAdmin && (await tx.one("SELECT instance_admin FROM users WHERE id=?", [targetId]))?.instance_admin || !canManage(await this.authority(tx, actor), await this.authority(tx, target)) || body.role && (!canManage(await this.authority(tx, actor), body.role) || body.role === "owner")) fail(403, "HIERARCHY", "You cannot manage this role.");
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
      await audit(tx, actorId, "member.change", targetId, { serverId, ...body });
      return { success: true };
    });
    await this.notify("state:changed", {});
    await this.notify("voice:changed", {});
    return result;
  }
  async leaveServer(userId, rid, serverId) {
    const result = await this.mutate(userId, rid, "server.leave", { serverId }, async (tx) => {
      const server = await tx.one("SELECT owner_id FROM servers WHERE id=?", [serverId]);
      if (server?.owner_id === userId) fail(403, "OWNER_LEAVE", "Owners must delete their server before leaving.");
      if (!await tx.one("SELECT user_id FROM members WHERE server_id=? AND user_id=?", [serverId, userId])) fail(404, "NOT_FOUND", "You are not a member of this server.");
      await tx.run("DELETE FROM voice_members WHERE user_id=? AND channel_id IN (SELECT id FROM channels WHERE server_id=?)", [userId, serverId]);
      await tx.run("DELETE FROM user_tags WHERE user_id=? AND tag_id IN (SELECT id FROM tags WHERE server_id=?)", [userId, serverId]);
      await tx.run("DELETE FROM members WHERE server_id=? AND user_id=?", [serverId, userId]);
      await audit(tx, userId, "server.leave", serverId);
      return { success: true };
    });
    await this.notify("state:changed", {});
    await this.notify("voice:changed", {});
    return result;
  }
  async allowDirectMessage(tx, userId, otherId) {
    if (await tx.one("SELECT user_id FROM user_blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)", [userId, otherId, otherId, userId])) fail(403, "DM_BLOCKED", "Direct messaging is blocked between these accounts.");
  }
  async closeDirectMessage(userId, rid, conversationId) {
    const result = await this.mutate(userId, rid, "dm.close", { conversationId }, async (tx) => {
      const cv = await this.conversation(tx, userId, conversationId);
      if (cv.kind !== "dm") fail(400, "NOT_DM", "Only a direct chat can be closed.");
      await tx.run("UPDATE dm_members SET hidden=1 WHERE conversation_id=? AND user_id=?", [conversationId, userId]);
      await tx.run("INSERT INTO read_cursors(conversation_id,user_id,sequence) VALUES(?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET sequence=excluded.sequence", [conversationId, userId, cv.sequence]);
      return { success: true };
    });
    await this.notify("state:changed", {});
    return result;
  }
  async blockUser(userId, rid, targetId, blocked) {
    const result = await this.mutate(userId, rid, "user.block", { targetId, blocked }, async (tx) => {
      if (targetId === userId) fail(400, "SELF_BLOCK", "You cannot block yourself.");
      if (!await tx.one("SELECT id FROM users WHERE id=?", [targetId])) fail(404, "NOT_FOUND", "Account not found.");
      if (blocked) await tx.run("INSERT INTO user_blocks(user_id,blocked_id) VALUES(?,?) ON CONFLICT DO NOTHING", [userId, targetId]);
      else await tx.run("DELETE FROM user_blocks WHERE user_id=? AND blocked_id=?", [userId, targetId]);
      return { success: true };
    });
    await this.notify("state:changed", {});
    return result;
  }
  async dm(userId, requestId2, otherId) {
    return this.mutate(userId, requestId2, "dm.create", { otherId }, async (tx) => {
      if (otherId === userId || !await tx.one("SELECT id FROM users WHERE id=?", [otherId])) fail(400, "INVALID_USER", "Select another registered user.");
      await this.allowDirectMessage(tx, userId, otherId);
      const guests = await tx.one("SELECT COUNT(*) AS count FROM users WHERE id IN (?,?) AND guest=1", [userId, otherId]);
      if (guests.count && !await tx.one("SELECT a.server_id FROM members a JOIN members b ON a.server_id=b.server_id JOIN servers s ON s.id=a.server_id WHERE a.user_id=? AND b.user_id=? AND s.allow_guests=1", [userId, otherId])) fail(403, "GUEST_DM", "Guests can message only people in a shared guest-enabled server.");
      const pair = [userId, otherId].sort().join(":");
      const old = await tx.one("SELECT conversation_id FROM dm_pairs WHERE pair_key=?", [pair]);
      if (old) {
        await tx.run("UPDATE dm_members SET hidden=0 WHERE conversation_id=? AND user_id=?", [old.conversation_id, userId]);
        return { id: old.conversation_id };
      }
      const cv = randomUUID();
      await tx.run("INSERT INTO conversations(id,kind,created_at) VALUES(?,?,?)", [cv, "dm", Date.now()]);
      for (const u of [userId, otherId]) await tx.run("INSERT INTO dm_members(conversation_id,user_id) VALUES(?,?)", [cv, u]);
      await tx.run("INSERT INTO dm_pairs(pair_key,conversation_id) VALUES(?,?)", [pair, cv]);
      return { id: cv };
    });
  }
  async messageView(tx, messageId) {
    const m = await tx.one("SELECT m.*,u.username,u.display_name,u.bio,u.avatar,u.status,u.instance_admin,u.guest,u.language FROM messages m JOIN users u ON m.user_id=u.id WHERE m.id=?", [messageId]);
    if (!m) fail(404, "NOT_FOUND", "Message not found.");
    const reactions = {};
    for (const r of await tx.all("SELECT emoji,user_id FROM reactions WHERE message_id=?", [messageId])) (reactions[r.emoji] ||= []).push(r.user_id);
    return { id: m.id, conversationId: m.conversation_id, sequence: Number(m.sequence), author: publicUser({ ...m, id: m.user_id }), content: m.deleted ? "" : m.content, replyTo: m.reply_to, createdAt: Number(m.created_at), editedAt: m.edited_at ? Number(m.edited_at) : null, deleted: Boolean(m.deleted), reactions: Object.entries(reactions).map(([emoji, userIds]) => ({ emoji, userIds })), attachments: m.deleted ? [] : (await tx.all("SELECT * FROM attachments WHERE message_id=?", [messageId])).map((a) => ({ id: a.id, name: a.name, size: Number(a.size), expiresAt: Number(a.expires_at), available: a.state === "ready" && Number(a.expires_at) > Date.now() })) };
  }
  async event(tx, conversationId, kind, payload) {
    await tx.run("UPDATE conversations SET sequence=sequence+1 WHERE id=?", [conversationId]);
    const cv = await tx.one("SELECT sequence,kind FROM conversations WHERE id=?", [conversationId]);
    const event = { conversationId, sequence: Number(cv.sequence), kind, payload, direct: cv.kind === "dm" };
    if ((await tx.one("SELECT COUNT(*) AS count FROM events")).count >= 5e4) await tx.run("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY created_at LIMIT 200)");
    await tx.run("INSERT INTO events(id,conversation_id,sequence,kind,payload,created_at) VALUES(?,?,?,?,?,?)", [randomUUID(), conversationId, event.sequence, kind, JSON.stringify(payload), Date.now()]);
    return event;
  }
  async send(userId, requestId2, conversationId, content, replyTo, attachmentIds = []) {
    let reopened = false;
    const event = await this.mutate(userId, requestId2, "message.send", { conversationId, content, replyTo, attachmentIds }, async (tx) => {
      const cv = await this.conversation(tx, userId, conversationId, true);
      const account = await tx.one("SELECT guest FROM users WHERE id=?", [userId]);
      if (account.guest && (await tx.one("SELECT COUNT(*) AS count FROM messages WHERE user_id=? AND created_at>?", [userId, Date.now() - 6e4])).count >= 20) fail(429, "GUEST_RATE", "Guests may send at most 20 messages per minute.");
      if (account.guest && attachmentIds.length) fail(403, "GUEST_UPLOAD", "Guests cannot upload files.");
      for (const a of attachmentIds) if (!await tx.one("SELECT id FROM attachments WHERE id=? AND user_id=? AND conversation_id=? AND state='ready' AND message_id IS NULL AND expires_at>?", [a, userId, conversationId, Date.now()])) fail(400, "ATTACHMENT_INVALID", "An attachment is unavailable or belongs to another conversation.");
      if (replyTo && !await tx.one("SELECT id FROM messages WHERE id=? AND conversation_id=?", [replyTo, conversationId])) fail(400, "INVALID_REPLY", "Reply target is unavailable.");
      if ((await tx.one("SELECT COUNT(*) AS count FROM messages")).count >= this.c.maxMessages) {
        await tx.run("DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY created_at LIMIT 200)");
      }
      const messageId = randomUUID();
      await tx.run("INSERT INTO messages(id,conversation_id,sequence,user_id,content,reply_to,created_at) VALUES(?,?,?,?,?,?,?)", [messageId, conversationId, Number(cv.sequence) + 1, userId, content, replyTo || null, Date.now()]);
      for (const a of attachmentIds) await tx.run("UPDATE attachments SET message_id=? WHERE id=?", [messageId, a]);
      if (cv.kind === "dm") {
        reopened = Boolean(await tx.one("SELECT user_id FROM dm_members WHERE conversation_id=? AND hidden=1", [conversationId]));
        await tx.run("UPDATE dm_members SET hidden=0 WHERE conversation_id=?", [conversationId]);
      }
      return this.event(tx, conversationId, "message", await this.messageView(tx, messageId));
    });
    if (reopened) await this.notify("state:changed", {});
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
        if (body.delete) {
          await tx.run("DELETE FROM reactions WHERE message_id=?", [messageId]);
          await tx.run("UPDATE attachments SET state='unavailable' WHERE message_id=?", [messageId]);
        }
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
  async expireVoice(tx, now) {
    await tx.run("DELETE FROM voice_members WHERE heartbeat<?", [now - 3e4]);
    await reconcileShares(tx, this.c);
  }
  async maintainRoom(tx, channelId, sweep = true) {
    const now = Date.now();
    if (sweep) await this.expireVoice(tx, now);
    const current = await tx.one("SELECT * FROM coordinators WHERE channel_id=?", [channelId]);
    const valid = current?.user_id && await tx.one("SELECT user_id,heartbeat FROM voice_members WHERE channel_id=? AND user_id=? AND eligible=1 AND heartbeat>=?", [channelId, current.user_id, now - 15e3]);
    const chosen = valid || await tx.one("SELECT user_id,heartbeat FROM voice_members WHERE channel_id=? AND eligible=1 AND heartbeat>=? ORDER BY joined_at,user_id LIMIT 1", [channelId, now - 15e3]);
    if (!current && !chosen) return;
    const changed = (current?.user_id || null) !== (chosen?.user_id || null) || current && current.expires_at < now && chosen;
    const epoch = Number(current?.epoch || 0) + (changed || !current ? 1 : 0);
    if (current && current.user_id === (chosen?.user_id || null) && Number(current.epoch) === epoch && Number(current.expires_at) === (chosen ? Number(chosen.heartbeat) + 15e3 : 0)) return;
    await tx.run("INSERT INTO coordinators(channel_id,user_id,epoch,expires_at) VALUES(?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET user_id=excluded.user_id,epoch=excluded.epoch,expires_at=excluded.expires_at", [channelId, chosen?.user_id || null, epoch, chosen ? Number(chosen.heartbeat) + 15e3 : 0]);
  }
  async voiceDirectory(userId, tx = this.db, now = Date.now()) {
    const rooms = [];
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
  async voiceSnapshot(viewers) {
    return this.db.transaction(async (connection) => {
      await reconcileShares(connection, this.c);
      const tx = readSnapshot(connection), rooms = /* @__PURE__ */ new Map(), now = Date.now();
      const result = [];
      for (const viewer of viewers) {
        const directory = await this.voiceDirectory(viewer.userId, tx, now);
        let room;
        if (viewer.channelId) {
          const vm = await tx.one("SELECT channel_id FROM voice_members WHERE user_id=? AND socket_id=?", [viewer.userId, viewer.socketId]);
          room = null;
          if (vm) try {
            await this.channel(tx, viewer.userId, vm.channel_id);
            if (!rooms.has(vm.channel_id)) rooms.set(vm.channel_id, await this.roomView(tx, vm.channel_id));
            room = rooms.get(vm.channel_id);
          } catch {
          }
        }
        result.push({ socketId: viewer.socketId, directory, room });
      }
      return result;
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
      members.push({ user: publicUser({ ...vm, id: vm.user_id }), muted: Boolean(vm.muted), deafened: Boolean(vm.deafened), serverMuted: Boolean(vm.server_muted), serverDeafened: Boolean(vm.server_deafened), canShare, epoch: vm.epoch, eligible: Boolean(vm.eligible), joinedAt: Number(vm.joined_at) });
    }
    const shares = (await tx.all("SELECT * FROM share_leases WHERE channel_id=? AND expires_at>=? ORDER BY started_at,id", [channelId, Date.now()])).map((s) => shareView(s, this.c));
    const coordinator = await tx.one("SELECT * FROM coordinators WHERE channel_id=?", [channelId]);
    return { channelId, members, shares, coordinatorId: coordinator?.user_id || null, coordinatorEpoch: Number(coordinator?.epoch || 0), transport: this.c.mediaTransport };
  }
  async joinVoice(userId, socketId, channelId, eligible) {
    const access = await this.channel(this.db, userId, channelId);
    if (access.kind !== "voice") fail(400, "NOT_VOICE", "Select a voice channel.");
    const iceServers = this.c.mediaTransport === "mesh" && this.cloudflareTurn ? await this.cloudflareTurn.forUser(userId) : this.iceServers(userId);
    const result = await this.db.transaction(async (tx) => {
      const ch = await this.channel(tx, userId, channelId);
      if (ch.kind !== "voice") fail(400, "NOT_VOICE", "Select a voice channel.");
      await this.maintainRoom(tx, channelId);
      const previous = await tx.one("SELECT * FROM voice_members WHERE user_id=?", [userId]);
      if (previous && previous.socket_id === socketId && previous.channel_id === channelId) return { epoch: previous.epoch, room: await this.roomView(tx, channelId) };
      const count = await tx.one("SELECT COUNT(*) AS count FROM voice_members WHERE channel_id=? AND user_id<>?", [channelId, userId]);
      if (ch.locked && !["owner", "administrator"].includes(ch.role)) fail(403, "VOICE_LOCKED", "This voice channel is locked.");
      if (count.count >= Math.min(ch.user_limit, this.c.maxVoice)) fail(409, "ROOM_FULL", "Voice channel is full.");
      await tx.run("DELETE FROM voice_members WHERE user_id=?", [userId]);
      const epoch = randomUUID(), now = Date.now();
      const restriction = await tx.one("SELECT * FROM voice_restrictions WHERE channel_id=? AND user_id=?", [channelId, userId]);
      await tx.run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,server_muted,server_deafened,eligible,heartbeat,joined_at) VALUES(?,?,?,?,?,?,?,?,?)", [userId, channelId, socketId, epoch, ch.permissions.speak && !restriction?.muted ? 0 : 1, restriction?.deafened || 0, eligible ? 1 : 0, now, now]);
      if (previous && previous.channel_id !== channelId) await this.maintainRoom(tx, previous.channel_id);
      await this.maintainRoom(tx, channelId);
      return { epoch, room: await this.roomView(tx, channelId) };
    });
    await this.notify("voice:changed", {});
    return { ...result, iceServers, ...this.cloudflareTurn ? { iceServersExpiresAt: Date.now() + (cloudflareTurnTtl - 60) * 1e3 } : {} };
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
    let changed = action === "leave", removed = false;
    const result = await this.db.transaction(async (tx) => {
      const vm = await tx.one("SELECT * FROM voice_members WHERE user_id=? AND socket_id=?", [userId, socketId]);
      if (!vm) fail(409, "NOT_IN_VOICE", "Voice session is no longer active.");
      if (action === "leave") await tx.run("DELETE FROM voice_members WHERE user_id=?", [userId]);
      else {
        try {
          await this.channel(tx, userId, vm.channel_id);
        } catch {
          await tx.run("DELETE FROM voice_members WHERE user_id=?", [userId]);
          removed = true;
          return { removed: true };
        }
        changed = body.muted !== void 0 && Number(body.muted) !== vm.muted || body.deafened !== void 0 && Number(body.deafened) !== vm.deafened || body.eligible !== void 0 && Number(body.eligible) !== vm.eligible;
        await tx.run("UPDATE voice_members SET heartbeat=?,muted=?,deafened=?,eligible=? WHERE user_id=?", [Date.now(), body.muted === void 0 ? vm.muted : Number(body.muted), body.deafened === void 0 ? vm.deafened : Number(body.deafened), body.eligible === void 0 ? vm.eligible : Number(body.eligible), userId]);
        await tx.run("UPDATE share_leases SET expires_at=? WHERE user_id=? AND expires_at>=?", [Date.now() + 3e4, userId, Date.now()]);
      }
      await this.maintainRoom(tx, vm.channel_id, this.c.mediaTransport !== "livekit" || action === "leave");
      if (action !== "leave" && this.c.mediaTransport === "livekit") return { alive: true };
      return { room: await this.roomView(tx, vm.channel_id) };
    });
    if (removed || action === "leave") await this.notify("voice:changed", {});
    else if (action === "state" && changed) await this.notify("voice:state:changed", {});
    return result;
  }
  async share(userId, socketId, requestId2, stop = false, includeAudio = false) {
    const result = await this.mutate(userId, requestId2, stop ? "share.stop" : "share.start", { includeAudio: stop ? false : includeAudio }, async (tx) => {
      const vm = await tx.one("SELECT * FROM voice_members WHERE user_id=? AND socket_id=?", [userId, socketId]);
      if (!vm) fail(409, "NOT_IN_VOICE", "Join voice before sharing.");
      if (stop) {
        await tx.run("DELETE FROM share_leases WHERE user_id=?", [userId]);
        await reconcileShares(tx, this.c);
        return { lease: null };
      }
      await this.channel(tx, userId, vm.channel_id, "share");
      await this.maintainRoom(tx, vm.channel_id);
      const old = await tx.one("SELECT * FROM share_leases WHERE user_id=?", [userId]);
      if (old) return { lease: shareView(old, this.c) };
      const global = await tx.one("SELECT COUNT(*) AS count FROM share_leases"), room = await tx.one("SELECT COUNT(*) AS count FROM share_leases WHERE channel_id=?", [vm.channel_id]);
      if (this.c.globalShares > 0 && global.count >= this.c.globalShares || this.c.roomShares > 0 && room.count >= this.c.roomShares) fail(409, "SHARE_LIMIT", "Screen-sharing capacity is full.");
      const standard = await tx.one("SELECT COUNT(*) AS count FROM share_leases WHERE tier='standard'");
      const tier = Number(standard.count) < this.c.standardShareSlots ? "standard" : "fallback";
      if (tier === "fallback" && Number(room.count) > 0) fail(409, "SHARE_LIMIT", "All three 30fps slots are occupied. This room already has a screen.");
      const now = Date.now(), leaseId = randomUUID();
      await tx.run("INSERT INTO share_leases(id,user_id,channel_id,expires_at,tier,started_at,requested_fps,include_audio,policy_revision) VALUES(?,?,?,?,?,?,15,?,1)", [leaseId, userId, vm.channel_id, now + 3e4, tier, now, Number(includeAudio)]);
      return { lease: shareView(await tx.one("SELECT * FROM share_leases WHERE id=?", [leaseId]), this.c) };
    });
    await this.notify("voice:changed", {});
    return result;
  }
  async updateShare(userId, socketId, requestId2, body) {
    const result = await this.mutate(userId, requestId2, "share.update", body, async (tx) => {
      await reconcileShares(tx, this.c);
      const row = await tx.one("SELECT s.* FROM share_leases s JOIN voice_members v ON v.user_id=s.user_id WHERE s.id=? AND s.user_id=? AND v.socket_id=? AND s.expires_at>=?", [body.leaseId, userId, socketId, Date.now()]);
      if (!row) fail(409, "SHARE_EXPIRED", "Screen sharing has stopped.");
      await this.channel(tx, userId, row.channel_id, "share");
      if (Number(row.policy_revision) !== body.expectedRevision) fail(409, "STALE_SHARE", "Sharing limits changed. Try again.");
      if (body.frameRate && body.frameRate > shareView(row, this.c).maxFrameRate) fail(409, "SHARE_TIER", "30fps is not available for this share yet.");
      await tx.run("UPDATE share_leases SET requested_fps=?,include_audio=?,policy_revision=policy_revision+1 WHERE id=?", [body.frameRate ?? row.requested_fps, body.includeAudio === false ? 0 : row.include_audio, row.id]);
      return { lease: shareView(await tx.one("SELECT * FROM share_leases WHERE id=?", [row.id]), this.c) };
    });
    await this.notify("voice:changed", {});
    return result;
  }
  async moderate(userId, requestId2, channelId, targetId, action) {
    const result = await this.mutate(userId, requestId2, "voice.moderate", { channelId, targetId, action }, async (tx) => {
      const ch = await this.channel(tx, userId, channelId, "moderate"), target = await this.member(tx, targetId, ch.server_id);
      const actor = await tx.one("SELECT instance_admin FROM users WHERE id=?", [userId]), targetAccount = await tx.one("SELECT instance_admin FROM users WHERE id=?", [targetId]);
      if (!actor.instance_admin && (targetAccount.instance_admin || userId !== targetId && !canManage(await this.authority(tx, { role: ch.role, user_id: userId, server_id: ch.server_id }), await this.authority(tx, target)))) fail(403, "HIERARCHY", "Cannot moderate this member.");
      if (!await tx.one("SELECT user_id FROM voice_members WHERE channel_id=? AND user_id=?", [channelId, targetId])) fail(409, "NOT_IN_VOICE", "The participant has left this channel.");
      if (["mute", "unmute", "deafen", "undeafen", "denyShare", "allowShare"].includes(action)) {
        await tx.run("INSERT INTO voice_restrictions(channel_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING", [channelId, targetId]);
        if (action === "mute" || action === "unmute") await tx.run("UPDATE voice_restrictions SET muted=? WHERE channel_id=? AND user_id=?", [Number(action === "mute"), channelId, targetId]);
        if (action === "deafen" || action === "undeafen") await tx.run("UPDATE voice_restrictions SET deafened=? WHERE channel_id=? AND user_id=?", [Number(action === "deafen"), channelId, targetId]);
        if (action === "denyShare" || action === "allowShare") await tx.run("UPDATE voice_restrictions SET sharing_allowed=? WHERE channel_id=? AND user_id=?", [Number(action === "allowShare"), channelId, targetId]);
      }
      if (action === "kick") await tx.run("DELETE FROM voice_members WHERE channel_id=? AND user_id=?", [channelId, targetId]);
      if (action === "stopShare") await tx.run("DELETE FROM share_leases WHERE channel_id=? AND user_id=?", [channelId, targetId]);
      if (action === "denyShare") await tx.run("DELETE FROM share_leases WHERE channel_id=? AND user_id=?", [channelId, targetId]);
      if (action === "mute" || action === "unmute") {
        if (action === "unmute") await this.channel(tx, targetId, channelId, "speak");
        await tx.run("UPDATE voice_members SET server_muted=? WHERE channel_id=? AND user_id=?", [action === "mute" ? 1 : 0, channelId, targetId]);
      }
      if (action === "deafen" || action === "undeafen") await tx.run("UPDATE voice_members SET server_deafened=? WHERE channel_id=? AND user_id=?", [Number(action === "deafen"), channelId, targetId]);
      await audit(tx, userId, `voice.${action}`, targetId, { channelId });
      await this.maintainRoom(tx, channelId);
      return { success: true };
    });
    await this.notify("voice:changed", {});
    return result;
  }
  async revalidateVoice(tx, serverId) {
    for (const vm of await tx.all("SELECT v.* FROM voice_members v JOIN channels c ON c.id=v.channel_id WHERE c.server_id=?", [serverId])) {
      try {
        const access = await this.channel(tx, vm.user_id, vm.channel_id);
        const restriction = await tx.one("SELECT muted FROM voice_restrictions WHERE channel_id=? AND user_id=?", [vm.channel_id, vm.user_id]);
        await tx.run("UPDATE voice_members SET server_muted=? WHERE user_id=?", [Number(!access.permissions.speak || Boolean(restriction?.muted)), vm.user_id]);
        if (!access.permissions.share) await tx.run("DELETE FROM share_leases WHERE user_id=?", [vm.user_id]);
      } catch {
        await tx.run("DELETE FROM voice_members WHERE user_id=?", [vm.user_id]);
      }
    }
  }
  async voicePolicy(actorId, rid, channelId, body) {
    const result = await this.mutate(actorId, rid, "voice.policy", { channelId, ...body }, async (tx) => {
      const ch = await this.channel(tx, actorId, channelId, "manageChannels");
      if (ch.kind !== "voice") fail(400, "NOT_VOICE", "Select a voice channel.");
      for (const tag of body.requiredTags) if (!await tx.one("SELECT id FROM tags WHERE id=? AND server_id=?", [tag, ch.server_id])) fail(400, "INVALID_TAG", "Tags must belong to this server.");
      await tx.run("UPDATE channels SET locked=?,user_limit=?,tag_mode=? WHERE id=?", [Number(body.locked), Math.min(body.userLimit, this.c.maxVoice), body.tagMode, channelId]);
      await tx.run("DELETE FROM channel_tags WHERE channel_id=?", [channelId]);
      for (const tag of new Set(body.requiredTags)) await tx.run("INSERT INTO channel_tags(channel_id,tag_id) VALUES(?,?)", [channelId, tag]);
      await this.revalidateVoice(tx, ch.server_id);
      await audit(tx, actorId, "voice.policy", channelId, body);
      return { success: true };
    });
    await this.notify("state:changed", {});
    await this.notify("voice:changed", {});
    return result;
  }
  async tags(userId, serverId) {
    await this.member(this.db, userId, serverId);
    return (await this.db.all("SELECT * FROM tags WHERE server_id=? ORDER BY name", [serverId])).map((t) => ({ id: t.id, serverId: t.server_id, name: t.name, color: t.color }));
  }
  async changeTag(actorId, rid, serverId, body) {
    const result = await this.mutate(actorId, rid, "tag.change", { serverId, ...body }, async (tx) => {
      const actor = await this.member(tx, actorId, serverId, "manageChannels");
      if (body.tagId && !await tx.one("SELECT id FROM tags WHERE id=? AND server_id=?", [body.tagId, serverId])) fail(404, "NOT_FOUND", "Tag not found.");
      const tagId = body.tagId || randomUUID();
      if (body.userId) {
        const target = await this.member(tx, body.userId, serverId);
        if (actorId !== body.userId && !actor.globalAdmin && !canManage(actor.role, target.role)) fail(403, "HIERARCHY", "Cannot assign tags to this role.");
        if (!body.tagId) fail(400, "INVALID_TAG", "Choose a tag.");
        if (body.assigned) await tx.run("INSERT INTO user_tags(user_id,tag_id) VALUES(?,?) ON CONFLICT DO NOTHING", [body.userId, tagId]);
        else await tx.run("DELETE FROM user_tags WHERE user_id=? AND tag_id=?", [body.userId, tagId]);
      } else if (body.delete) await tx.run("DELETE FROM tags WHERE id=?", [tagId]);
      else if (!body.tagId) {
        if ((await tx.one("SELECT COUNT(*) AS count FROM tags WHERE server_id=?", [serverId])).count >= 32) fail(409, "LIMIT", "This server has reached its tag limit.");
        if (!body.name) fail(400, "VALIDATION", "Enter a tag name.");
        await tx.run("INSERT INTO tags(id,server_id,name,color) VALUES(?,?,?,?)", [tagId, serverId, body.name, body.color || "#a99bff"]);
      } else {
        if (body.name) await tx.run("UPDATE tags SET name=? WHERE id=?", [body.name, tagId]);
        if (body.color) await tx.run("UPDATE tags SET color=? WHERE id=?", [body.color, tagId]);
      }
      await this.revalidateVoice(tx, serverId);
      await audit(tx, actorId, "tag.change", tagId, { serverId, userId: body.userId, assigned: body.assigned, delete: body.delete });
      return { id: tagId };
    });
    await this.notify("state:changed", {});
    await this.notify("voice:changed", {});
    return result;
  }
  async moveVoice(actorId, rid, fromChannel, targetId, toChannel) {
    const result = await this.mutate(actorId, rid, "voice.move", { fromChannel, targetId, toChannel }, async (tx) => {
      const from = await this.channel(tx, actorId, fromChannel, "moderate"), to = await this.channel(tx, actorId, toChannel, "moderate");
      const target = await this.member(tx, targetId, from.server_id), actor = await tx.one("SELECT instance_admin FROM users WHERE id=?", [actorId]);
      if (from.server_id !== to.server_id || to.kind !== "voice" || fromChannel === toChannel) fail(400, "INVALID_MOVE", "Choose another voice channel in this server.");
      if (!actor.instance_admin && ((await tx.one("SELECT instance_admin FROM users WHERE id=?", [targetId])).instance_admin || !canManage(await this.authority(tx, { role: from.role, user_id: actorId, server_id: from.server_id }), await this.authority(tx, target)))) fail(403, "HIERARCHY", "Cannot move this member.");
      const access = await this.channel(tx, targetId, toChannel);
      if (access.locked && !["owner", "administrator"].includes(access.role)) fail(403, "VOICE_LOCKED", "The destination is locked.");
      await this.maintainRoom(tx, toChannel);
      if ((await tx.one("SELECT COUNT(*) AS count FROM voice_members WHERE channel_id=?", [toChannel])).count >= Math.min(access.user_limit, this.c.maxVoice)) fail(409, "ROOM_FULL", "The destination is full.");
      const vm = await tx.one("SELECT * FROM voice_members WHERE user_id=? AND channel_id=?", [targetId, fromChannel]);
      if (!vm) fail(409, "NOT_IN_VOICE", "The participant has left this channel.");
      await tx.run("DELETE FROM voice_members WHERE user_id=?", [targetId]);
      await audit(tx, actorId, "voice.move", targetId, { fromChannel, toChannel });
      return { socketId: vm.socket_id, channelId: toChannel };
    });
    await this.notify("voice:move", result);
    await this.notify("voice:changed", {});
    return { success: true };
  }
  async cleanup() {
    await this.db.transaction(async (tx) => {
      const now = Date.now();
      await tx.run("DELETE FROM recovery_attempts WHERE expires_at<?", [now]);
      await tx.run("DELETE FROM sessions WHERE expires_at<?", [now]);
      await tx.run("DELETE FROM used_refresh WHERE expires_at<?", [now]);
      await tx.run("DELETE FROM invites WHERE expires_at<? OR remaining<1", [now]);
      await tx.run("DELETE FROM mutations WHERE created_at<?", [now - 864e5]);
      await tx.run("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE created_at<? ORDER BY created_at LIMIT 1000)", [now - 7 * 864e5]);
      await tx.run("DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE created_at<? ORDER BY created_at LIMIT 500)", [now - this.c.retentionDays * 864e5]);
      await this.expireVoice(tx, now);
      for (const ch of await tx.all("SELECT channel_id AS id FROM voice_members UNION SELECT channel_id AS id FROM coordinators WHERE user_id IS NOT NULL")) await this.maintainRoom(tx, ch.id, false);
    });
  }
};
var schemas = {
  name: z3.string().trim().min(1).max(64),
  profile: z3.object({ displayName: z3.string().trim().min(1).max(48), bio: z3.string().max(500), status: z3.enum(["online", "idle", "busy"]), language: z3.enum(["en-US", "fa-IR"]).optional(), requestId }),
  channel: z3.object({ name: z3.string().trim().min(1).max(64), kind: z3.enum(["text", "voice"]), requestId }),
  role: z3.enum(["owner", "administrator", "moderator", "member"]),
  permissions: z3.object({ view: z3.boolean().optional(), write: z3.boolean().optional(), speak: z3.boolean().optional(), share: z3.boolean().optional(), manageChannels: z3.boolean().optional(), manageMembers: z3.boolean().optional(), moderate: z3.boolean().optional(), createInvites: z3.boolean().optional() }).strict()
};

// apps/api/src/accounts.ts
async function initialRecoveryCodes(tx, userId) {
  const codes = Array.from({ length: 8 }, () => token().slice(0, 24));
  for (const code of codes) await tx.run("INSERT INTO recovery_codes(user_id,code_hash,created_at) VALUES(?,?,?)", [userId, hash(code), Date.now()]);
  return codes;
}
var normalizeAnswer = (answer) => answer.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
async function audit(tx, actor, action, target, details = {}) {
  await tx.run("INSERT INTO audit_log(id,actor_id,action,target_id,details,created_at) VALUES(?,?,?,?,?,?)", [randomUUID2(), actor, action, target, JSON.stringify(details), Date.now()]);
  await tx.run("DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log ORDER BY created_at DESC LIMIT 500 OFFSET 10000)");
}
async function administrator(tx, userId) {
  const user = await tx.one("SELECT * FROM users WHERE id=? AND banned=0 AND guest=0", [userId]);
  if (!user?.instance_admin) fail(403, "FORBIDDEN", "Global administration is required.");
  return user;
}
async function verifyCurrent(user, password) {
  if (user.guest || !await passwordVerify(user.password_hash, password)) fail(401, "INVALID_CREDENTIALS", "Current password is incorrect.");
}
function publicAccountRoutes(app, service, authRate, sessionFor, disconnect) {
  const { db, c } = service;
  app.post("/api/v1/auth/guest", { config: authRate }, async (req, reply) => {
    const b = z4.object({ displayName: z4.string().trim().min(1).max(48), code: z4.string().min(10).max(100), language: z4.enum(["en-US", "fa-IR"]).optional(), requestId }).parse(req.body);
    if (!c.guestsEnabled) fail(403, "GUESTS_DISABLED", "Guest access is disabled.");
    const userId = await db.transaction(async (tx) => {
      const fingerprint = hash(JSON.stringify({ code: b.code, displayName: b.displayName }));
      const previous = await tx.one("SELECT m.user_id,m.fingerprint,m.response,u.guest FROM mutations m JOIN users u ON u.id=m.user_id WHERE m.request_id=? AND m.operation='guest.create'", [b.requestId]);
      if (previous) {
        if (!previous.guest) fail(409, "NOT_GUEST", "This account is already registered.");
        if (previous.fingerprint !== fingerprint) fail(409, "IDEMPOTENCY_CONFLICT", "Request identifier was already used with different input.");
        return { userId: previous.user_id, ...JSON.parse(previous.response || "{}") };
      }
      const inv = await tx.one("SELECT i.*,s.allow_guests FROM invites i JOIN servers s ON s.id=i.server_id WHERE i.hash=? AND i.expires_at>=? AND i.remaining>0", [hash(b.code), Date.now()]);
      if (!inv?.allow_guests) fail(403, "GUEST_INVITE_REQUIRED", "A valid invitation to a guest-enabled server is required.");
      if (Number((await tx.one("SELECT COUNT(*) AS count FROM users")).count) >= c.maxUsers) fail(409, "ACCOUNT_LIMIT", "This instance has reached its account limit.");
      if (Number((await tx.one("SELECT COUNT(*) AS count FROM users WHERE guest=1")).count) >= c.maxGuests) fail(409, "GUEST_LIMIT", "Guest capacity has been reached.");
      const uid = randomUUID2(), now = Date.now();
      await tx.run("INSERT INTO users(id,username,display_name,password_hash,guest,created_at,language) VALUES(?,?,?,?,1,?,?)", [uid, `guest_${uid.replaceAll("-", "").slice(0, 20)}`, b.displayName, "!guest-no-password", now, b.language || ""]);
      await tx.run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)", [inv.server_id, uid, "member", now]);
      await tx.run("UPDATE invites SET remaining=remaining-1 WHERE hash=?", [hash(b.code)]);
      await tx.run("INSERT INTO mutations(user_id,request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)", [uid, b.requestId, "guest.create", fingerprint, JSON.stringify({ serverId: inv.server_id, channelId: inv.channel_id }), now]);
      await audit(tx, uid, "guest.create", inv.server_id);
      return { userId: uid, serverId: inv.server_id, channelId: inv.channel_id };
    });
    await service.notify("state:changed", {});
    return reply.code(201).send({ ...await sessionFor(userId.userId, req.headers["x-dorham-native"] === "1", reply, String(req.headers["user-agent"] || "Guest device")), landing: { serverId: userId.serverId, channelId: userId.channelId } });
  });
  app.post("/api/v1/auth/recover", { config: authRate }, async (req) => {
    const b = z4.object({ username: z4.string().trim().min(1).max(32), code: z4.string().max(128), password: passwordSchema, requestId }).parse(req.body);
    const subject = hash(b.username.toLowerCase());
    await db.transaction(async (tx) => {
      const old = await tx.one("SELECT * FROM recovery_attempts WHERE subject=?", [subject]);
      const attempts = old && old.expires_at > Date.now() ? Number(old.attempts) + 1 : 1;
      if (attempts > 5) fail(429, "RECOVERY_LIMIT", "Recovery is temporarily unavailable. Try later or contact the administrator.");
      await tx.run("INSERT INTO recovery_attempts(subject,attempts,expires_at) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET attempts=excluded.attempts,expires_at=excluded.expires_at", [subject, attempts, old && old.expires_at > Date.now() ? old.expires_at : Date.now() + 36e5]);
    });
    const user = await db.one("SELECT * FROM users WHERE username=? AND guest=0 AND banned=0", [b.username.toLowerCase()]);
    const codeHash = hash(b.code.trim());
    if (!user || !await db.one("SELECT code_hash FROM recovery_codes WHERE user_id=? AND code_hash=?", [user.id, codeHash])) fail(401, "RECOVERY_INVALID", "Recovery details are invalid or unavailable.");
    const encoded = await passwordHash(b.password);
    await db.transaction(async (tx) => {
      if (!await tx.one("SELECT code_hash FROM recovery_codes WHERE user_id=? AND code_hash=?", [user.id, codeHash])) fail(401, "RECOVERY_INVALID", "Recovery details are invalid or unavailable.");
      await tx.run("DELETE FROM recovery_codes WHERE user_id=? AND code_hash=?", [user.id, codeHash]);
      await tx.run("UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?", [encoded, user.id]);
      await tx.run("DELETE FROM sessions WHERE user_id=?", [user.id]);
      await tx.run("DELETE FROM voice_members WHERE user_id=?", [user.id]);
      await audit(tx, user.id, "account.recover", user.id);
    });
    await disconnect();
    await service.notify("voice:changed", {});
    return { success: true };
  });
}
function protectedAccountRoutes(api, service, disconnect) {
  const { db, c } = service;
  api.post("/auth/upgrade", async (req) => {
    const b = registerSchema.parse(req.body);
    if (!req.account.guest) fail(409, "NOT_GUEST", "This account is already registered.");
    const encoded = await passwordHash(b.password);
    const result = await service.mutate(req.account.id, b.requestId, "guest.upgrade", { username: b.username, displayName: b.displayName, password: hash(b.password) }, async (tx) => {
      if (!c.registrationOpen) fail(403, "REGISTRATION_CLOSED", "Registration is closed.");
      if (!await tx.one("SELECT id FROM users WHERE id=? AND guest=1", [req.account.id])) fail(409, "NOT_GUEST", "This account is already registered.");
      await tx.run("UPDATE users SET username=?,display_name=?,password_hash=?,guest=0 WHERE id=?", [b.username.toLowerCase(), b.displayName, encoded, req.account.id]);
      await audit(tx, req.account.id, "guest.upgrade", req.account.id);
      return { success: true };
    });
    await service.notify("state:changed", {});
    return result;
  });
  api.get("/auth/sessions", async (req) => ({ sessions: (await db.all("SELECT id,device_name,native,created_at,last_seen,expires_at FROM sessions WHERE user_id=? AND expires_at>=? ORDER BY created_at DESC", [req.account.id, Date.now()])).map((s) => ({ id: s.id, device: s.device_name, native: Boolean(s.native), createdAt: Number(s.created_at), lastSeen: Number(s.last_seen), expiresAt: Number(s.expires_at), current: s.id === req.session.id })) }));
  api.post("/auth/sessions/revoke", async (req) => {
    const b = z4.object({ sessionId: id.optional(), all: z4.boolean().default(false), requestId }).refine((b2) => b2.sessionId || b2.all).parse(req.body);
    await service.mutate(req.account.id, b.requestId, "session.revoke", b, async (tx) => {
      if (b.all) await tx.run("DELETE FROM sessions WHERE user_id=?", [req.account.id]);
      else await tx.run("DELETE FROM sessions WHERE user_id=? AND id=?", [req.account.id, b.sessionId]);
      await audit(tx, req.account.id, "session.revoke", b.all ? "all" : b.sessionId);
      return { success: true };
    });
    await disconnect();
    return { success: true };
  });
  api.post("/auth/recovery-codes", async (req) => {
    const b = z4.object({ password: z4.string().max(128), requestId }).parse(req.body);
    await verifyCurrent(req.account, b.password);
    const codes = Array.from({ length: 8 }, () => token().slice(0, 24));
    await db.transaction(async (tx) => {
      if (await tx.one("SELECT request_id FROM mutations WHERE user_id=? AND request_id=?", [req.account.id, b.requestId])) fail(409, "CODES_ALREADY_ISSUED", "Codes are shown only once. Generate a new set if needed.");
      await tx.run("DELETE FROM recovery_codes WHERE user_id=?", [req.account.id]);
      for (const code of codes) await tx.run("INSERT INTO recovery_codes(user_id,code_hash,created_at) VALUES(?,?,?)", [req.account.id, hash(code), Date.now()]);
      await tx.run("INSERT INTO mutations(user_id,request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)", [req.account.id, b.requestId, "recovery.issue", hash("issued"), '{"success":true}', Date.now()]);
      await audit(tx, req.account.id, "recovery.issue", req.account.id);
    });
    return { codes };
  });
  api.get("/auth/recovery", async (req) => ({ prompt: !req.account.guest && !req.account.recovery_prompt_seen, question: (await db.one("SELECT question FROM recovery_questions WHERE user_id=?", [req.account.id]))?.question || null, codesRemaining: Number((await db.one("SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id=?", [req.account.id])).count), questions: ["What was your favorite school subject?", "What is a memorable personal preference?", "Custom question"] }));
  api.post("/auth/recovery-acknowledge", async (req) => {
    z4.object({ requestId }).parse(req.body);
    if (req.account.guest) fail(403, "GUEST_ACCOUNT", "Register before setting up recovery.");
    await db.run("UPDATE users SET recovery_prompt_seen=1 WHERE id=?", [req.account.id]);
    return { success: true };
  });
  api.post("/auth/recovery-question", async (req) => {
    const b = z4.object({ password: z4.string().max(128), question: z4.string().trim().min(5).max(200), answer: z4.string().min(1).max(200), requestId }).parse(req.body);
    await verifyCurrent(req.account, b.password);
    const encoded = await passwordHash(normalizeAnswer(b.answer));
    return service.mutate(req.account.id, b.requestId, "recovery.question", { question: b.question, answer: hash(normalizeAnswer(b.answer)) }, async (tx) => {
      await tx.run("INSERT INTO recovery_questions(user_id,question,answer_hash) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET question=excluded.question,answer_hash=excluded.answer_hash", [req.account.id, b.question, encoded]);
      await audit(tx, req.account.id, "recovery.question", req.account.id);
      return { success: true };
    });
  });
  api.get("/admin/users", async (req) => {
    await administrator(db, req.account.id);
    return { users: (await db.all("SELECT * FROM users ORDER BY created_at LIMIT 250")).map(publicUser) };
  });
  api.get("/admin/audit", async (req) => {
    await administrator(db, req.account.id);
    const before = z4.coerce.number().int().positive().optional().parse(req.query.before);
    return { events: await db.all("SELECT * FROM audit_log WHERE created_at<? ORDER BY created_at DESC LIMIT 100", [before || Date.now() + 1]) };
  });
  api.post("/admin/users/:id", async (req) => {
    const targetId = id.parse(req.params.id), b = z4.object({ action: z4.enum(["ban", "unban", "revoke", "resetPassword"]), requestId }).parse(req.body);
    await administrator(db, req.account.id);
    const temporaryPassword = b.action === "resetPassword" ? token().slice(0, 20) : null;
    const encoded = temporaryPassword ? await passwordHash(temporaryPassword) : null;
    await db.transaction(async (tx) => {
      await administrator(tx, req.account.id);
      if (await tx.one("SELECT request_id FROM mutations WHERE user_id=? AND request_id=?", [req.account.id, b.requestId])) fail(409, "ALREADY_APPLIED", "Administrative action was already applied.");
      const target = await tx.one("SELECT * FROM users WHERE id=?", [targetId]);
      if (!target || target.instance_admin) fail(403, "PROTECTED_ACCOUNT", "The global administrator cannot be modified by this operation.");
      if (b.action === "ban" || b.action === "unban") await tx.run("UPDATE users SET banned=? WHERE id=?", [b.action === "ban" ? 1 : 0, targetId]);
      if (encoded) {
        if (target.guest) fail(400, "GUEST_ACCOUNT", "Convert the guest account before setting a password.");
        await tx.run("UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?", [encoded, targetId]);
        await tx.run("DELETE FROM recovery_codes WHERE user_id=?", [targetId]);
      }
      if (b.action !== "unban") {
        await tx.run("DELETE FROM sessions WHERE user_id=?", [targetId]);
        await tx.run("DELETE FROM voice_members WHERE user_id=?", [targetId]);
      }
      await tx.run("INSERT INTO mutations(user_id,request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)", [req.account.id, b.requestId, "admin.user", hash(JSON.stringify({ targetId, action: b.action })), '{"success":true}', Date.now()]);
      await audit(tx, req.account.id, `admin.${b.action}`, targetId);
    });
    await disconnect();
    await service.notify("voice:changed", {});
    await service.notify("state:changed", {});
    return { success: true, ...temporaryPassword ? { temporaryPassword } : {} };
  });
}

export {
  id,
  requestId,
  shareStartSchema,
  shareUpdateSchema,
  passwordSchema,
  credentialsSchema,
  registerSchema,
  messageSchema,
  signalSchema,
  AppError,
  fail,
  token,
  hash,
  equal,
  passwordHash,
  passwordVerify,
  initialRecoveryCodes,
  audit,
  publicAccountRoutes,
  protectedAccountRoutes,
  readSnapshot,
  publicUser,
  Service,
  schemas
};
//# sourceMappingURL=chunk-2GUYZ3ZR.js.map