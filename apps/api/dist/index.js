import {
  AppError,
  Service,
  audit,
  credentialsSchema,
  equal,
  fail,
  hash,
  id,
  messageSchema,
  passwordHash,
  passwordSchema,
  passwordVerify,
  protectedAccountRoutes,
  publicAccountRoutes,
  publicUser,
  readSnapshot,
  registerSchema,
  requestId,
  schemas,
  shareStartSchema,
  shareUpdateSchema,
  signalSchema,
  token
} from "./chunk-Q4STIB6F.js";
import {
  config,
  openDatabase
} from "./chunk-TVTC4KB5.js";

// apps/api/src/app.ts
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import { Server as SocketServer } from "socket.io";
import { z as z6, ZodError } from "zod";
import { randomUUID as randomUUID4 } from "crypto";
import { monitorEventLoopDelay } from "perf_hooks";
import { existsSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from "fs";
import { mkdir as mkdir2, writeFile, unlink as unlink2, readdir, stat as stat3 } from "fs/promises";
import path3 from "path";
import sharp from "sharp";

// apps/api/src/sfu.ts
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";

// apps/api/src/single-flight.ts
var SingleFlight = class {
  constructor(work) {
    this.work = work;
  }
  work;
  active = false;
  requested = 0;
  waiters = [];
  run() {
    const revision = ++this.requested;
    const result = new Promise((resolve, reject) => {
      this.waiters.push({ revision, resolve, reject });
    });
    if (!this.active) {
      this.active = true;
      void Promise.resolve().then(() => this.drain());
    }
    return result;
  }
  async drain() {
    try {
      while (this.waiters.length) {
        const revision = this.requested;
        await this.work();
        const done = this.waiters.filter((w) => w.revision <= revision);
        this.waiters = this.waiters.filter((w) => w.revision > revision);
        done.forEach((w) => w.resolve());
      }
    } catch (error) {
      const failed = this.waiters;
      this.waiters = [];
      failed.forEach((w) => w.reject(error));
    } finally {
      this.active = false;
    }
  }
};

// apps/api/src/sfu.ts
var missing = (error) => error?.code === "not_found";
var Sfu = class {
  constructor(c, service) {
    this.c = c;
    this.service = service;
    this.client = c.mediaTransport === "livekit" ? new RoomServiceClient(c.livekitApiUrl || c.livekitUrl.replace(/^ws/, "http"), c.livekitKey, c.livekitSecret) : null;
  }
  c;
  service;
  client;
  metrics = { passes: 0, permissionUpdates: 0, removals: 0 };
  synchronization = new SingleFlight(() => this.synchronizePass());
  async credentials(userId, socketId, channelId) {
    if (!this.client) fail(409, "SFU_DISABLED", "This instance uses peer-to-peer media.");
    const vm = await this.service.db.one("SELECT * FROM voice_members WHERE user_id=? AND socket_id=? AND channel_id=? AND heartbeat>=?", [userId, socketId, channelId, Date.now() - 3e4]);
    if (!vm) fail(403, "FORBIDDEN", "An active voice session is required.");
    const access = await this.service.channel(this.service.db, userId, channelId);
    const lease = await this.service.db.one("SELECT id,include_audio FROM share_leases WHERE user_id=? AND expires_at>=?", [userId, Date.now()]);
    const sources = [];
    if (access.permissions.speak && !vm.server_muted && !vm.server_deafened) sources.push(TrackSource.MICROPHONE);
    if (access.permissions.share && lease) sources.push(TrackSource.SCREEN_SHARE);
    if (access.permissions.share && lease?.include_audio) sources.push(TrackSource.SCREEN_SHARE_AUDIO);
    const jwt = new AccessToken(this.c.livekitKey, this.c.livekitSecret, { identity: `${userId}:${vm.epoch}`, ttl: 60, name: userId });
    jwt.addGrant({ roomJoin: true, room: channelId, canSubscribe: !vm.server_deafened, canPublish: sources.length > 0, canPublishSources: sources, canPublishData: false, canUpdateOwnMetadata: false });
    return { url: this.c.livekitUrl, token: await jwt.toJwt(), identity: `${userId}:${vm.epoch}` };
  }
  synchronize() {
    return this.synchronization.run();
  }
  async synchronizePass() {
    if (!this.client) return;
    this.metrics.passes++;
    const rooms = await this.client.listRooms();
    for (const room of rooms) {
      if (!await this.service.db.one("SELECT id FROM channels WHERE id=? AND kind='voice'", [room.name])) continue;
      let participants;
      try {
        participants = await this.client.listParticipants(room.name);
      } catch (e) {
        if (missing(e)) continue;
        throw e;
      }
      const changes = await this.service.db.transaction(async (connection) => {
        const tx = readSnapshot(connection), actions = [];
        for (const participant of participants) {
          const [userId, epoch] = participant.identity.split(":");
          const remove = () => {
            actions.push(async () => {
              await this.client.removeParticipant(room.name, participant.identity);
              this.metrics.removals++;
            });
          };
          const now = Date.now();
          const vm = await tx.one("SELECT * FROM voice_members WHERE user_id=? AND epoch=? AND channel_id=? AND heartbeat>=?", [userId, epoch, room.name, now - 3e4]);
          if (!vm) {
            remove();
            continue;
          }
          let ch;
          try {
            ch = await this.service.channel(tx, userId, room.name);
          } catch {
            remove();
            continue;
          }
          const lease = await tx.one("SELECT id,include_audio FROM share_leases WHERE user_id=? AND expires_at>=?", [userId, now]);
          const sources = [];
          if (ch.permissions.speak && !vm.server_muted && !vm.server_deafened) sources.push(TrackSource.MICROPHONE);
          if (ch.permissions.share && lease) sources.push(TrackSource.SCREEN_SHARE);
          if (ch.permissions.share && lease?.include_audio) sources.push(TrackSource.SCREEN_SHARE_AUDIO);
          const permission = { canSubscribe: !vm.server_deafened, canPublish: sources.length > 0, canPublishSources: sources, canPublishData: false, canUpdateMetadata: false };
          const actual = participant.permission;
          if (!actual || actual.canSubscribe !== permission.canSubscribe || actual.canPublish !== permission.canPublish || actual.canPublishData || actual.canUpdateMetadata || JSON.stringify([...actual.canPublishSources].sort()) !== JSON.stringify([...sources].sort())) {
            actions.push(async () => {
              await this.client.updateParticipant(room.name, participant.identity, { permission });
              this.metrics.permissionUpdates++;
            });
          }
        }
        return actions;
      });
      for (let i = 0; i < changes.length; i += 4) {
        const results = await Promise.allSettled(changes.slice(i, i + 4).map((change) => change()));
        const failed = results.find((r) => r.status === "rejected" && !missing(r.reason));
        if (failed?.status === "rejected") throw failed.reason;
      }
    }
  }
};

// packages/contracts/src/connection.ts
import { z } from "zod";
var connectionProbeSchema = z.object({ version: z.literal(1) }).strict();
var connectionLatenciesSchema = z.array(z.object({
  userId: z.string().min(1).max(80),
  milliseconds: z.number().int().min(0).max(5e3).nullable(),
  measuredAt: z.number().int().nonnegative().nullable()
}).strict()).max(1e3);

// apps/api/src/connection-latency.ts
var ConnectionLatencyMonitor = class {
  constructor(wallClock = Date.now, clock = () => performance.now()) {
    this.wallClock = wallClock;
    this.clock = clock;
  }
  wallClock;
  clock;
  samples = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Set();
  async probe(socket) {
    if (!socket.connected || this.pending.has(socket.id)) return;
    this.pending.add(socket.id);
    const started = this.clock();
    try {
      const reply = await socket.timeout(5e3).emitWithAck("connection:probe", { version: 1 });
      connectionProbeSchema.parse(reply);
      const milliseconds = Math.round(this.clock() - started);
      if (socket.connected && milliseconds >= 0 && milliseconds <= 5e3) {
        this.samples.set(socket.id, { userId: socket.data.userId, milliseconds, measuredAt: this.wallClock() });
      } else this.samples.delete(socket.id);
    } catch {
      this.samples.delete(socket.id);
    } finally {
      this.pending.delete(socket.id);
    }
  }
  remove(socketId) {
    this.samples.delete(socketId);
  }
  snapshot(sockets) {
    const users = /* @__PURE__ */ new Map(), now = this.wallClock();
    for (const socket of sockets) {
      if (!socket.connected) continue;
      const userId = socket.data.userId, sample = this.samples.get(socket.id);
      if (!users.has(userId)) users.set(userId, { userId, milliseconds: null, measuredAt: null });
      if (!sample || sample.measuredAt === null || now - sample.measuredAt > 45e3) continue;
      const previous = users.get(userId);
      if (previous.milliseconds === null || sample.milliseconds < previous.milliseconds) users.set(userId, sample);
    }
    return [...users.values()];
  }
};

// apps/api/src/attachment-media.ts
import { randomBytes, createHash } from "crypto";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import path from "path";
import { z as z2 } from "zod";
var uuid = z2.string().uuid();
function mediaMime(name, prefix) {
  const ext = path.extname(name).toLowerCase(), hex = prefix.toString("hex");
  if (ext === ".png" && hex.startsWith("89504e470d0a1a0a")) return "image/png";
  if ([".jpg", ".jpeg"].includes(ext) && hex.startsWith("ffd8ff")) return "image/jpeg";
  if (ext === ".gif" && /^GIF8[79]a/.test(prefix.toString("ascii"))) return "image/gif";
  if (ext === ".webp" && prefix.subarray(0, 4).toString() === "RIFF" && prefix.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (ext === ".mp4" && prefix.subarray(4, 8).toString() === "ftyp") return "video/mp4";
  if (ext === ".webm" && hex.startsWith("1a45dfa3") && prefix.includes(Buffer.from("webm"))) return "video/webm";
  return null;
}
function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !match[1] && !match[2]) throw new Error("range");
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (![start, end].every(Number.isSafeInteger) || start >= size || end < start || !match[1] && Number(match[2]) === 0) throw new Error("range");
  start = Math.max(0, start);
  return { start, end };
}
var AttachmentMedia = class {
  constructor(service, readers, file) {
    this.service = service;
    this.readers = readers;
    this.file = file;
  }
  service;
  readers;
  file;
  tickets = /* @__PURE__ */ new Map();
  checked = /* @__PURE__ */ new Map();
  resolveTicket(value, fileId) {
    if (typeof value !== "string" || value.length !== 43) return;
    const ticket = this.tickets.get(hash(value));
    if (!ticket || ticket.fileId !== fileId || ticket.expiresAt <= Date.now()) return;
    return ticket.sessionId;
  }
  async available(userId, fileId) {
    const row = await this.service.db.one("SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=? AND a.state='ready' AND a.expires_at>? AND m.deleted=0", [fileId, Date.now()]);
    if (!row) fail(410, "FILE_UNAVAILABLE", "This attachment has expired or is unavailable.");
    await this.service.conversation(this.service.db, userId, row.conversation_id);
    return row;
  }
  register(api) {
    api.post("/attachments/:id/preview", async (req) => {
      z2.object({ requestId }).strict().parse(req.body);
      const fileId = uuid.parse(req.params.id);
      await this.available(req.account.id, fileId);
      for (const [key, ticket2] of this.tickets) if (ticket2.expiresAt <= Date.now()) this.tickets.delete(key);
      const owned = [...this.tickets].filter(([, t]) => t.sessionId === req.session.id);
      for (const [key] of owned.slice(0, Math.max(0, owned.length - 31))) this.tickets.delete(key);
      while (this.tickets.size >= 512) this.tickets.delete(this.tickets.keys().next().value);
      const ticket = randomBytes(32).toString("base64url"), expiresAt = Date.now() + 5 * 6e4;
      this.tickets.set(hash(ticket), { sessionId: req.session.id, fileId, expiresAt });
      return { path: `/api/v1/attachments/${fileId}/media?media_ticket=${ticket}`, expiresAt };
    });
    api.get("/attachments/:id/media", async (req, reply) => {
      if ([...this.readers.values()].reduce((a, b) => a + b, 0) >= 4) fail(429, "DOWNLOAD_BUSY", "Downloads are busy. Retry shortly.");
      const fileId = uuid.parse(req.params.id);
      this.readers.set(fileId, (this.readers.get(fileId) || 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const count = (this.readers.get(fileId) || 1) - 1;
        if (count) this.readers.set(fileId, count);
        else this.readers.delete(fileId);
      };
      reply.raw.once("close", release);
      reply.raw.once("finish", release);
      try {
        const row = await this.available(req.account.id, fileId), filename = this.file(fileId), info = await stat(filename).catch(() => null);
        if (!info?.isFile() || info.size !== Number(row.size)) fail(410, "FILE_UNAVAILABLE", "This attachment is missing or corrupted.");
        const key = `${row.digest}/${info.size}/${info.mtimeMs}/${info.ctimeMs}`, cached = this.checked.get(fileId);
        let mime = cached?.key === key && cached.expiresAt > Date.now() ? cached.mime : null;
        if (!mime) {
          const digest = createHash("sha256");
          let prefix = Buffer.alloc(0);
          for await (const chunk of createReadStream(filename)) {
            digest.update(chunk);
            if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
          }
          if (!row.digest || digest.digest("hex") !== row.digest) fail(410, "FILE_UNAVAILABLE", "This attachment is missing or corrupted.");
          mime = mediaMime(row.name, prefix);
          if (!mime) fail(415, "PREVIEW_UNSUPPORTED", "This file cannot be previewed. Download it to view.");
          if (this.checked.size >= 64) this.checked.delete(this.checked.keys().next().value);
          this.checked.set(fileId, { key, expiresAt: Date.now() + 6e4, mime });
        }
        reply.header("Content-Type", mime).header("Content-Disposition", "inline").header("X-Content-Type-Options", "nosniff").header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer").header("Content-Security-Policy", "sandbox; default-src 'none'").header("Accept-Ranges", "bytes");
        let range;
        try {
          range = byteRange(req.headers.range, info.size);
        } catch {
          release();
          return reply.code(416).header("Content-Range", `bytes */${info.size}`).send();
        }
        if (range) reply.code(206).header("Content-Range", `bytes ${range.start}-${range.end}/${info.size}`).header("Content-Length", range.end - range.start + 1);
        else reply.header("Content-Length", info.size);
        return reply.send(createReadStream(filename, range || void 0));
      } catch (error) {
        release();
        throw error;
      }
    });
  }
};

// apps/api/src/attachments.ts
import { randomUUID, createHash as createHash2 } from "crypto";
import { createReadStream as createReadStream2, createWriteStream } from "fs";
import { mkdir, rename, unlink, stat as stat2, statfs, opendir } from "fs/promises";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import path2 from "path";
import { z as z3 } from "zod";
var MiB = 1048576;
var retentionMs = (bytes) => bytes <= 10 * MiB ? 7 * 864e5 : 864e5;
var extensions = /* @__PURE__ */ new Set([".pdf", ".txt", ".md", ".csv", ".json", ".zip", ".7z", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp3", ".ogg", ".wav", ".mp4", ".webm"]);
var uuid2 = z3.string().uuid();
var Attachments = class {
  constructor(service) {
    this.service = service;
    this.media = new AttachmentMedia(service, this.readers, (id2) => this.file(id2));
  }
  service;
  writers = /* @__PURE__ */ new Set();
  readers = /* @__PURE__ */ new Map();
  sweeping = false;
  scan = null;
  media;
  file(id2, partial = false) {
    return path2.join(this.service.c.attachmentDir, `${uuid2.parse(id2)}.${partial ? "part" : "bin"}`);
  }
  async initialize() {
    await mkdir(this.service.c.attachmentDir, { recursive: true, mode: 448 });
    await this.cleanup();
  }
  async close() {
    await this.scan?.close().catch(() => {
    });
    this.scan = null;
  }
  async status() {
    const disk = await statfs(this.service.c.attachmentDir), rows = await this.service.db.one("SELECT COALESCE(SUM(size),0) AS bytes FROM attachments WHERE state IN ('reserved','ready')");
    return { bytes: Number(rows.bytes), budget: this.service.c.attachmentBudgetMiB * MiB, freeBytes: disk.bavail * disk.bsize, reserveBytes: this.service.c.uploadReserveMiB * MiB };
  }
  register(api) {
    this.media.register(api);
    const { db, c } = this.service;
    api.addContentTypeParser("application/octet-stream", (_req, stream, done) => done(null, stream));
    api.post("/attachments", async (req) => {
      if (req.account.guest) fail(403, "GUEST_UPLOAD", "Guests cannot upload files.");
      const b = z3.object({ conversationId: id, name: z3.string().trim().min(1).max(180).refine((s) => ![...s].some((c2) => c2.charCodeAt(0) < 32 || c2.charCodeAt(0) === 127 || c2 === "/" || c2 === String.fromCharCode(92)), "Invalid filename"), size: z3.number().int().min(1).max(100 * MiB), requestId }).parse(req.body);
      if (!extensions.has(path2.extname(b.name).toLowerCase())) fail(400, "FILE_TYPE", "This file type is not supported.");
      await this.cleanup(b.size);
      const storage = await this.status();
      return db.transaction(async (tx) => {
        await this.service.conversation(tx, req.account.id, b.conversationId, true);
        const old = await tx.one("SELECT * FROM attachments WHERE user_id=? AND request_id=?", [req.account.id, b.requestId]);
        if (old) {
          if (old.conversation_id !== b.conversationId || old.name !== b.name || Number(old.size) !== b.size) fail(409, "IDEMPOTENCY_CONFLICT", "Upload identifier already has different input.");
          return { id: old.id, state: old.state, expiresAt: Number(old.expires_at) };
        }
        const usage = await tx.one("SELECT COALESCE(SUM(bytes),0) AS bytes FROM attachment_usage WHERE user_id=? AND created_at>?", [req.account.id, Date.now() - 864e5]);
        if (Number(usage.bytes) + b.size > 300 * MiB) fail(429, "UPLOAD_QUOTA", "The 300 MiB rolling daily upload allowance has been reached.");
        const global = Number((await tx.one("SELECT COALESCE(SUM(bytes),0) AS bytes FROM attachment_usage WHERE created_at>?", [Date.now() - 864e5])).bytes);
        if (global + b.size > c.uploadHardMiB * MiB) fail(429, "UPLOAD_GLOBAL_HARD", "The shared daily upload allowance has been reached.");
        if (global + b.size > c.uploadSoftMiB * MiB && b.size > c.uploadSmallMiB * MiB) fail(429, "UPLOAD_SMALL_ONLY", "Only files up to 2 MiB are allowed after the shared normal allowance is used. Compress pictures or try again later.");
        if (await tx.one("SELECT id FROM attachments WHERE user_id=? AND state='reserved'", [req.account.id])) fail(429, "UPLOAD_BUSY", "Finish or cancel your current upload first.");
        if ((await tx.one("SELECT COUNT(*) AS count FROM attachment_usage WHERE user_id=? AND created_at>?", [req.account.id, Date.now() - 864e5])).count >= 200) fail(429, "UPLOAD_COUNT", "At most 200 uploads are allowed per day.");
        const pending = await tx.one("SELECT COALESCE(SUM(size),0) AS bytes FROM attachments WHERE state='reserved'");
        const allocated = await tx.one("SELECT COALESCE(SUM(size),0) AS bytes FROM attachments WHERE state IN ('reserved','ready')");
        if (Number(allocated.bytes) + b.size > storage.budget || storage.freeBytes - Number(pending.bytes) - b.size < storage.reserveBytes) fail(507, "UPLOAD_STORAGE", "File storage has insufficient free space.");
        const uploadId = randomUUID(), now = Date.now(), expires = now + retentionMs(b.size);
        await tx.run("INSERT INTO attachments(id,user_id,conversation_id,request_id,name,size,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)", [uploadId, req.account.id, b.conversationId, b.requestId, b.name, b.size, "reserved", now, expires]);
        await tx.run("INSERT INTO attachment_usage(id,user_id,bytes,created_at) VALUES(?,?,?,?)", [uploadId, req.account.id, b.size, now]);
        return { id: uploadId, state: "reserved", expiresAt: expires };
      });
    });
    api.post("/attachments/:id/content", { bodyLimit: 100 * MiB, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
      const uploadId = uuid2.parse(req.params.id);
      if (req.account.guest) fail(403, "GUEST_UPLOAD", "Guests cannot upload files.");
      if (this.writers.size >= c.uploadConcurrency || this.writers.has(uploadId)) fail(429, "UPLOAD_BUSY", "Uploads are busy. Retry shortly.");
      this.writers.add(uploadId);
      let ownedReservation = false;
      try {
        const upload = await db.one("SELECT * FROM attachments WHERE id=? AND user_id=?", [uploadId, req.account.id]);
        if (!upload) fail(404, "NOT_FOUND", "Upload is unavailable.");
        await this.service.conversation(db, req.account.id, upload.conversation_id, true);
        if (upload.state === "ready") return { id: uploadId, state: "ready" };
        ownedReservation = upload.state === "reserved";
        if (upload.state !== "reserved" || Number(upload.created_at) + 15 * 6e4 < Date.now()) fail(410, "UPLOAD_EXPIRED", "Upload reservation expired.");
        if (req.headers["content-length"] !== String(upload.size) || req.headers["content-type"]?.split(";")[0] !== "application/octet-stream") fail(400, "UPLOAD_SIZE", "Send exactly the reserved bytes as application/octet-stream.");
        const digest = createHash2("sha256");
        let received = 0, prefix = Buffer.alloc(0);
        const measure = new Transform({ transform(chunk, _encoding, done) {
          received += chunk.length;
          if (received > Number(upload.size)) return done(new Error("Upload exceeded reserved size."));
          digest.update(chunk);
          if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
          done(null, chunk);
        } });
        await pipeline(req.body, measure, createWriteStream(this.file(uploadId, true), { flags: "wx", mode: 384 }));
        if (received !== Number(upload.size)) fail(400, "UPLOAD_SIZE", "Upload was incomplete.");
        const ext = path2.extname(upload.name).toLowerCase(), hex = prefix.toString("hex");
        const signatures = { ".pdf": prefix.subarray(0, 5).toString() === "%PDF-", ".png": hex.startsWith("89504e470d0a1a0a"), ".jpg": hex.startsWith("ffd8ff"), ".jpeg": hex.startsWith("ffd8ff"), ".gif": prefix.toString().startsWith("GIF8"), ".zip": hex.startsWith("504b"), ".webp": prefix.subarray(8, 12).toString() === "WEBP", ".7z": hex.startsWith("377abcaf271c") };
        if (signatures[ext] === false || hex.startsWith("4d5a") || hex.startsWith("7f454c46")) fail(400, "FILE_TYPE", "File contents do not match the supported file type.");
        await rename(this.file(uploadId, true), this.file(uploadId));
        await db.run("UPDATE attachments SET state='ready',digest=? WHERE id=? AND state='reserved'", [digest.digest("hex"), uploadId]);
        return { id: uploadId, state: "ready" };
      } catch (e) {
        if (ownedReservation) {
          await db.run("UPDATE attachments SET state='unavailable' WHERE id=? AND user_id=? AND state='reserved'", [uploadId, req.account.id]);
          await unlink(this.file(uploadId, true)).catch(() => {
          });
        }
        throw e;
      } finally {
        this.writers.delete(uploadId);
      }
    });
    api.delete("/attachments/:id", async (req) => {
      const uploadId = uuid2.parse(req.params.id);
      requestId.parse(req.body?.requestId);
      if (this.writers.has(uploadId)) fail(409, "UPLOAD_BUSY", "Cancel the active transfer before removing the reservation.");
      await db.run("UPDATE attachments SET state='unavailable' WHERE id=? AND user_id=? AND message_id IS NULL", [uploadId, req.account.id]);
      await this.cleanup();
      return { success: true };
    });
    api.get("/attachments/:id/download", async (req, reply) => {
      if ([...this.readers.values()].reduce((a, b) => a + b, 0) >= 4) fail(429, "DOWNLOAD_BUSY", "Downloads are busy. Retry shortly.");
      const uploadId = uuid2.parse(req.params.id);
      this.readers.set(uploadId, (this.readers.get(uploadId) || 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const n = (this.readers.get(uploadId) || 1) - 1;
        if (n) this.readers.set(uploadId, n);
        else this.readers.delete(uploadId);
      };
      reply.raw.once("close", release);
      reply.raw.once("finish", release);
      try {
        const file = await db.one("SELECT a.* FROM attachments a JOIN messages m ON a.message_id=m.id WHERE a.id=? AND a.state='ready' AND a.expires_at>? AND m.deleted=0", [uploadId, Date.now()]);
        if (!file) fail(410, "FILE_UNAVAILABLE", "This attachment has expired or is unavailable.");
        await this.service.conversation(db, req.account.id, file.conversation_id);
        const info = await stat2(this.file(uploadId)).catch(() => null);
        if (!info || info.size !== Number(file.size)) {
          await db.run("UPDATE attachments SET state='unavailable' WHERE id=?", [uploadId]);
          fail(410, "FILE_UNAVAILABLE", "This attachment is missing or corrupted.");
        }
        const check = createHash2("sha256");
        for await (const chunk of createReadStream2(this.file(uploadId))) check.update(chunk);
        if (!file.digest || check.digest("hex") !== file.digest) {
          await db.run("UPDATE attachments SET state='unavailable' WHERE id=?", [uploadId]);
          fail(410, "FILE_UNAVAILABLE", "This attachment is missing or corrupted.");
        }
        reply.header("Content-Type", "application/octet-stream").header("Content-Length", String(info.size)).header("Content-Disposition", `attachment; filename="download${path2.extname(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()]/g, (c2) => `%${c2.charCodeAt(0).toString(16)}`)}`).header("X-Content-Type-Options", "nosniff").header("Cache-Control", "no-store").header("Content-Security-Policy", "sandbox; default-src 'none'");
        return reply.send(createReadStream2(this.file(uploadId)));
      } catch (e) {
        release();
        throw e;
      }
    });
    api.get("/attachments/:id/status", async (req) => {
      const file = await db.one("SELECT * FROM attachments WHERE id=? AND user_id=? AND message_id IS NULL AND state='ready' AND expires_at>?", [req.params.id, req.account.id, Date.now()]);
      if (!file) fail(410, "FILE_UNAVAILABLE", "This draft attachment has expired or is unavailable.");
      await this.service.conversation(db, req.account.id, file.conversation_id, true);
      return { id: file.id, name: file.name, size: Number(file.size), expiresAt: Number(file.expires_at), available: true };
    });
    api.get("/uploads/usage", async (req) => ({ usedBytes: Number((await db.one("SELECT COALESCE(SUM(bytes),0) AS bytes FROM attachment_usage WHERE user_id=? AND created_at>?", [req.account.id, Date.now() - 864e5])).bytes), limitBytes: req.account.guest ? 0 : 300 * MiB, maxFileBytes: 100 * MiB, sharedUsedBytes: Number((await db.one("SELECT COALESCE(SUM(bytes),0) AS bytes FROM attachment_usage WHERE created_at>?", [Date.now() - 864e5])).bytes), softBytes: c.uploadSoftMiB * MiB, hardBytes: c.uploadHardMiB * MiB, smallFileBytes: c.uploadSmallMiB * MiB }));
  }
  async cleanup(requiredBytes = 0) {
    if (this.sweeping) return;
    this.sweeping = true;
    const { db, c } = this.service;
    try {
      const storage = await this.status();
      let reclaimed = 0;
      const candidates = await db.all("SELECT * FROM attachments WHERE state<>'removed' AND (state<>'reserved' OR created_at<?) ORDER BY CASE WHEN expires_at<? OR state<>'ready' THEN 0 ELSE 1 END,created_at LIMIT 100", [Date.now() - 15 * 6e4, Date.now()]);
      for (const a of candidates) {
        if (this.writers.has(a.id) || this.readers.has(a.id)) continue;
        const expired = a.expires_at < Date.now() || a.state !== "ready";
        const pressure = storage.bytes - reclaimed + requiredBytes > storage.budget || storage.freeBytes + reclaimed - requiredBytes < storage.reserveBytes;
        if (!expired && !pressure) continue;
        await db.run("UPDATE attachments SET state='unavailable' WHERE id=?", [a.id]);
        let removed = true;
        for (const partial of [false, true]) await unlink(this.file(a.id, partial)).catch((e) => {
          if (e.code !== "ENOENT") removed = false;
        });
        if (removed) {
          reclaimed += Number(a.size);
          if (a.state !== "removed") await db.run("UPDATE attachments SET state='removed' WHERE id=?", [a.id]);
        }
        if (a.message_id && await db.one("SELECT id FROM messages WHERE id=?", [a.message_id])) {
          const event = await db.transaction(async (tx) => this.service.event(tx, a.conversation_id, "message", await this.service.messageView(tx, a.message_id)));
          await this.service.notify("conversation:event", event);
        }
      }
      this.scan ||= await opendir(c.attachmentDir);
      for (let n = 0; n < 100; n++) {
        const entry = await this.scan.read();
        if (!entry) {
          await this.close();
          break;
        }
        const name = entry.name;
        if (!entry.isFile() || !/^[0-9a-f-]{36}\.(bin|part)$/i.test(name)) continue;
        const uid = name.slice(0, 36);
        if (this.writers.has(uid) || this.readers.has(uid)) continue;
        if (!await db.one("SELECT id FROM attachments WHERE id=?", [uid])) await unlink(path2.join(c.attachmentDir, name)).catch(() => {
        });
      }
      await db.run("DELETE FROM attachment_usage WHERE id IN (SELECT id FROM attachment_usage WHERE created_at<? LIMIT 1000)", [Date.now() - 864e5]);
    } finally {
      this.sweeping = false;
    }
  }
};

// apps/api/src/media-admission.ts
import { TokenVerifier, TrackSource as TrackSource2 } from "livekit-server-sdk";
function mediaAdmission(app2, service, sessionForSocket) {
  const { c, db } = service;
  app2.get("/internal/media/admission", async (req) => {
    if (!c.mediaAdmissionSecret || !equal(String(req.headers["x-dorham-media-gate"] || ""), c.mediaAdmissionSecret)) fail(404, "NOT_FOUND", "Not found.");
    let uri;
    try {
      uri = new URL(String(req.headers["x-forwarded-uri"] || ""), "http://internal.invalid");
    } catch {
      fail(403, "FORBIDDEN", "Media admission denied.");
    }
    if (!/^\/rtc(?:\/|$)/.test(uri.pathname)) fail(403, "FORBIDDEN", "Media admission denied.");
    const raw = uri.searchParams.get("access_token") || (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "");
    if (!raw || raw.length > 8192) fail(403, "FORBIDDEN", "Media admission denied.");
    let claims;
    try {
      claims = await new TokenVerifier(c.livekitKey, c.livekitSecret).verify(raw, 0);
    } catch {
      fail(403, "FORBIDDEN", "Media admission denied.");
    }
    const video = claims.video, identity = claims.sub || "", [userId, epoch, extra] = identity.split(":");
    if (!video?.roomJoin || !video.room || !userId || !epoch || extra) fail(403, "FORBIDDEN", "Media admission denied.");
    const vm = await db.one("SELECT v.* FROM voice_members v JOIN users u ON u.id=v.user_id WHERE v.user_id=? AND v.epoch=? AND v.channel_id=? AND v.heartbeat>=? AND u.banned=0 AND u.must_change_password=0", [userId, epoch, video.room, Date.now() - 3e4]);
    const sessionId = vm ? sessionForSocket(vm.socket_id) : void 0;
    if (!vm || !sessionId || !await db.one("SELECT id FROM sessions WHERE id=? AND user_id=? AND access_expires>=? AND expires_at>=?", [sessionId, userId, Date.now(), Date.now()])) fail(403, "FORBIDDEN", "Media admission denied.");
    const ch = await service.channel(db, userId, vm.channel_id);
    if (vm.server_deafened && video.canSubscribe !== false) fail(403, "FORBIDDEN", "Media admission denied.");
    if (video.canPublishData) fail(403, "FORBIDDEN", "Media admission denied.");
    if (video.canPublish) {
      if (!Array.isArray(video.canPublishSources) || !video.canPublishSources.length) fail(403, "FORBIDDEN", "Media admission denied.");
      for (const source of video.canPublishSources) {
        if ((source === TrackSource2.MICROPHONE || String(source) === "microphone") && ch.permissions.speak && !vm.server_muted && !vm.server_deafened) continue;
        if ((source === TrackSource2.SCREEN_SHARE || String(source) === "screen_share") && ch.permissions.share && await db.one("SELECT id FROM share_leases WHERE user_id=? AND channel_id=? AND expires_at>?", [userId, vm.channel_id, Date.now()])) continue;
        if ((source === TrackSource2.SCREEN_SHARE_AUDIO || String(source) === "screen_share_audio") && ch.permissions.share && await db.one("SELECT id FROM share_leases WHERE user_id=? AND channel_id=? AND expires_at>? AND include_audio=1", [userId, vm.channel_id, Date.now()])) continue;
        fail(403, "FORBIDDEN", "Media admission denied.");
      }
    }
    return { allowed: true };
  });
}

// apps/api/src/chess.ts
import { randomUUID as randomUUID3 } from "crypto";
import { z as z5 } from "zod";

// packages/contracts/src/chess.ts
var costs = { p: 1, n: 3, b: 3, r: 5, q: 9 };
var colorOf = (p) => p === p.toUpperCase() ? 0 : 1;
var squareName = (i) => "abcdefgh"[i % 8] + (8 - Math.floor(i / 8));
var inside = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;
var bishop = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
var rook = [[1, 0], [-1, 0], [0, 1], [0, -1]];
var knight = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
function initialPosition(mode) {
  const board = Array(64).fill("");
  if (mode === "standard") {
    [..."rnbqkbnrpppppppp"].forEach((p, i) => board[i] = p);
    [..."PPPPPPPPRNBQKBNR"].forEach((p, i) => board[i + 48] = p);
  } else {
    board[4] = "k";
    board[60] = "K";
  }
  const s = { mode, board, turn: 0, rights: mode === "standard" ? "KQkq" : "", ep: -1, virgin: mode === "elixer" ? [4, 60] : [], coins: [3, 3], half: 0, ply: 0, repeats: [] };
  s.repeats = [positionKey(s)];
  return s;
}
function attacked(s, target, by) {
  const x = target % 8, y = Math.floor(target / 8);
  for (const dx of [-1, 1]) {
    const py = y + (by === 0 ? 1 : -1), px = x + dx;
    if (inside(px, py) && s.board[py * 8 + px] === (by === 0 ? "P" : "p")) return true;
  }
  for (const [dx, dy] of knight) if (inside(x + dx, y + dy) && s.board[(y + dy) * 8 + x + dx] === (by === 0 ? "N" : "n")) return true;
  for (const [dx, dy] of [...bishop, ...rook]) {
    for (let d = 1; inside(x + dx * d, y + dy * d); d++) {
      const p = s.board[(y + dy * d) * 8 + x + dx * d];
      if (!p) continue;
      if (colorOf(p) === by && (p.toLowerCase() === "q" || p.toLowerCase() === (dx && dy ? "b" : "r") || d === 1 && p.toLowerCase() === "k")) return true;
      break;
    }
  }
  return false;
}
function inCheck(s, color = s.turn) {
  const i = s.board.indexOf(color === 0 ? "K" : "k");
  return i < 0 || attacked(s, i, 1 - color);
}
function pseudo(s) {
  const actions = [], add = (from, to) => {
    if (s.board[to]?.toLowerCase() === "k") return;
    if (s.board[from].toLowerCase() === "p" && (to < 8 || to >= 56)) for (const promotion of ["q", "r", "b", "n"]) actions.push({ from, to, promotion });
    else actions.push({ from, to });
  };
  for (let from = 0; from < 64; from++) {
    const p = s.board[from];
    if (!p || colorOf(p) !== s.turn) continue;
    const type = p.toLowerCase(), x = from % 8, y = Math.floor(from / 8);
    if (type === "p") {
      const dy = s.turn === 0 ? -1 : 1, next = from + dy * 8;
      if (inside(x, y + dy) && !s.board[next]) {
        add(from, next);
        if ((s.mode === "elixer" ? s.virgin.includes(from) : y === (s.turn === 0 ? 6 : 1)) && inside(x, y + 2 * dy) && !s.board[from + 16 * dy]) add(from, from + 16 * dy);
      }
      for (const dx of [-1, 1]) if (inside(x + dx, y + dy)) {
        const to = next + dx, target = s.board[to];
        if (target && colorOf(target) !== s.turn || to === s.ep && s.board[to - dy * 8]?.toLowerCase() === "p") add(from, to);
      }
    } else {
      const directions = type === "n" ? knight : type === "b" ? bishop : type === "r" ? rook : [...bishop, ...rook];
      for (const [dx, dy] of directions) for (let d = 1; inside(x + d * dx, y + d * dy); d++) {
        const to = (y + d * dy) * 8 + x + d * dx, target = s.board[to];
        if (target && colorOf(target) === s.turn) break;
        add(from, to);
        if (target || type === "n" || type === "k") break;
      }
      if (type === "k" && from === (s.turn === 0 ? 60 : 4) && !inCheck(s)) for (const [right, corner, step] of [[s.turn === 0 ? "K" : "k", from + 3, 1], [s.turn === 0 ? "Q" : "q", from - 4, -1]]) {
        const eligible = s.mode === "elixer" ? s.virgin.includes(from) && s.virgin.includes(corner) : s.rights.includes(right);
        if (!eligible || s.board[corner] !== (s.turn === 0 ? "R" : "r")) continue;
        if (s.board[from + step] || s.board[from + step * 2] || step < 0 && s.board[from - 3]) continue;
        if (!attacked(s, from + step, 1 - s.turn) && !attacked(s, from + step * 2, 1 - s.turn)) add(from, from + step * 2);
      }
    }
  }
  if (s.mode === "elixer") {
    for (const buy of Object.keys(costs)) if (s.coins[s.turn] >= costs[buy]) {
      const start = s.turn === 0 ? 48 : 0;
      for (let to = start; to < start + 16; to++) if (!s.board[to]) actions.push({ buy, to });
    }
  }
  return actions;
}
function transition(s, a) {
  const board = s.board.slice(), color = s.turn, captured = board[a.to];
  let rights = s.rights, virgin = s.virgin.filter((i) => i !== a.to && i !== a.from), ep = -1;
  const coins = [...s.coins];
  let half = s.half + 1;
  if (a.buy) {
    board[a.to] = color === 0 ? a.buy.toUpperCase() : a.buy;
    coins[color] -= costs[a.buy];
    virgin.push(a.to);
    half = 0;
  } else {
    const from = a.from, p = board[from], type = p.toLowerCase();
    board[from] = "";
    board[a.to] = p;
    if (type === "p") {
      half = 0;
      if (Math.abs(a.to - from) === 16) ep = (a.to + from) / 2;
      if (a.to === s.ep && !captured && from % 8 !== a.to % 8) {
        const victim = a.to + (color === 0 ? 8 : -8);
        board[victim] = "";
        virgin = virgin.filter((i) => i !== victim);
      }
      if (a.promotion) board[a.to] = color === 0 ? a.promotion.toUpperCase() : a.promotion;
    }
    if (type === "k") {
      rights = rights.replace(color === 0 ? /[KQ]/g : /[kq]/g, "");
      if (Math.abs(a.to - from) === 2) {
        const corner = a.to > from ? from + 3 : from - 4, dest = a.to > from ? from + 1 : from - 1;
        board[dest] = board[corner];
        board[corner] = "";
        virgin = virgin.filter((i) => i !== corner);
      }
    }
    if (captured) half = 0;
    for (const [i, right] of [[0, "q"], [7, "k"], [56, "Q"], [63, "K"]]) if (from === i || a.to === i) rights = rights.replace(right, "");
  }
  if (s.mode === "elixer") coins[color]++;
  return { ...s, board, rights, virgin, coins, ep, half, turn: 1 - color, ply: s.ply + 1, last: a };
}
function legalActions(s) {
  return pseudo(s).filter((a) => !inCheck(transition(s, a), s.turn));
}
function sameAction(a, b) {
  return a.from === b.from && a.to === b.to && a.buy === b.buy && a.promotion === b.promotion;
}
function positionKey(s) {
  const ep = s.ep >= 0 && pseudo({ ...s, coins: [0, 0] }).some((a) => a.from !== void 0 && a.to === s.ep && s.board[a.from].toLowerCase() === "p" && a.from % 8 !== a.to % 8 && !inCheck(transition(s, a), s.turn)) ? s.ep : -1;
  return `${s.board.map((p) => p || ".").join("")}/${s.turn}/${s.rights}/${ep}${s.mode === "elixer" ? `/${s.coins}/${s.virgin.slice().sort((a, b) => a - b)}` : ""}`;
}
function applyAction(s, action2) {
  const a = legalActions(s).find((a2) => sameAction(a2, action2));
  if (!a) throw new Error("Illegal chess action");
  return advanceLegalAction(s, a);
}
function advanceLegalAction(s, a) {
  const next = transition(s, a);
  next.repeats = [...next.half === 0 && s.mode === "standard" ? [] : s.repeats, positionKey(next)].slice(-1001);
  return next;
}
function insufficient(s) {
  if (s.mode !== "standard") return false;
  const rest = s.board.flatMap((p, i) => p && p.toLowerCase() !== "k" ? [{ p: p.toLowerCase(), i }] : []);
  if (!rest.length) return true;
  if (rest.length === 1 && ["b", "n"].includes(rest[0].p)) return true;
  return rest.every((v) => v.p === "b") && rest.every((v) => (v.i % 8 + Math.floor(v.i / 8)) % 2 === (rest[0].i % 8 + Math.floor(rest[0].i / 8)) % 2);
}
function repetitionCount(s) {
  const key = positionKey(s);
  return s.repeats.filter((k) => k === key).length;
}
function canMateOnTimeout(s, color) {
  const own = s.board.filter((p) => p && colorOf(p) === color && p.toLowerCase() !== "k");
  if (!own.length) return false;
  if (own.length === 1 && ["b", "n"].includes(own[0].toLowerCase()) && s.board.filter((p) => p && colorOf(p) !== color && p.toLowerCase() !== "k").length === 0) return false;
  return !insufficient(s);
}
function outcome(s) {
  if (!legalActions(s).length) return inCheck(s) ? s.turn === 0 ? "Black wins by checkmate" : "White wins by checkmate" : "Draw by stalemate";
  if (insufficient(s)) return "Draw by insufficient material";
  if (s.mode === "standard" && (s.half >= 150 || repetitionCount(s) >= 5)) return "Draw by automatic rule";
  return s.ply >= 1e3 ? "Draw by game length limit" : null;
}

// apps/api/src/games/service.ts
import { randomUUID as randomUUID2 } from "crypto";
import { z as z4 } from "zod";

// packages/contracts/src/games.ts
var gameCatalog = [
  { id: "chess", name: "Chess", icon: "\u265F", min: 2, max: 2, description: "Standard chess and Elixer Chess" },
  { id: "poker", name: "Texas Hold\u2019em", icon: "\u2660", min: 2, max: 8, description: "Poker with play chips only" },
  { id: "domino", name: "Dominoes", icon: "\u2685", min: 2, max: 4, description: "Draw and Block dominoes" },
  { id: "telephone", name: "Drawing Telephone", icon: "\u270E", min: 3, max: 8, description: "Write, draw, guess, and reveal" },
  { id: "drawing", name: "Draw & Guess", icon: "\u25A7", min: 2, max: 8, description: "Draw a word for your friends to guess" },
  { id: "words", name: "Team Word Clues", icon: "\u25A6", min: 4, max: 8, description: "Two teams, secret words, clever clues" },
  { id: "ludo", name: "Ludo", icon: "\u2684", min: 2, max: 4, description: "Race your four tokens home" },
  { id: "four", name: "Four in a Row", icon: "\u25CF", min: 2, max: 2, description: "Connect four counters to win" }
];
var definition = (id2) => gameCatalog.find((g) => g.id === id2);

// apps/api/src/games/engine.ts
import { randomInt as randomInt2 } from "crypto";

// apps/api/src/games/common.ts
import { randomInt } from "crypto";
function insist(value, message = "That action is unavailable.") {
  if (!value) throw new Error(message);
}
function integer(value, min, max) {
  insist(typeof value === "number" && Number.isInteger(value) && value >= min && value <= max, "Choose a valid number.");
  return value;
}
function text(value, max = 180) {
  insist(typeof value === "string" && value.trim().length > 0 && value.trim().length <= max, "Enter a shorter, nonempty answer.");
  return value.trim().normalize("NFC");
}
function shuffle(values) {
  const a = values.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
var freshPicture = () => ({ strokes: [], points: 0 });
var colors = ["#20232b", "#ffffff", "#e45b63", "#4a86e8", "#43a477", "#ecc64c", "#9a69d5", "#e78e48"];
function stroke(picture, value) {
  insist(value && colors.includes(value.color) && [3, 7, 14].includes(value.width), "Choose a drawing tool.");
  insist(Array.isArray(value.points) && value.points.length >= 1 && value.points.length <= 100, "Draw shorter strokes.");
  insist(picture.points + value.points.length <= 1e3 && picture.strokes.length < 160, "This drawing is full. Clear it or submit it.");
  const item = { color: value.color, width: value.width, points: value.points.map((p) => {
    insist(Array.isArray(p) && p.length === 2);
    return [integer(p[0], 0, 1e3), integer(p[1], 0, 1e3)];
  }) };
  picture.strokes.push(item);
  picture.points += item.points.length;
}
var english = ["apple", "bridge", "castle", "dragon", "elephant", "flower", "guitar", "island", "jungle", "kite", "lantern", "mountain", "notebook", "ocean", "pencil", "queen", "rainbow", "snowman", "tiger", "umbrella", "volcano", "window", "yacht", "zebra", "balloon", "camera", "dolphin", "eagle", "forest", "garden", "hammer", "iceberg", "jacket", "kettle", "lemon", "moon", "needle", "orange", "penguin", "rocket", "sailboat", "turtle", "unicorn", "violin", "waterfall", "anchor", "bicycle", "cloud", "desert", "envelope", "feather", "glove", "helmet", "igloo", "jellyfish", "key", "ladder", "mirror", "nest", "owl", "planet", "rabbit", "sunflower", "train", "village", "whale", "zipper", "robot", "candle", "butterfly", "crown", "diamond", "fire", "ghost", "heart", "leaf", "magnet", "pearl", "star", "tower"];
var persian = ["\u0633\u06CC\u0628", "\u067E\u0644", "\u0642\u0644\u0639\u0647", "\u0627\u0698\u062F\u0647\u0627", "\u0641\u06CC\u0644", "\u06AF\u0644", "\u06AF\u06CC\u062A\u0627\u0631", "\u062C\u0632\u06CC\u0631\u0647", "\u062C\u0646\u06AF\u0644", "\u0628\u0627\u062F\u0628\u0627\u062F\u06A9", "\u0641\u0627\u0646\u0648\u0633", "\u06A9\u0648\u0647", "\u062F\u0641\u062A\u0631", "\u062F\u0631\u06CC\u0627", "\u0645\u062F\u0627\u062F", "\u0645\u0644\u06A9\u0647", "\u0631\u0646\u06AF\u06CC\u0646\u200C\u06A9\u0645\u0627\u0646", "\u0622\u062F\u0645\u200C\u0628\u0631\u0641\u06CC", "\u0628\u0628\u0631", "\u0686\u062A\u0631", "\u0622\u062A\u0634\u0641\u0634\u0627\u0646", "\u067E\u0646\u062C\u0631\u0647", "\u0642\u0627\u06CC\u0642", "\u06AF\u0648\u0631\u062E\u0631", "\u0628\u0627\u062F\u06A9\u0646\u06A9", "\u062F\u0648\u0631\u0628\u06CC\u0646", "\u062F\u0644\u0641\u06CC\u0646", "\u0639\u0642\u0627\u0628", "\u0628\u0627\u063A", "\u0686\u06A9\u0634", "\u06A9\u0627\u067E\u0634\u0646", "\u06A9\u062A\u0631\u06CC", "\u0644\u06CC\u0645\u0648", "\u0645\u0627\u0647", "\u0633\u0648\u0632\u0646", "\u067E\u0631\u062A\u0642\u0627\u0644", "\u067E\u0646\u06AF\u0648\u0626\u0646", "\u0645\u0648\u0634\u06A9", "\u0644\u0627\u06A9\u200C\u067E\u0634\u062A", "\u0648\u06CC\u0648\u0644\u0646", "\u0622\u0628\u0634\u0627\u0631", "\u0644\u0646\u06AF\u0631", "\u062F\u0648\u0686\u0631\u062E\u0647", "\u0627\u0628\u0631", "\u0628\u06CC\u0627\u0628\u0627\u0646", "\u067E\u0627\u06A9\u062A", "\u067E\u0631", "\u062F\u0633\u062A\u06A9\u0634", "\u06A9\u0644\u0627\u0647", "\u06A9\u0644\u06CC\u062F", "\u0646\u0631\u062F\u0628\u0627\u0646", "\u0622\u06CC\u0646\u0647", "\u0644\u0627\u0646\u0647", "\u062C\u063A\u062F", "\u0633\u06CC\u0627\u0631\u0647", "\u062E\u0631\u06AF\u0648\u0634", "\u0642\u0637\u0627\u0631", "\u0631\u0648\u0633\u062A\u0627", "\u0646\u0647\u0646\u06AF", "\u0631\u0628\u0627\u062A", "\u0634\u0645\u0639", "\u067E\u0631\u0648\u0627\u0646\u0647", "\u062A\u0627\u062C", "\u0627\u0644\u0645\u0627\u0633", "\u0622\u062A\u0634", "\u0631\u0648\u062D", "\u0642\u0644\u0628", "\u0628\u0631\u06AF", "\u0622\u0647\u0646\u0631\u0628\u0627", "\u0645\u0631\u0648\u0627\u0631\u06CC\u062F", "\u0633\u062A\u0627\u0631\u0647", "\u0628\u0631\u062C"];
var words = (s) => shuffle(s.language === "fa" ? persian : english);
var normalizeAnswer = (s) => s.normalize("NFKC").toLocaleLowerCase().replace(/[يى]/g, "\u06CC").replace(/ك/g, "\u06A9").replace(/\s|\u200c|\u200d|ـ/g, "");

// apps/api/src/games/boards.ts
function fourStart(now) {
  return { phase: "turn", deadline: now + 6e4, result: null, board: Array(42).fill(-1), turn: 0, moves: 0 };
}
function fourAction(s, seat, a, now) {
  insist(s.phase === "turn" && seat === s.turn && a.type === "drop");
  const col = integer(a.column, 0, 6);
  let row = 5;
  while (row >= 0 && s.board[row * 7 + col] !== -1) row--;
  insist(row >= 0, "That column is full.");
  const index = row * 7 + col;
  s.board[index] = seat;
  s.moves++;
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let count = 1;
    for (const sign of [-1, 1]) for (let d = 1; d < 4; d++) {
      const x = col + dx * d * sign, y = row + dy * d * sign;
      if (x < 0 || x > 6 || y < 0 || y > 5 || s.board[y * 7 + x] !== seat) break;
      count++;
    }
    if (count >= 4) {
      s.result = `Player ${seat + 1} wins`;
      s.phase = "ended";
      s.winner = seat;
    }
  }
  if (!s.result && s.moves === 42) {
    s.result = "Draw";
    s.phase = "ended";
  }
  s.turn = 1 - seat;
  s.deadline = s.result ? 0 : now + 6e4;
}
var dominoTiles = Array.from({ length: 7 }, (_, a) => Array.from({ length: 7 - a }, (_2, b) => [a, a + b])).flat();
function dominoRound(s, n, now) {
  const deck = shuffle(Array.from({ length: 28 }, (_, i) => i));
  s.hands = Array.from({ length: n }, (_, i) => s.active?.[i] === false ? [] : deck.splice(0, 7));
  s.boneyard = deck;
  s.chain = [];
  s.passes = 0;
  s.phase = "turn";
  s.roundResult = null;
  s.opening = -1;
  let best = -1, leader = 0;
  s.hands.forEach((hand, p) => hand.forEach((t) => {
    const [a, b] = dominoTiles[t], weight = a === b ? 100 + a : a + b;
    if (weight > best) {
      best = weight;
      leader = p;
      s.opening = t;
    }
  }));
  s.turn = leader;
  s.deadline = now + 6e4;
  s.round = (s.round || 0) + 1;
}
function dominoStart(n, settings, now) {
  const s = { phase: "turn", deadline: 0, result: null, scores: Array(n).fill(0), mode: settings.domino };
  dominoRound(s, n, now);
  return s;
}
function dominoLegal(s, seat) {
  const hand = s.hands[seat] || [];
  if (!s.chain.length) return hand.filter((t) => t === s.opening).map((tile) => ({ tile, end: "right" }));
  const left = s.chain[0][0], right = s.chain.at(-1)[1];
  return hand.flatMap((tile) => {
    const pair = dominoTiles[tile];
    return [...pair.includes(left) ? [{ tile, end: "left" }] : [], ...pair.includes(right) ? [{ tile, end: "right" }] : []];
  });
}
function dominoScore(s, now) {
  const sums = s.hands.map((h) => h.reduce((sum, t) => sum + dominoTiles[t][0] + dominoTiles[t][1], 0)), low = Math.min(...sums.filter((_, i) => s.active?.[i] !== false)), winners = sums.map((v, i) => v === low && s.active?.[i] !== false ? i : -1).filter((i) => i >= 0);
  s.roundResult = winners.length === 1 ? `Player ${winners[0] + 1} wins the round` : "Round drawn";
  if (winners.length === 1) s.scores[winners[0]] += sums.reduce((sum, v, i) => sum + (i === winners[0] ? 0 : v), 0);
  if (winners.length === 1 && s.scores[winners[0]] >= 100) {
    s.result = `Player ${winners[0] + 1} wins`;
    s.phase = "ended";
  } else s.phase = "between";
  s.deadline = now + 3e5;
}
function dominoAction(s, seat, a, now) {
  if (a.type === "next") {
    insist(s.phase === "between");
    dominoRound(s, s.hands.length, now);
    return;
  }
  insist(s.phase === "turn" && seat === s.turn, "Wait for your turn.");
  const legal = dominoLegal(s, seat);
  if (a.type === "draw") {
    insist(s.mode === "draw" && legal.length === 0 && s.boneyard.length > 0, "You must play an available tile.");
    s.hands[seat].push(s.boneyard.pop());
    s.deadline = now + 6e4;
    return;
  }
  if (a.type === "pass") {
    insist(legal.length === 0 && (s.mode === "block" || s.boneyard.length === 0), "Play or draw a tile first.");
    s.passes++;
  } else {
    insist(a.type === "tile");
    const tile = integer(a.tile, 0, 27);
    insist(legal.some((m) => m.tile === tile && m.end === a.end), "That tile does not fit.");
    const pair = dominoTiles[tile].slice();
    if (s.chain.length) {
      if (a.end === "left") {
        if (pair[1] !== s.chain[0][0]) pair.reverse();
      } else if (pair[0] !== s.chain.at(-1)[1]) pair.reverse();
    }
    if (a.end === "left") s.chain.unshift(pair);
    else s.chain.push(pair);
    s.hands[seat].splice(s.hands[seat].indexOf(tile), 1);
    s.passes = 0;
  }
  if (!s.hands[seat].length || s.passes >= (s.active?.filter(Boolean).length || s.hands.length)) dominoScore(s, now);
  else {
    do {
      s.turn = (s.turn + 1) % s.hands.length;
    } while (s.active?.[s.turn] === false);
    s.deadline = now + 6e4;
  }
}
function dominoView(s, seat) {
  return { phase: s.phase, turn: s.turn, chain: s.chain, hand: seat >= 0 ? s.hands[seat] : [], counts: s.hands.map((h) => h.length), boneyard: s.boneyard.length, scores: s.scores, round: s.round, roundResult: s.roundResult, legal: s.phase === "turn" && seat === s.turn ? dominoLegal(s, seat) : [], mode: s.mode };
}
function ludoStart(n, now) {
  return { phase: "roll", deadline: now + 6e4, result: null, tokens: Array.from({ length: n }, () => [-1, -1, -1, -1]), turn: 0, die: 0, sixes: 0, rolls: 0 };
}
var ludoNext = (s, seat) => {
  let p = seat;
  do {
    p = (p + 1) % s.tokens.length;
  } while (s.active?.[p] === false);
  return p;
};
var ludoOffset = (s, seat) => s.tokens.length === 2 ? seat * 26 : seat * 13;
var safe = /* @__PURE__ */ new Set([0, 8, 13, 21, 26, 34, 39, 47]);
var ludoLegal = (s) => s.tokens[s.turn].flatMap((v, i) => (v === -1 ? s.die === 6 : v < 56 && v + s.die <= 56) ? [i] : []);
function ludoAction(s, seat, a, now, roll) {
  insist(seat === s.turn, "Wait for your turn.");
  if (a.type === "roll") {
    insist(s.phase === "roll");
    s.die = roll();
    s.rolls++;
    s.sixes = s.die === 6 ? s.sixes + 1 : 0;
    if (s.sixes === 3) {
      s.turn = ludoNext(s, seat);
      s.sixes = 0;
      s.phase = "roll";
    } else if (ludoLegal(s).length) s.phase = "move";
    else {
      s.turn = ludoNext(s, seat);
      s.sixes = 0;
    }
  } else {
    insist(a.type === "token" && s.phase === "move");
    const token2 = integer(a.piece, 0, 3);
    insist(ludoLegal(s).includes(token2), "That token cannot move.");
    let value = s.tokens[seat][token2];
    value = value === -1 ? 0 : value + s.die;
    s.tokens[seat][token2] = value;
    if (value < 51) {
      const cell = (value + ludoOffset(s, seat)) % 52;
      if (!safe.has(cell)) s.tokens.forEach((hand, p) => {
        if (p !== seat) hand.forEach((v, i) => {
          if (v >= 0 && v < 51 && (v + ludoOffset(s, p)) % 52 === cell) hand[i] = -1;
        });
      });
    }
    if (s.tokens[seat].every((v) => v === 56)) {
      s.result = `Player ${seat + 1} wins`;
      s.phase = "ended";
      s.winner = seat;
    } else {
      s.phase = "roll";
      if (s.die !== 6) {
        s.turn = ludoNext(s, seat);
        s.sixes = 0;
      }
    }
  }
  s.deadline = s.result ? 0 : now + 6e4;
}

// apps/api/src/games/poker.ts
function rankFive(cards) {
  const ranks = cards.map((c) => c % 13 + 2).sort((a, b) => b - a), counts = /* @__PURE__ */ new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]), flush = cards.every((c) => Math.floor(c / 13) === Math.floor(cards[0] / 13));
  const unique = [...new Set(ranks)], straight = unique.length === 5 ? unique[0] - unique[4] === 4 ? unique[0] : unique.join(",") === "14,5,4,3,2" ? 5 : 0 : 0;
  if (flush && straight) return [8, straight];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...ranks];
  if (straight) return [4, straight];
  if (groups[0][1] === 3) return [3, groups[0][0], ...groups.slice(1).map((g) => g[0])];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, Math.max(groups[0][0], groups[1][0]), Math.min(groups[0][0], groups[1][0]), groups[2][0]];
  if (groups[0][1] === 2) return [1, groups[0][0], ...groups.slice(1).map((g) => g[0])];
  return [0, ...ranks];
}
function compareRank(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
}
function rankHand(cards) {
  insist(cards.length >= 5 && cards.length <= 7 && new Set(cards).size === cards.length);
  let best = [];
  for (let a = 0; a < cards.length - 4; a++) for (let b = a + 1; b < cards.length - 3; b++) for (let c = b + 1; c < cards.length - 2; c++) for (let d = c + 1; d < cards.length - 1; d++) for (let e = d + 1; e < cards.length; e++) {
    const rank = rankFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
    if (compareRank(rank, best) > 0) best = rank;
  }
  return best;
}
var live = (s) => s.stack.map((chips, i) => chips > 0 && !s.departed[i] ? i : -1).filter((i) => i >= 0);
var minimumRaise = (s) => s.bet < s.blind ? s.blind : s.bet + s.lastRaise;
function after(s, p, available) {
  for (let i = 1; i <= s.stack.length; i++) {
    const q = (p + i) % s.stack.length;
    if (available.includes(q)) return q;
  }
  return -1;
}
function pay(s, p, amount) {
  const paid = Math.min(s.stack[p], amount);
  s.stack[p] -= paid;
  s.street[p] += paid;
  s.committed[p] += paid;
}
function log(s, message) {
  s.log.push(message);
  s.log = s.log.slice(-60);
}
function finishHand(s, now, showdown) {
  const contenders = s.stack.map((_, i) => !s.folded[i] ? i : -1).filter((i) => i >= 0), levels = [...new Set(s.committed)].filter((n) => n > 0).sort((a, b) => a - b);
  let previous = 0;
  const payouts = Array(s.stack.length).fill(0), ranks = /* @__PURE__ */ new Map();
  if (showdown) for (const p of contenders) ranks.set(p, rankHand([...s.holes[p], ...s.board]));
  const pots = [];
  for (const level of levels) {
    const contributors = s.committed.map((n, i) => n >= level ? i : -1).filter((i) => i >= 0), amount = (level - previous) * contributors.length;
    previous = level;
    let eligible = contributors.filter((i) => contenders.includes(i));
    if (contributors.length === 1) {
      payouts[contributors[0]] += amount;
      continue;
    }
    if (!eligible.length) {
      for (const p2 of contributors) payouts[p2] += amount / contributors.length;
      continue;
    }
    if (showdown) {
      let best = ranks.get(eligible[0]);
      for (const p2 of eligible) if (compareRank(ranks.get(p2), best) > 0) best = ranks.get(p2);
      eligible = eligible.filter((p2) => compareRank(ranks.get(p2), best) === 0);
    }
    const share = Math.floor(amount / eligible.length);
    for (const p2 of eligible) payouts[p2] += share;
    let odd = amount - share * eligible.length, p = s.dealer;
    while (odd--) {
      p = after(s, p, eligible);
      payouts[p]++;
    }
    pots.push({ amount, winners: eligible });
  }
  s.stack = s.stack.map((n, i) => n + payouts[i]);
  s.payouts = payouts;
  s.pots = pots;
  s.showdown = showdown;
  s.phase = "between";
  s.deadline = now + 3e5;
  s.turn = -1;
  s.handResult = payouts.map((v, i) => v ? `Player ${i + 1}: +${v}` : "").filter(Boolean).join(" \xB7 ");
  if (live(s).length <= 1) {
    s.phase = "ended";
    s.result = live(s).length ? `Player ${live(s)[0] + 1} wins` : "Table closed";
    s.deadline = 0;
  }
}
function advance(s, now) {
  const contenders = s.stack.map((_, i) => !s.folded[i] ? i : -1).filter((i) => i >= 0);
  if (contenders.length <= 1) {
    finishHand(s, now, false);
    return;
  }
  const able = contenders.filter((i) => s.stack[i] > 0), needed = able.filter((i) => !s.acted[i] || s.street[i] < s.bet);
  if (needed.length && (able.length > 1 || s.street[able[0]] < s.bet)) {
    s.turn = after(s, s.turn, needed);
    s.deadline = now + 3e4;
    return;
  }
  if (s.board.length === 5) {
    finishHand(s, now, true);
    return;
  }
  s.deck.pop();
  const count = s.board.length === 0 ? 3 : 1;
  for (let i = 0; i < count; i++) s.board.push(s.deck.pop());
  s.street.fill(0);
  s.acted.fill(false);
  s.reopen.fill(0);
  s.bet = 0;
  s.lastRaise = s.blind;
  if (able.length <= 1) {
    advance(s, now);
    return;
  }
  s.turn = after(s, s.dealer, able);
  s.deadline = now + 3e4;
}
function pokerHand(s, now) {
  const seats = live(s);
  insist(seats.length >= 2, "Two players with chips are required.");
  s.dealer = after(s, s.dealer, seats);
  s.hand = (s.hand || 0) + 1;
  s.deck = shuffle(Array.from({ length: 52 }, (_, i) => i));
  s.holes = s.stack.map(() => []);
  s.board = [];
  s.folded = s.stack.map((chips, i) => chips === 0 || s.departed[i]);
  s.street = s.stack.map(() => 0);
  s.committed = s.stack.map(() => 0);
  s.acted = s.stack.map(() => false);
  s.reopen = s.stack.map(() => 0);
  s.log = [];
  s.pots = [];
  s.payouts = [];
  s.showdown = false;
  s.handResult = null;
  s.phase = "betting";
  s.result = null;
  let p = s.dealer;
  for (let round = 0; round < 2; round++) for (let i = 0; i < seats.length; i++) {
    p = after(s, p, seats);
    s.holes[p].push(s.deck.pop());
  }
  const small = seats.length === 2 ? s.dealer : after(s, s.dealer, seats), big = after(s, small, seats);
  pay(s, small, Math.floor(s.blind / 2));
  pay(s, big, s.blind);
  s.bet = s.blind;
  s.lastRaise = s.blind;
  s.turn = big;
  s.deadline = now + 3e4;
  advance(s, now);
}
function pokerStart(n, settings, now) {
  const s = { phase: "between", deadline: 0, result: null, stack: Array(n).fill(settings.chips), departed: Array(n).fill(false), blind: settings.blind, dealer: -1, hand: 0 };
  pokerHand(s, now);
  return s;
}
function pokerJoin(s, settings, index = s.stack.length) {
  insist(s.phase === "between");
  s.stack[index] = settings.chips;
  s.departed[index] = false;
  s.holes[index] = [];
  s.folded[index] = true;
  s.street[index] = 0;
  s.committed[index] = 0;
  s.acted[index] = false;
  s.reopen[index] = 0;
  s.payouts[index] = 0;
}
function pokerAction(s, seat, a, now) {
  if (a.type === "next") {
    insist(s.phase === "between");
    pokerHand(s, now);
    return;
  }
  insist(s.phase === "betting" && s.turn === seat && !s.folded[seat] && s.stack[seat] > 0, "Wait for your turn.");
  const owed = Math.max(0, s.bet - s.street[seat]);
  if (a.type === "fold") {
    s.folded[seat] = true;
    log(s, `Player ${seat + 1} folded`);
  } else if (a.type === "check") {
    insist(owed === 0, "Call or fold.");
    log(s, `Player ${seat + 1} checked`);
  } else if (a.type === "call") {
    insist(owed > 0, "You can check.");
    pay(s, seat, owed);
    log(s, `Player ${seat + 1} called`);
  } else {
    insist(a.type === "raise");
    const to = integer(a.to, s.bet + 1, s.street[seat] + s.stack[seat]);
    insist(!s.acted[seat] || s.bet >= s.reopen[seat], "A short all-in did not reopen raising.");
    const increase = s.bet < s.blind ? to : to - s.bet, full = to >= minimumRaise(s);
    insist(full || to === s.street[seat] + s.stack[seat], "Raise at least the minimum, or go all-in.");
    pay(s, seat, to - s.street[seat]);
    s.bet = to;
    if (full) {
      s.lastRaise = increase;
      s.acted.fill(false);
    }
    log(s, `Player ${seat + 1} raised to ${to}`);
  }
  s.acted[seat] = true;
  s.reopen[seat] = s.bet + s.lastRaise;
  advance(s, now);
}
function pokerView(s, seat) {
  const own = seat >= 0, acting = own && s.phase === "betting" && s.turn === seat, call = acting ? Math.max(0, s.bet - s.street[seat]) : 0;
  return {
    phase: s.phase,
    stack: s.stack,
    departed: s.departed,
    board: s.board,
    holes: s.holes.map((h, i) => i === seat || s.showdown && !s.folded[i] ? h : h.map(() => -1)),
    folded: s.folded,
    street: s.street,
    committed: s.committed,
    dealer: s.dealer,
    turn: s.turn,
    hand: s.hand,
    blind: s.blind,
    bet: s.bet,
    pots: s.pots,
    payouts: s.payouts,
    handResult: s.handResult,
    log: s.log,
    controls: acting ? { call: Math.min(call, s.stack[seat]), canCheck: call === 0, canRaise: s.street[seat] + s.stack[seat] > s.bet && (!s.acted[seat] || s.bet >= s.reopen[seat]), minRaise: minimumRaise(s), maxRaise: s.street[seat] + s.stack[seat] } : null
  };
}
function pokerTimeout(s, now) {
  pokerAction(s, s.turn, { type: s.street[s.turn] >= s.bet ? "check" : "fold" }, now);
}
function pokerDepart(s, seat, now) {
  s.departed[seat] = true;
  s.folded[seat] = true;
  if (s.phase === "betting" && (s.turn === seat || s.folded.filter((v) => !v).length <= 1)) advance(s, now);
  else if (s.phase === "between" && live(s).length < 2) {
    s.phase = "ended";
    s.result = live(s).length ? `Player ${live(s)[0] + 1} wins` : "Table closed";
    s.deadline = 0;
  }
}

// apps/api/src/games/party.ts
function drawingTurn(s, settings, now) {
  while (s.round < s.order.length && s.active?.[s.order[s.round]] === false) s.round++;
  if (s.round >= s.order.length) {
    s.phase = "ended";
    s.result = "Drawing rounds complete";
    s.deadline = 0;
    return;
  }
  s.drawer = s.order[s.round];
  s.word = s.words[s.round % s.words.length];
  s.picture = freshPicture();
  s.guessed = [];
  s.guesses = [];
  s.phase = "drawing";
  s.token = `draw-${s.round}`;
  s.started = now;
  s.deadline = now + settings.seconds * 1e3;
}
function drawingStart(n, settings, now) {
  const s = { phase: "drawing", deadline: 0, result: null, round: 0, order: Array.from({ length: settings.rounds }, () => Array.from({ length: n }, (_, i) => i)).flat(), words: words(settings), scores: Array(n).fill(0) };
  drawingTurn(s, settings, now);
  return s;
}
function drawingReveal(s, now) {
  s.phase = "reveal";
  s.token = `reveal-${s.round}`;
  s.deadline = now + 5e3;
}
function drawingAction(s, seat, a, settings, now) {
  insist(s.phase === "drawing" && a.token === s.token, "The drawing round has changed.");
  if (a.type === "stroke" || a.type === "clear") {
    insist(seat === s.drawer, "Only the drawer can draw.");
    if (a.type === "clear") s.picture = freshPicture();
    else stroke(s.picture, a.stroke);
  } else {
    insist(a.type === "guess" && seat !== s.drawer && !s.guessed.includes(seat), "Wait for the next drawing.");
    const answer = text(a.text, 80), correct = normalizeAnswer(answer) === normalizeAnswer(s.word);
    if (correct) {
      s.guessed.push(seat);
      s.scores[seat] += Math.max(20, 100 - Math.floor((now - s.started) / 1e3));
      s.scores[s.drawer] += 10;
      s.guesses.push({ seat, correct: true });
      if (s.guessed.length === (s.active?.filter(Boolean).length || s.scores.length) - 1) drawingReveal(s, now);
    } else s.guesses.push({ seat, text: answer, correct: false });
    s.guesses = s.guesses.slice(-30);
  }
}
function drawingTick(s, settings, now) {
  if (s.phase === "drawing") drawingReveal(s, now);
  else if (s.phase === "reveal") {
    s.round++;
    drawingTurn(s, settings, now);
  }
}
function drawingView(s, seat) {
  const reveal = s.phase !== "drawing" || seat === s.drawer || s.guessed.includes(seat);
  return { phase: s.phase, token: s.token, round: s.round + 1, total: s.order.length, drawer: s.drawer, word: reveal ? s.word : null, wordLength: Array.from(s.word).length, picture: s.picture, scores: s.scores, guesses: s.guesses, guessed: s.guessed };
}
function phoneAdvance(s, settings, now) {
  const n = s.albums.length;
  for (let seat = 0; seat < n; seat++) {
    const chain = (seat - s.step + n) % n;
    const entry = s.step % 2 ? { author: seat, type: "picture", picture: s.pictures[seat] } : { author: seat, type: "text", text: s.answers[seat] || "\u2026" };
    s.albums[chain].push(entry);
  }
  s.step++;
  s.done = Array.from({ length: n }, (_, i) => s.active?.[i] === false ? i : -1).filter((i) => i >= 0);
  s.answers = {};
  s.pictures = Array.from({ length: n }, freshPicture);
  if (s.step >= n) {
    s.phase = "reveal";
    s.deadline = 0;
    s.result = "Albums ready";
  } else {
    s.phase = s.step % 2 ? "draw" : "describe";
    s.token = `phone-${s.step}`;
    s.deadline = now + settings.seconds * 1e3;
  }
}
function phoneStart(n, settings, now) {
  return { phase: "write", deadline: now + settings.seconds * 1e3, result: null, step: 0, token: "phone-0", albums: Array.from({ length: n }, () => []), done: [], answers: {}, pictures: Array.from({ length: n }, freshPicture) };
}
function phoneAction(s, seat, a, settings, now) {
  insist(s.phase !== "reveal" && a.token === s.token && !s.done.includes(seat), "This page has already been submitted.");
  if (a.type === "stroke" || a.type === "clear") {
    insist(s.phase === "draw");
    if (a.type === "clear") s.pictures[seat] = freshPicture();
    else stroke(s.pictures[seat], a.stroke);
  } else {
    insist(a.type === "submit");
    if (s.phase !== "draw") s.answers[seat] = text(a.text);
    s.done.push(seat);
    if (s.done.length === s.albums.length) phoneAdvance(s, settings, now);
  }
}
function phoneTick(s, settings, now) {
  phoneAdvance(s, settings, now);
}
function phoneView(s, seat) {
  if (s.phase === "reveal") return { phase: s.phase, step: s.step, total: s.albums.length, albums: s.albums, done: s.done };
  const chain = seat >= 0 ? (seat - s.step + s.albums.length) % s.albums.length : -1, previous = chain >= 0 ? s.albums[chain].at(-1) : null;
  return { phase: s.phase, token: s.token, step: s.step, total: s.albums.length, done: s.done, previous: previous?.type === "text" ? { type: "text", text: previous.text } : previous ? { type: "picture", picture: previous.picture } : null, picture: seat >= 0 ? s.pictures[seat] : null, submitted: seat >= 0 && s.done.includes(seat) };
}
function teamCaptain(team, n) {
  return Array.from({ length: n }, (_, i) => i).find((i) => i % 2 === team);
}
function wordsStart(n, settings, now) {
  const team = shuffle([0, 1])[0], roles = shuffle([...Array(9).fill(team), ...Array(8).fill(1 - team), ...Array(7).fill(2), 3]);
  return { phase: "clue", deadline: now + settings.seconds * 1e3, result: null, team, captains: [teamCaptain(0, n), teamCaptain(1, n)], board: words(settings).slice(0, 25), roles, revealed: Array(25).fill(false), clue: null, guesses: 0, history: [], turns: 0, token: "words-0" };
}
function switchTeam(s, settings, now) {
  s.team = 1 - s.team;
  s.phase = "clue";
  s.clue = null;
  s.guesses = 0;
  s.turns++;
  s.token = `words-${s.turns}`;
  s.deadline = now + settings.seconds * 1e3;
  if (s.turns >= 100) {
    s.phase = "ended";
    s.result = "Round limit reached";
    s.deadline = 0;
  }
}
function wordsAction(s, seat, a, settings, now) {
  insist(seat % 2 === s.team, "It is the other team\u2019s turn.");
  if (a.type === "clue") {
    insist(s.phase === "clue" && s.captains[s.team] === seat, "Only your captain can give a clue.");
    const clue = text(a.text, 40);
    insist(!/\s/.test(clue), "Use a single word for the clue.");
    insist(!s.board.some((w, i) => !s.revealed[i] && normalizeAnswer(w) === normalizeAnswer(clue)), "Do not use an unrevealed board word.");
    const count = integer(a.count, 1, 9);
    s.clue = { text: clue, count };
    s.guesses = count + 1;
    s.phase = "guess";
    s.deadline = now + settings.seconds * 1e3;
    s.history.push({ team: s.team, text: clue, count });
    s.history = s.history.slice(-40);
  } else {
    insist(s.phase === "guess" && s.captains[s.team] !== seat, "Guessers choose the words.");
    if (a.type === "pass") {
      switchTeam(s, settings, now);
      return;
    }
    insist(a.type === "word");
    const i = integer(a.index, 0, 24);
    insist(!s.revealed[i], "That word is already revealed.");
    s.revealed[i] = true;
    s.guesses--;
    if (s.roles[i] === 3) {
      s.result = `Team ${2 - s.team} wins`;
      s.phase = "ended";
      s.deadline = 0;
      return;
    }
    for (const team of [0, 1]) if (s.roles.every((role, i2) => role !== team || s.revealed[i2])) {
      s.result = `Team ${team + 1} wins`;
      s.phase = "ended";
      s.deadline = 0;
      return;
    }
    if (s.roles[i] !== s.team || s.guesses === 0) switchTeam(s, settings, now);
  }
}
function wordsTick(s, settings, now) {
  switchTeam(s, settings, now);
}
function wordsView(s, seat) {
  const captain = s.captains.includes(seat);
  return { phase: s.phase, token: s.token, team: s.team, captains: s.captains, board: s.board, roles: s.roles.map((r, i) => captain || s.revealed[i] || s.phase === "ended" ? r : null), revealed: s.revealed, clue: s.clue, guesses: s.guesses, history: s.history, remaining: [0, 1].map((team) => s.roles.filter((r, i) => r === team && !s.revealed[i]).length) };
}

// apps/api/src/games/engine.ts
function startEngine(kind, n, settings, now) {
  const state = kind === "poker" ? pokerStart(n, settings, now) : kind === "domino" ? dominoStart(n, settings, now) : kind === "four" ? fourStart(now) : kind === "ludo" ? ludoStart(n, now) : kind === "drawing" ? drawingStart(n, settings, now) : kind === "telephone" ? phoneStart(n, settings, now) : wordsStart(n, settings, now);
  state.active = Array(n).fill(true);
  return state;
}
function act(kind, s, seat, a, settings, now) {
  insist(a && typeof a.type === "string");
  if (kind === "poker") pokerAction(s, seat, a, now);
  else if (kind === "domino") dominoAction(s, seat, a, now);
  else if (kind === "four") fourAction(s, seat, a, now);
  else if (kind === "ludo") ludoAction(s, seat, a, now, () => randomInt2(1, 7));
  else if (kind === "drawing") drawingAction(s, seat, a, settings, now);
  else if (kind === "telephone") phoneAction(s, seat, a, settings, now);
  else wordsAction(s, seat, a, settings, now);
}
function project(kind, s, seat) {
  if (kind === "poker") return pokerView(s, seat);
  if (kind === "domino") return dominoView(s, seat);
  if (kind === "drawing") return drawingView(s, seat);
  if (kind === "telephone") return phoneView(s, seat);
  if (kind === "words") return wordsView(s, seat);
  if (kind === "four") return { phase: s.phase, board: s.board, turn: s.turn, winner: s.winner };
  return { phase: s.phase, tokens: s.tokens, turn: s.turn, die: s.die, offsets: s.tokens.map((_, i) => ludoOffset(s, i)), legal: seat === s.turn && s.phase === "move" ? ludoLegal(s) : [] };
}
function timeout(kind, s, settings, now) {
  if (kind === "drawing") drawingTick(s, settings, now);
  else if (kind === "telephone") phoneTick(s, settings, now);
  else if (kind === "words") wordsTick(s, settings, now);
  else if (kind === "poker" && s.phase === "betting") pokerTimeout(s, now);
  else {
    s.phase = "ended";
    s.result = "Game ended after inactivity";
    s.deadline = 0;
  }
}
function depart(kind, s, seat, settings, now) {
  s.active[seat] = false;
  const remaining = s.active.flatMap((v, i) => v ? [i] : []);
  if (kind === "poker") {
    pokerDepart(s, seat, now);
    return;
  }
  if (remaining.length < 2) {
    s.phase = "ended";
    s.result = remaining.length ? `Player ${remaining[0] + 1} wins by departure` : "Game closed";
    s.deadline = 0;
    return;
  }
  if (kind === "drawing") {
    if (s.drawer === seat && s.phase === "drawing") drawingTick(s, settings, now);
  } else if (kind === "telephone") {
    if (!s.done.includes(seat)) s.done.push(seat);
    if (s.done.length === s.albums.length) phoneTick(s, settings, now);
  } else if (kind === "words") {
    const team = seat % 2, teamSeats = remaining.filter((i) => i % 2 === team);
    if (teamSeats.length < 2) {
      s.phase = "ended";
      s.result = `Team ${2 - team} wins by departure`;
      s.deadline = 0;
    } else if (s.captains[team] === seat) s.captains[team] = teamSeats[0];
  } else if (kind === "domino") {
    s.boneyard.push(...s.hands[seat]);
    s.hands[seat] = [];
    if (s.turn === seat) {
      s.turn = remaining.find((i) => i > seat) ?? remaining[0];
      s.deadline = now + 6e4;
    }
  } else if (kind === "ludo") {
    s.tokens[seat] = [-1, -1, -1, -1];
    if (s.turn === seat) {
      s.turn = remaining.find((i) => i > seat) ?? remaining[0];
      s.phase = "roll";
      s.sixes = 0;
      s.deadline = now + 6e4;
    }
  }
}

// apps/api/src/games/service.ts
var kinds = ["poker", "domino", "telephone", "drawing", "words", "ludo", "four"];
var settingsSchema = z4.object({ maxPlayers: z4.number().int().min(2).max(8), seconds: z4.union([z4.literal(45), z4.literal(60), z4.literal(90)]).default(60), rounds: z4.number().int().min(1).max(3).default(1), language: z4.enum(["en", "fa"]).default("en"), domino: z4.enum(["draw", "block"]).default("draw"), chips: z4.union([z4.literal(1e3), z4.literal(2e3)]).default(1e3), blind: z4.union([z4.literal(10), z4.literal(20), z4.literal(50)]).default(20) }).strict();
var gameCreate = z4.object({ requestId: z4.string().uuid(), channelId: z4.string().min(1).max(100), kind: z4.enum(kinds), settings: settingsSchema }).strict().refine((b) => b.settings.maxPlayers >= definition(b.kind).min && b.settings.maxPlayers <= definition(b.kind).max, "Choose a valid player limit.");
var action = z4.object({ type: z4.enum(["drop", "tile", "draw", "pass", "next", "roll", "token", "fold", "check", "call", "raise", "stroke", "clear", "guess", "submit", "clue", "word"]), token: z4.string().max(40).optional(), piece: z4.number().int().min(0).max(3).optional(), column: z4.number().int().min(0).max(6).optional(), tile: z4.number().int().min(0).max(27).optional(), end: z4.enum(["left", "right"]).optional(), to: z4.number().int().min(0).max(1e6).optional(), index: z4.number().int().min(0).max(24).optional(), count: z4.number().int().min(1).max(9).optional(), text: z4.string().max(180).optional(), stroke: z4.object({ color: z4.string().max(7), width: z4.number().int(), points: z4.array(z4.tuple([z4.number().int().min(0).max(1e3), z4.number().int().min(0).max(1e3)])).min(1).max(100) }).strict().optional() }).strict();
var gameCommand = z4.object({ requestId: z4.string().uuid(), revision: z4.number().int().positive(), kind: z4.enum(["join", "start", "leave", "close", "action"]), action: action.optional() }).strict();
var activeSeats = (g) => g.seats.filter((s) => !s.left);
async function arcadeBusy(tx, uid, except = "") {
  return Boolean(await tx.one("SELECT p.user_id FROM game_players p JOIN game_sessions g ON g.id=p.game_id WHERE p.user_id=? AND g.status<>'finished' AND g.id<>?", [uid, except]));
}
var GameService = class {
  constructor(service) {
    this.service = service;
  }
  service;
  active = /* @__PURE__ */ new Map();
  timer;
  closed = false;
  rates = /* @__PURE__ */ new Map();
  epoch = Date.now();
  monotonic = performance.now();
  now = () => this.epoch + performance.now() - this.monotonic;
  online = () => true;
  notify = async () => {
  };
  onError = () => {
  };
  async initialize() {
    for (const row of await this.service.db.all("SELECT state FROM game_sessions WHERE status<>'finished'")) {
      const g = JSON.parse(row.state);
      if (g.status === "playing") {
        const now = this.now();
        g.pauseStarted = g.pauseStarted ? Math.min(g.pauseStarted, now) : now;
        for (const seat of activeSeats(g)) {
          if (seat.missingAt) seat.grace = Math.max(0, seat.grace - Math.max(0, now - seat.missingAt));
          seat.missingAt = now;
        }
        g.pausedUntil = Math.min(...activeSeats(g).map((s) => now + s.grace));
        g.revision++;
        await this.save(this.service.db, g);
      }
      this.active.set(g.id, g);
    }
    this.schedule();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.active.clear();
    this.rates.clear();
  }
  async requireVoice(tx, uid, channelId) {
    const channel = await this.service.channel(tx, uid, channelId);
    if (channel.kind !== "voice" || !await tx.one("SELECT user_id FROM voice_members WHERE user_id=? AND channel_id=?", [uid, channelId])) fail(403, "VOICE_REQUIRED", "Join this voice channel to play or watch.");
    return channel;
  }
  async allowed(tx, uid, g) {
    await this.service.member(tx, uid, g.serverId);
    if (!g.seats.some((s) => s.id === uid && !s.left)) await this.requireVoice(tx, uid, g.channelId);
  }
  async load(tx, id2) {
    const row = await tx.one("SELECT state FROM game_sessions WHERE id=?", [id2]);
    if (!row) fail(404, "NOT_FOUND", "Game not found.");
    return JSON.parse(row.state);
  }
  async save(tx, g, roster = false) {
    g.updatedAt = this.now();
    const state = JSON.stringify(g);
    if (Buffer.byteLength(state, "utf8") > 768 * 1024) fail(413, "CAPACITY", "This game has reached its drawing limit.");
    await tx.run("INSERT INTO game_sessions(id,server_id,channel_id,host_id,kind,status,updated_at,state) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET host_id=excluded.host_id,status=excluded.status,updated_at=excluded.updated_at,state=excluded.state", [g.id, g.serverId, g.channelId, g.hostId, g.kind, g.status, g.updatedAt, state]);
    if (roster) {
      await tx.run("DELETE FROM game_players WHERE game_id=?", [g.id]);
      for (const seat of activeSeats(g)) await tx.run("INSERT INTO game_players(game_id,user_id) VALUES(?,?)", [g.id, seat.id]);
    }
  }
  summary(g, uid) {
    return { id: g.id, channelId: g.channelId, kind: g.kind, hostId: g.hostId, hostName: g.hostName, status: g.status, players: activeSeats(g).length, maxPlayers: g.settings.maxPlayers, minPlayers: definition(g.kind).min, paused: Boolean(g.pausedUntil), seated: g.seats.some((s) => s.id === uid && !s.left) };
  }
  joinable(g) {
    return g.status === "waiting" || g.status === "playing" && g.kind === "poker" && g.state?.phase === "between";
  }
  async list(uid, channelId) {
    await this.requireVoice(this.service.db, uid, channelId);
    const rows = await this.service.db.all("SELECT state FROM game_sessions WHERE channel_id=? AND status<>'finished' ORDER BY updated_at DESC LIMIT 60", [channelId]);
    return rows.map((r) => this.summary(JSON.parse(r.state), uid));
  }
  async get(uid, id2) {
    await this.tickId(id2);
    return this.service.db.transaction(async (tx) => {
      const g = await this.load(tx, id2);
      await this.allowed(tx, uid, g);
      const self = g.seats.findIndex((s) => s.id === uid && !s.left), inVoice = Boolean(await tx.one("SELECT user_id FROM voice_members WHERE user_id=? AND channel_id=?", [uid, g.channelId]));
      return { ...this.summary(g, uid), revision: g.revision, seats: g.seats, settings: g.settings, self, canPlay: self < 0 && inVoice && !g.pausedUntil && this.joinable(g) && activeSeats(g).length < g.settings.maxPlayers, canStart: g.status === "waiting" && uid === g.hostId && inVoice && !g.pausedUntil && activeSeats(g).length >= definition(g.kind).min, deadline: g.status === "waiting" ? g.createdAt + 6e5 : g.state?.deadline || 0, serverNow: this.now(), pausedUntil: g.pausedUntil, result: g.result, state: g.state ? project(g.kind, g.state, self) : { phase: "lobby" } };
    });
  }
  async free(tx, uid, except = "") {
    if (await arcadeBusy(tx, uid, except) || await tx.one("SELECT id FROM chess_games WHERE status<>'finished' AND (white_id=? OR black_id=?)", [uid, uid])) fail(409, "CAPACITY", "Finish or leave your existing game first.");
  }
  async create(uid, b) {
    const result = await this.service.mutate(uid, b.requestId, "game.create", b, async (tx) => {
      const channel = await this.requireVoice(tx, uid, b.channelId);
      await this.free(tx, uid);
      const total = await tx.one("SELECT (SELECT COUNT(*) FROM game_sessions WHERE status<>'finished')+(SELECT COUNT(*) FROM chess_games WHERE status<>'finished') AS n");
      if (Number(total.n) >= 60) fail(409, "CAPACITY", "The game limit is reached. Try again later.");
      const user = await tx.one("SELECT display_name FROM users WHERE id=?", [uid]), now = this.now();
      const g = { id: randomUUID2(), serverId: channel.server_id, channelId: b.channelId, hostId: uid, hostName: user.display_name, kind: b.kind, settings: b.settings, seats: [{ id: uid, name: user.display_name, left: false, grace: 3e4, missingAt: 0 }], status: "waiting", revision: 1, createdAt: now, updatedAt: now, pausedUntil: 0, pauseStarted: 0, result: null, state: null };
      await tx.run("DELETE FROM game_sessions WHERE id IN (SELECT id FROM game_sessions WHERE status='finished' ORDER BY updated_at DESC LIMIT 10000 OFFSET 99)");
      await this.save(tx, g, true);
      return { id: g.id };
    });
    await this.changed(result.id);
    await this.reconcileVoice();
    return this.get(uid, result.id);
  }
  async command(uid, id2, b) {
    const now = this.now(), rate = this.rates.get(uid);
    if (!rate || now - rate.at > 1e3) this.rates.set(uid, { at: now, count: 1 });
    else if (++rate.count > 20) fail(429, "RATE_LIMIT", "Slow down a little.");
    await this.tickId(id2);
    const result = await this.service.mutate(uid, b.requestId, "game.command", { id: id2, ...b }, async (tx) => {
      const g = await this.load(tx, id2);
      await this.allowed(tx, uid, g);
      if (g.status === "finished") fail(409, "GAME_FINISHED", "This game has ended.");
      const concurrent = (g.kind === "drawing" || g.kind === "telephone") && b.kind === "action" && b.action?.token === g.state?.token;
      if (g.revision !== b.revision && !concurrent) fail(409, "STALE_GAME", "The game changed. Review the latest state.");
      let roster = false;
      let seat = g.seats.findIndex((s) => s.id === uid && !s.left);
      if (!["leave", "close"].includes(b.kind)) await this.requireVoice(tx, uid, g.channelId);
      if (b.kind === "join") {
        if (seat >= 0) fail(409, "SEAT_TAKEN", "You already have a seat.");
        if (!this.joinable(g) || g.pausedUntil || activeSeats(g).length >= g.settings.maxPlayers) fail(409, "SEAT_TAKEN", "Seats are unavailable now. You can keep watching.");
        await this.free(tx, uid, id2);
        for (const p of activeSeats(g)) if (await tx.one("SELECT user_id FROM user_blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)", [uid, p.id, p.id, uid])) fail(403, "FORBIDDEN", "This game is unavailable.");
        const user = await tx.one("SELECT display_name FROM users WHERE id=?", [uid]);
        seat = g.seats.findIndex((s) => s.left);
        if (seat < 0) seat = g.seats.length;
        g.seats[seat] = { id: uid, name: user.display_name, left: false, grace: 3e4, missingAt: 0 };
        if (g.state) {
          pokerJoin(g.state, g.settings, seat);
          g.state.active[seat] = true;
        }
        roster = true;
      } else {
        if (seat < 0) fail(403, "FORBIDDEN", "Spectators cannot change a game.");
        if (b.kind === "close") {
          if (g.hostId !== uid || g.status !== "waiting") fail(403, "FORBIDDEN", "Only the host can close the waiting game.");
          g.status = "finished";
          g.result = "Lobby closed";
        } else if (b.kind === "leave") {
          this.remove(g, seat, this.now());
          this.reconcilePause(g, this.now());
          roster = true;
        } else if (b.kind === "start") {
          if (g.hostId !== uid || g.status !== "waiting" || g.pausedUntil || activeSeats(g).length < definition(g.kind).min) fail(409, "NOT_READY", "Wait for enough players to join.");
          for (const p of activeSeats(g)) await this.requireVoice(tx, p.id, g.channelId);
          g.seats = g.seats.filter((s) => !s.left);
          g.state = startEngine(g.kind, g.seats.length, g.settings, this.now());
          g.status = "playing";
          roster = true;
        } else {
          if (g.status !== "playing" || g.pausedUntil) fail(409, "PAUSED", "Wait for the players to return to voice.");
          if (b.action?.type === "next" && uid !== g.hostId) fail(403, "FORBIDDEN", "Only the host can start the next round.");
          try {
            act(g.kind, g.state, seat, b.action, g.settings, this.now());
          } catch (e) {
            fail(400, "INVALID_MOVE", e instanceof Error ? e.message : "That action is unavailable.");
          }
          this.complete(g);
        }
      }
      g.revision++;
      await this.save(tx, g, roster);
      const canvas = b.kind === "action" && b.action && ["stroke", "clear"].includes(b.action.type) ? { id: id2, revision: g.revision, serverNow: this.now(), token: b.action.token, seat, requestId: b.requestId, type: b.action.type, ...b.action.stroke ? { stroke: b.action.stroke } : {} } : void 0;
      return { id: id2, ...canvas ? { canvas } : {} };
    });
    await this.changed(result.id, result.canvas);
    if (b.kind === "join" || b.kind === "start") await this.reconcileVoice();
    return b.kind === "leave" ? { left: true, id: id2 } : this.get(uid, result.id);
  }
  complete(g) {
    if (g.state?.result) {
      g.status = "finished";
      g.result = g.state.result;
      g.pausedUntil = 0;
    }
  }
  remove(g, seat, now) {
    const person = g.seats[seat];
    person.left = true;
    person.missingAt = 0;
    if (g.state) {
      const previous = g.state.deadline;
      depart(g.kind, g.state, seat, g.settings, now);
      if (g.pauseStarted && g.state.deadline !== previous) g.pauseStarted = now;
    }
    this.complete(g);
    const remaining = activeSeats(g);
    if (!remaining.length) {
      g.status = "finished";
      g.result = "Game closed";
      g.pausedUntil = 0;
    } else if (person.id === g.hostId) {
      const host = remaining.find((s) => !s.missingAt) || remaining[0];
      g.hostId = host.id;
      g.hostName = host.name;
    }
  }
  reconcilePause(g, now) {
    const absent = activeSeats(g).filter((s) => s.missingAt);
    g.pausedUntil = absent.length ? Math.min(...absent.map((s) => s.missingAt + s.grace)) : 0;
    if (!g.pausedUntil && g.pauseStarted) {
      const elapsed = now - g.pauseStarted;
      if (g.state?.deadline) g.state.deadline += elapsed;
      if (g.state?.started) g.state.started += elapsed;
      g.pauseStarted = 0;
    } else if (g.pausedUntil && !g.pauseStarted) g.pauseStarted = now;
  }
  async reconcileVoice() {
    if (!this.active.size) return;
    const voice = new Map((await this.service.db.all("SELECT user_id,channel_id FROM voice_members")).map((r) => [r.user_id, r.channel_id]));
    for (const cached of [...this.active.values()]) {
      await this.tickId(cached.id);
      const g = this.active.get(cached.id);
      if (!g) continue;
      if (activeSeats(g).some((s) => (voice.get(s.id) === g.channelId && this.online(s.id)) === Boolean(s.missingAt))) {
        await this.service.db.transaction(async (tx) => {
          const row = await tx.one("SELECT state FROM game_sessions WHERE id=?", [g.id]);
          if (!row) return;
          const current = JSON.parse(row.state);
          if (current.status === "finished") return;
          const now = this.now();
          for (const s of activeSeats(current)) {
            const present = voice.get(s.id) === current.channelId && this.online(s.id);
            if (present && s.missingAt) {
              s.grace = Math.max(0, s.grace - (now - s.missingAt));
              s.missingAt = 0;
            } else if (!present && !s.missingAt) s.missingAt = now;
          }
          this.reconcilePause(current, now);
          current.revision++;
          await this.save(tx, current);
        });
        await this.changed(g.id);
      }
    }
  }
  deadline(g) {
    return g.status === "waiting" ? Math.min(g.createdAt + 6e5, g.pausedUntil || Infinity) : g.pausedUntil || g.state?.deadline || g.updatedAt + 72e5;
  }
  async changed(id2, canvas) {
    if (this.closed) return;
    const row = await this.service.db.one("SELECT state FROM game_sessions WHERE id=?", [id2]);
    if (!row) {
      const removed = this.active.get(id2);
      this.active.delete(id2);
      if (removed) await this.notify({ ...removed, status: "finished" }, true).catch(this.onError);
      this.schedule();
      return;
    }
    const g = JSON.parse(row.state), previous = this.active.get(id2);
    const directoryChanged = !previous || g.status !== previous.status || g.hostId !== previous.hostId || activeSeats(g).map((s) => s.id).join() !== activeSeats(previous).map((s) => s.id).join() || Boolean(g.pausedUntil) !== Boolean(previous.pausedUntil) || g.kind === "poker" && g.state?.phase === "between" !== (previous.state?.phase === "between");
    if (g.status === "finished") this.active.delete(id2);
    else this.active.set(id2, g);
    await this.notify(g, directoryChanged, canvas).catch(this.onError);
    this.schedule();
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.closed || !this.active.size) return;
    const nearest = Math.min(...[...this.active.values()].map((g) => this.deadline(g)));
    this.timer = setTimeout(() => {
      void this.tick().catch((e) => {
        this.onError(e);
        if (!this.closed) {
          this.timer = setTimeout(() => this.schedule(), 1e3);
          this.timer.unref();
        }
      });
    }, Math.max(1, Math.min(2147483647, nearest - this.now())));
    this.timer.unref();
  }
  async tickId(id2) {
    const cached = this.active.get(id2);
    if (!cached || this.deadline(cached) > this.now()) return;
    const changed = await this.service.db.transaction(async (tx) => {
      const row = await tx.one("SELECT state FROM game_sessions WHERE id=?", [id2]);
      if (!row) return true;
      const g = JSON.parse(row.state), now = this.now();
      if (g.status === "finished" || this.deadline(g) > now) return false;
      let roster = false;
      if (g.status === "waiting" && now >= g.createdAt + 6e5) {
        g.status = "finished";
        g.result = "Lobby expired";
      } else if (g.pausedUntil) {
        for (let i = 0; i < g.seats.length; i++) {
          const s = g.seats[i];
          if (!s.left && s.missingAt && now >= s.missingAt + s.grace) {
            this.remove(g, i, now);
            roster = true;
          }
        }
        this.reconcilePause(g, now);
      } else if (g.state) {
        timeout(g.kind, g.state, g.settings, now);
        this.complete(g);
      }
      g.revision++;
      await this.save(tx, g, roster);
      return true;
    });
    if (changed) await this.changed(id2);
  }
  async tick() {
    for (const id2 of [...this.active.keys()]) await this.tickId(id2);
    this.schedule();
  }
};

// apps/api/src/chess.ts
var chessCreate = z5.object({ requestId: z5.string().uuid(), serverId: z5.string().min(1).max(100), channelId: z5.string().min(1).max(100).optional(), openSeat: z5.literal(true).optional(), opponentId: z5.string().min(1).max(100).optional(), difficulty: z5.enum(["Easy", "Medium", "Hard"]).optional(), mode: z5.enum(["standard", "elixer"]), minutes: z5.union([z5.literal(3), z5.literal(5), z5.literal(10), z5.literal(15)]), increment: z5.union([z5.literal(0), z5.literal(2), z5.literal(5), z5.literal(10)]) }).strict().refine((b) => [b.opponentId, b.difficulty, b.openSeat].filter(Boolean).length === 1 && (!b.openSeat || Boolean(b.channelId)) && (!b.channelId || !b.opponentId), "Choose an open voice seat or AI");
var chessCommand = z5.object({ requestId: z5.string().uuid(), revision: z5.number().int().positive(), kind: z5.enum(["join", "accept", "decline", "cancel", "action", "resign", "offerDraw", "acceptDraw", "declineDraw", "claimDraw"]), action: z5.object({ from: z5.number().int().min(0).max(63).optional(), to: z5.number().int().min(0).max(63), buy: z5.enum(["p", "n", "b", "r", "q"]).optional(), promotion: z5.enum(["q", "r", "b", "n"]).optional() }).strict().optional() }).strict();
var winner = (color, reason) => `${color === 0 ? "White" : "Black"} wins by ${reason}`;
function chargeClock(g, now) {
  if (g.status !== "playing" || g.pausedUntil) return;
  const color = g.position.turn;
  g.remaining[color] = Math.max(0, g.remaining[color] - Math.max(0, now - g.runningSince));
  g.runningSince = now;
  if (!g.remaining[color]) {
    g.status = "finished";
    g.result = g.position.mode === "standard" && !canMateOnTimeout(g.position, 1 - color) ? "Draw by insufficient material" : winner(1 - color, "timeout");
  }
}
function chooseAi(s, difficulty) {
  const actions = legalActions(s);
  if (!actions.length) return;
  if (difficulty === "Easy") return actions[Math.floor(Math.random() * actions.length)];
  const values = { ...costs, k: 100 }, color = s.turn, deadline = performance.now() + 8;
  const evaluate = (p) => p.board.reduce((score2, piece) => score2 + (piece ? (piece === piece.toUpperCase() ? 1 : -1) * values[piece.toLowerCase()] : 0), 0) * (color === 0 ? 1 : -1) + (p.coins[color] - p.coins[1 - color]) * 0.12;
  const ranked = actions.map((a) => ({ a, hint: (a.buy ? 0.2 : values[s.board[a.to]?.toLowerCase()] || 0) + (a.promotion ? 8 : 0) })).sort((a, b) => b.hint - a.hint);
  let best = ranked[0].a, score = -Infinity, searched = 0;
  for (const { a } of ranked) {
    if (performance.now() > deadline && searched) break;
    const next = advanceLegalAction(s, a);
    let value = evaluate(next) + (inCheck(next) ? 0.3 : 0);
    if (difficulty === "Hard" && searched < 12) {
      const replies = legalActions(next).sort((a2, b) => (values[next.board[b.to]?.toLowerCase()] || 0) - (values[next.board[a2.to]?.toLowerCase()] || 0)).slice(0, 12);
      for (const reply of replies) {
        if (performance.now() > deadline) break;
        value = Math.min(value, evaluate(advanceLegalAction(next, reply)));
      }
    }
    if (value > score) {
      score = value;
      best = a;
    }
    searched++;
  }
  return best;
}
var ChessService = class {
  constructor(service) {
    this.service = service;
  }
  service;
  active = /* @__PURE__ */ new Map();
  timer;
  closed = false;
  epoch = Date.now();
  monotonic = performance.now();
  now = () => this.epoch + performance.now() - this.monotonic;
  notify = async () => {
  };
  online = () => true;
  onError = () => {
  };
  async initialize() {
    const rows = await this.service.db.all("SELECT state FROM chess_games WHERE status<>'finished'");
    for (const row of rows) {
      const g = JSON.parse(row.state);
      if (g.status === "playing") {
        const now = this.now();
        this.expire(g, now);
        if (g.status === "playing") {
          g.missing = [g.whiteId, ...g.blackId ? [g.blackId] : []];
          g.missingAt = Object.fromEntries(g.missing.map((id2) => [id2, now]));
          g.pausedUntil = now + 3e4;
          g.runningSince = now;
        }
        g.revision++;
        await this.save(this.service.db, g);
      }
      if (g.status !== "finished") this.active.set(g.id, g);
    }
    this.schedule();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
  async allowed(tx, uid, g) {
    await this.service.member(tx, uid, g.serverId);
    const ids = [g.whiteId, ...g.blackId ? [g.blackId] : []];
    for (const id2 of ids) await this.service.member(tx, id2, g.serverId);
    if (g.channelId && uid !== g.whiteId && uid !== g.blackId) await this.requireVoice(tx, uid, g.channelId);
  }
  async requireVoice(tx, uid, channelId) {
    const channel = await this.service.channel(tx, uid, channelId);
    if (channel.kind !== "voice" || !await tx.one("SELECT user_id FROM voice_members WHERE user_id=? AND channel_id=?", [uid, channelId])) fail(403, "VOICE_REQUIRED", "Join this voice channel to play or watch.");
    return channel;
  }
  async load(tx, id2) {
    const row = await tx.one("SELECT state FROM chess_games WHERE id=?", [id2]);
    if (!row) fail(404, "NOT_FOUND", "Chess match not found.");
    return JSON.parse(row.state);
  }
  async save(tx, g) {
    g.updatedAt = this.now();
    await tx.run("INSERT INTO chess_games(id,server_id,white_id,black_id,status,updated_at,state,channel_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET black_id=excluded.black_id,channel_id=excluded.channel_id,status=excluded.status,updated_at=excluded.updated_at,state=excluded.state", [g.id, g.serverId, g.whiteId, g.blackId, g.status, g.updatedAt, JSON.stringify(g), g.channelId || null]);
  }
  async get(uid, id2) {
    return this.service.db.transaction(async (tx) => {
      const g = await this.load(tx, id2);
      await this.allowed(tx, uid, g);
      const now = this.now();
      const view = structuredClone(g);
      chargeClock(view, now);
      const ownTurn = (view.position.turn === 0 ? view.whiteId : view.blackId) === uid;
      const inVoice = !g.channelId || Boolean(await tx.one("SELECT user_id FROM voice_members WHERE user_id=? AND channel_id=?", [uid, g.channelId]));
      return { ...view, serverNow: now, actions: view.status === "playing" && !view.pausedUntil && ownTurn && inVoice ? legalActions(view.position) : [], canPlay: Boolean(g.openSeat && g.status === "pending" && !g.blackId && uid !== g.whiteId && inVoice && !g.pausedUntil), check: inCheck(view.position), canClaimDraw: view.position.mode === "standard" && (view.position.half >= 100 || repetitionCount(view.position) >= 3) };
    });
  }
  async voiceGames(uid, channelId) {
    return this.service.db.transaction(async (tx) => {
      const channel = await this.requireVoice(tx, uid, channelId);
      const rows = await tx.all("SELECT state FROM chess_games WHERE status<>'finished' AND (channel_id=? OR (channel_id IS NULL AND server_id=? AND (white_id=? OR black_id=?))) ORDER BY updated_at DESC LIMIT 60", [channelId, channel.server_id, uid, uid]);
      return rows.map((r) => JSON.parse(r.state)).map((g) => ({ id: g.id, channelId, hostName: g.whiteName, whiteId: g.whiteId, blackId: g.blackId, status: g.status, openSeat: Boolean(g.openSeat && !g.blackId && g.status === "pending"), mode: g.position.mode, minutes: g.minutes, increment: g.increment, paused: Boolean(g.pausedUntil), legacy: !g.channelId }));
    });
  }
  async list(uid, serverId) {
    await this.service.member(this.service.db, uid, serverId);
    const rows = await this.service.db.all("SELECT state FROM chess_games WHERE server_id=? ORDER BY updated_at DESC LIMIT 30", [serverId]);
    return rows.map((r) => JSON.parse(r.state)).map(({ id: id2, whiteId, blackId, whiteName, blackName, status, position, minutes, increment, result }) => ({ id: id2, whiteId, blackId, whiteName, blackName, status, mode: position.mode, minutes, increment, result }));
  }
  async create(uid, b) {
    const result = await this.service.mutate(uid, b.requestId, "chess.create", b, async (tx) => {
      if (await arcadeBusy(tx, uid)) fail(409, "CAPACITY", "Finish or leave your existing game first.");
      if (b.channelId) {
        const channel = await this.requireVoice(tx, uid, b.channelId);
        if (channel.server_id !== b.serverId) fail(400, "INVALID_REQUEST", "The game must use your current voice channel.");
        if (await tx.one("SELECT id FROM chess_games WHERE white_id=? AND channel_id IS NOT NULL AND status<>'finished'", [uid])) fail(409, "CAPACITY", "Open your existing game or close it before creating another.");
      }
      const names = [];
      for (const userId of [uid, ...b.opponentId ? [b.opponentId] : []]) {
        await this.service.member(tx, userId, b.serverId);
        const row = await tx.one("SELECT display_name FROM users WHERE id=?", [userId]);
        names.push(row.display_name);
      }
      if (b.opponentId === uid) fail(400, "INVALID_REQUEST", "Choose another player.");
      if (b.opponentId && await tx.one("SELECT user_id FROM user_blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)", [uid, b.opponentId, b.opponentId, uid])) fail(403, "FORBIDDEN", "This challenge is unavailable.");
      const active = await tx.one("SELECT COUNT(*) AS n FROM chess_games WHERE status='playing' AND (white_id=? OR black_id=?)", [uid, uid]);
      const pending = await tx.one("SELECT COUNT(*) AS n FROM chess_games WHERE status='pending' AND (white_id=? OR black_id=?)", [uid, uid]);
      const total = await tx.one("SELECT (SELECT COUNT(*) FROM chess_games WHERE status<>'finished')+(SELECT COUNT(*) FROM game_sessions WHERE status<>'finished') AS n");
      if (Number(active.n) >= 1 || Number(pending.n) >= 3 || Number(total.n) >= 60) fail(409, "CAPACITY", "Finish your current game or pending challenges first.");
      const now = this.now(), g = { channelId: b.channelId || null, openSeat: Boolean(b.openSeat), id: randomUUID3(), serverId: b.serverId, whiteId: uid, blackId: b.opponentId || null, whiteName: names[0], blackName: names[1] || (b.openSeat ? "Open seat" : `${b.difficulty} AI`), difficulty: b.difficulty || null, status: b.opponentId || b.openSeat ? "pending" : "playing", position: initialPosition(b.mode), revision: 1, minutes: b.minutes, increment: b.increment, remaining: [b.minutes * 6e4, b.minutes * 6e4], runningSince: now, pausedUntil: 0, missing: [], missingAt: {}, grace: [3e4, 3e4], result: null, drawBy: null, createdAt: now, updatedAt: now, log: [] };
      await tx.run("DELETE FROM chess_games WHERE id IN (SELECT id FROM chess_games WHERE status='finished' ORDER BY updated_at DESC LIMIT 10000 OFFSET 999)");
      await this.save(tx, g);
      return { id: g.id };
    });
    await this.changed(result.id);
    if (b.channelId) await this.presence(uid, this.online(uid));
    return this.get(uid, result.id);
  }
  async command(uid, id2, b) {
    const result = await this.service.mutate(uid, b.requestId, "chess.command", { id: id2, ...b }, async (tx) => {
      const g = await this.load(tx, id2);
      await this.allowed(tx, uid, g);
      const joining = b.kind === "join" && g.openSeat && g.status === "pending" && !g.blackId && uid !== g.whiteId;
      if (b.kind === "join" && !joining) fail(409, "SEAT_TAKEN", "The seat is no longer open. You can keep watching.");
      if (!joining && uid !== g.whiteId && uid !== g.blackId) fail(403, "FORBIDDEN", "Spectators cannot change a match.");
      if (g.revision !== b.revision) fail(409, "STALE_GAME", "The board changed. Review the latest position.");
      const now = this.now();
      this.expire(g, now);
      if (g.status === "finished") fail(409, "GAME_FINISHED", "The match has ended.");
      if (g.channelId && !["resign", "cancel"].includes(b.kind)) await this.requireVoice(tx, uid, g.channelId);
      if (g.status === "pending") {
        if (joining) {
          if (g.pausedUntil) fail(409, "PAUSED", "Waiting for the host to return to voice.");
          await this.requireVoice(tx, g.whiteId, g.channelId);
          if (await tx.one("SELECT user_id FROM user_blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)", [uid, g.whiteId, g.whiteId, uid])) fail(403, "FORBIDDEN", "This challenge is unavailable.");
          if (await arcadeBusy(tx, uid) || await arcadeBusy(tx, g.whiteId)) fail(409, "CAPACITY", "A player already has an active game.");
          for (const player of [uid, g.whiteId]) if (await tx.one("SELECT id FROM chess_games WHERE id<>? AND (white_id=? OR black_id=?) AND (status='playing' OR (status='pending' AND channel_id IS NOT NULL))", [id2, player, player])) fail(409, "CAPACITY", "A player already has an active match.");
          const user = await tx.one("SELECT display_name FROM users WHERE id=?", [uid]);
          g.blackId = uid;
          g.blackName = user.display_name;
          g.openSeat = false;
          g.status = "playing";
          g.runningSince = now;
        } else if (b.kind === "accept" && uid === g.blackId) {
          if (!this.online(g.whiteId) || !this.online(g.blackId)) fail(409, "OFFLINE", "Both players must be online to start.");
          if (await arcadeBusy(tx, uid) || await arcadeBusy(tx, g.whiteId)) fail(409, "CAPACITY", "A player already has an active game.");
          for (const player of [g.whiteId, g.blackId]) if (await tx.one("SELECT id FROM chess_games WHERE status='playing' AND (white_id=? OR black_id=?)", [player, player])) fail(409, "CAPACITY", "A player already has an active match.");
          g.status = "playing";
          g.runningSince = now;
        } else if (b.kind === "decline" && uid === g.blackId || b.kind === "cancel" && uid === g.whiteId) {
          g.status = "finished";
          g.result = "Challenge cancelled";
        } else fail(400, "INVALID_REQUEST", "Accept, decline or cancel this challenge first.");
      } else if (b.kind === "resign") {
        g.status = "finished";
        g.result = winner(uid === g.whiteId ? 1 : 0, "resignation");
      } else {
        if (g.pausedUntil) fail(409, "PAUSED", "Waiting for reconnection.");
        chargeClock(g, now);
        if (b.kind === "action") {
          if ((g.position.turn === 0 ? g.whiteId : g.blackId) !== uid) fail(403, "WRONG_TURN", "Wait for your turn.");
          if (!b.action) fail(400, "INVALID_REQUEST", "Choose a move.");
          this.move(g, b.action);
        } else if (b.kind === "offerDraw") {
          if (g.drawBy) fail(409, "DRAW_PENDING", "A draw offer is already pending.");
          g.drawBy = uid;
        } else if (b.kind === "acceptDraw" && g.drawBy && g.drawBy !== uid) {
          g.status = "finished";
          g.result = "Draw by agreement";
        } else if (b.kind === "declineDraw" && g.drawBy && g.drawBy !== uid) g.drawBy = null;
        else if (b.kind === "claimDraw" && (g.position.turn === 0 ? g.whiteId : g.blackId) === uid && g.position.mode === "standard" && (g.position.half >= 100 || repetitionCount(g.position) >= 3)) {
          g.status = "finished";
          g.result = "Draw claimed by rule";
        } else fail(400, "INVALID_REQUEST", "That match action is unavailable.");
      }
      g.revision++;
      await this.save(tx, g);
      return { id: id2 };
    });
    await this.changed(result.id);
    if (b.kind === "join") await this.reconcileVoice();
    return this.get(uid, result.id);
  }
  move(g, a) {
    const color = g.position.turn;
    try {
      g.position = applyAction(g.position, a);
    } catch {
      fail(400, "ILLEGAL_MOVE", "That move or purchase is not legal.");
    }
    g.remaining[color] += g.increment * 1e3;
    g.drawBy = null;
    g.log.push(a.buy ? `${a.buy.toUpperCase()} @ ${squareName(a.to)}` : `${squareName(a.from)}\u2013${squareName(a.to)}${a.promotion ? "=" + a.promotion.toUpperCase() : ""}`);
    const result = outcome(g.position);
    if (result) {
      g.status = "finished";
      g.result = result;
    }
  }
  expire(g, now) {
    if (g.status === "pending" && (now >= g.createdAt + (g.openSeat ? 6e5 : 12e4) || g.pausedUntil && now >= g.pausedUntil)) {
      g.status = "finished";
      g.result = "Challenge expired";
    }
    if (g.status !== "playing") return;
    if (g.pausedUntil && now >= g.pausedUntil) {
      g.status = "finished";
      g.result = g.missing.length > 1 ? "Draw after both players disconnected" : winner(g.missing[0] === g.whiteId ? 1 : 0, "disconnection");
    } else chargeClock(g, now);
  }
  async presence(uid, online) {
    const ids = [...this.active.values()].filter((g) => (g.status === "playing" || g.status === "pending" && g.channelId) && (g.whiteId === uid || g.blackId === uid)).map((g) => g.id);
    for (const id2 of ids) {
      const changed = await this.service.db.transaction(async (tx) => {
        const row = await tx.one("SELECT state FROM chess_games WHERE id=?", [id2]);
        if (!row) {
          this.active.delete(id2);
          return false;
        }
        const g = JSON.parse(row.state), now = this.now();
        if (g.status === "finished") return false;
        const present = online && (!g.channelId || Boolean(await tx.one("SELECT user_id FROM voice_members WHERE user_id=? AND channel_id=?", [uid, g.channelId])));
        this.expire(g, now);
        const color = uid === g.whiteId ? 0 : 1;
        if (present && g.missing.includes(uid)) {
          g.grace[color] = Math.max(0, g.grace[color] - (now - g.missingAt[uid]));
          g.missing = g.missing.filter((v) => v !== uid);
          delete g.missingAt[uid];
        } else if (!present && !g.missing.includes(uid)) {
          g.missing.push(uid);
          g.missingAt[uid] = now;
        } else return false;
        g.pausedUntil = g.missing.length ? Math.min(...g.missing.map((v) => g.missingAt[v] + g.grace[v === g.whiteId ? 0 : 1])) : 0;
        if (!g.pausedUntil) g.runningSince = now;
        this.expire(g, now);
        g.revision++;
        await this.save(tx, g);
        return true;
      });
      if (changed) await this.changed(id2);
    }
  }
  async reconcileVoice() {
    const games = [...this.active.values()].filter((g) => g.channelId);
    if (!games.length) return;
    const voice = new Map((await this.service.db.all("SELECT user_id,channel_id FROM voice_members")).map((r) => [r.user_id, r.channel_id]));
    for (const g of games) for (const uid of [g.whiteId, ...g.blackId ? [g.blackId] : []]) {
      const present = voice.get(uid) === g.channelId && this.online(uid);
      if (present === g.missing.includes(uid)) await this.presence(uid, present);
    }
  }
  async changed(id2) {
    if (this.closed) return;
    const row = await this.service.db.one("SELECT state FROM chess_games WHERE id=?", [id2]);
    if (!row) {
      this.active.delete(id2);
      this.schedule();
      return;
    }
    const g = JSON.parse(row.state);
    const previous = this.active.get(id2);
    const directoryChanged = !previous || previous.status !== g.status || previous.blackId !== g.blackId || Boolean(previous.pausedUntil) !== Boolean(g.pausedUntil);
    if (g.status === "finished") this.active.delete(id2);
    else this.active.set(id2, g);
    await this.notify(g, directoryChanged).catch(this.onError);
    this.schedule();
    if (g.status === "playing" && !g.pausedUntil && g.difficulty && !g.blackId && g.position.turn === 1) setImmediate(() => {
      if (!this.closed) void this.bot(id2, g.revision).catch(this.onError);
    });
  }
  async bot(id2, revision) {
    await this.service.db.transaction(async (tx) => {
      const g = await this.load(tx, id2);
      if (g.revision !== revision || g.status !== "playing" || g.pausedUntil || !g.difficulty || g.blackId || g.position.turn !== 1) return;
      const now = this.now();
      this.expire(g, now);
      if (g.status === "playing") {
        const a = chooseAi(g.position, g.difficulty);
        if (a) {
          chargeClock(g, this.now());
          if (g.status === "playing") this.move(g, a);
        }
      }
      g.revision++;
      await this.save(tx, g);
    });
    await this.changed(id2);
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.closed || !this.active.size) return;
    const deadline = Math.min(...[...this.active.values()].map((g) => g.status === "pending" ? Math.min(g.createdAt + (g.openSeat ? 6e5 : 12e4), g.pausedUntil || Infinity) : g.pausedUntil || g.runningSince + g.remaining[g.position.turn]));
    this.timer = setTimeout(() => {
      void this.tick().catch((e) => {
        this.onError(e);
        if (!this.closed) {
          this.timer = setTimeout(() => {
            this.schedule();
          }, 1e3);
          this.timer.unref();
        }
      });
    }, Math.max(1, Math.ceil(deadline - this.now())));
    this.timer.unref();
  }
  async tick() {
    for (const id2 of [...this.active.keys()]) {
      const changed = await this.service.db.transaction(async (tx) => {
        const row = await tx.one("SELECT state FROM chess_games WHERE id=?", [id2]);
        if (!row) {
          this.active.delete(id2);
          return false;
        }
        const g = JSON.parse(row.state);
        this.expire(g, this.now());
        if (g.status !== "finished") return false;
        g.revision++;
        await this.save(tx, g);
        return true;
      });
      if (changed) await this.changed(id2);
    }
    this.schedule();
  }
};

// apps/api/src/app.ts
async function createApp(c = config(), options = {}) {
  const logging = options.logger ?? !process.env.VITEST;
  const app2 = Fastify({ logger: logging ? { serializers: { req: (req) => ({ method: req.method, url: String(req.url).split("?")[0], hostname: req.hostname, remoteAddress: req.ip }) } } : false, bodyLimit: 128 * 1024, trustProxy: c.trustedProxies.length ? c.trustedProxies : false, requestTimeout: 9e5, connectionTimeout: 3e4 });
  await mkdir2(c.dataDir, { recursive: true });
  const lockPath = path3.join(c.dataDir, "instance.lock");
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
  const db = await openDatabase(c), service = new Service(db, c), sfu = new Sfu(c, service), attachments = new Attachments(service);
  const chess = new ChessService(service);
  chess.onError = (e) => app2.log.error({ err: e }, "Chess task failed");
  await chess.initialize();
  const games = new GameService(service);
  games.onError = (e) => app2.log.error({ err: e }, "Game task failed");
  await games.initialize();
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  const realtime = { actions: {}, disconnects: {}, maintenance: { passes: 0, maxMs: 0, maxTimerDelayMs: 0 } };
  app2.addHook("onClose", async () => {
    eventLoop.disable();
  });
  await attachments.initialize();
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM voice_members");
    await tx.run("UPDATE coordinators SET user_id=NULL,epoch=epoch+1,expires_at=0");
  });
  const avatarDir = path3.join(c.dataDir, "avatars");
  await mkdir2(avatarDir, { recursive: true });
  async function storageStatus() {
    const databaseBytes = c.databaseUrl ? null : Number((await db.one("PRAGMA page_count")).page_count) * Number((await db.one("PRAGMA page_size")).page_size);
    let avatarBytes = 0;
    for (const name of await readdir(avatarDir)) avatarBytes += (await stat3(path3.join(avatarDir, name))).size;
    const databaseBudgetBytes = c.maxDatabaseMiB * 1048576, avatarBudgetBytes = c.maxAvatarsMiB * 1048576;
    const warnings = [];
    if (databaseBytes !== null && databaseBytes >= databaseBudgetBytes * 0.8) warnings.push("Database is at least 80% of its page budget. Prune data or migrate storage.");
    if (avatarBytes >= avatarBudgetBytes * 0.8) warnings.push("Avatar storage is at least 80% of its budget.");
    return { databaseBytes, databaseBudgetBytes: c.databaseUrl ? null : databaseBudgetBytes, avatarBytes, avatarBudgetBytes, warnings };
  }
  await app2.register(cookie);
  const allowed = (origin) => !origin || c.origins.includes(origin);
  await app2.register(cors, { origin: (origin, cb) => cb(null, allowed(origin)), credentials: true, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "X-Request-Id", "X-Dorham-Native", "Range"], exposedHeaders: ["Content-Range", "Accept-Ranges", "Content-Length"] });
  await app2.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:", "blob:"], connectSrc: ["'self'", "https:", "wss:", ...c.production ? [] : ["http:", "ws:"]], mediaSrc: ["'self'", "blob:"], objectSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginEmbedderPolicy: false });
  await app2.register(rateLimit, { global: options.rateLimit !== false, max: 600, timeWindow: "1 minute", keyGenerator: async (req) => {
    const raw = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : req.cookies.dorham_session;
    const identity = raw ? await resolveSession(raw) : void 0;
    return identity ? `account:${identity.account.id}` : `source:${req.ip}`;
  } });
  if (options.rateLimit !== false) {
    const sourceBudget = app2.createRateLimit({ max: 6e3, timeWindow: "1 minute", keyGenerator: (req) => `source-budget:${req.ip}` });
    app2.addHook("onRequest", async (req, reply) => {
      const limit = await sourceBudget(req);
      if (!limit.isAllowed && limit.isExceeded) return reply.header("Retry-After", limit.ttlInSeconds).code(429).send({ error: { code: "RATE_LIMIT", message: "Too many requests from this address." } });
    });
  }
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
    if (req.url.startsWith("/api/") || req.url.startsWith("/internal/")) reply.header("Cache-Control", "no-store");
  });
  async function resolveSession(raw) {
    if (!raw || raw.length > 512) return void 0;
    const session = await db.one("SELECT * FROM sessions WHERE access_hash=? AND access_expires>=? AND expires_at>=?", [hash(raw), Date.now(), Date.now()]);
    if (!session) return void 0;
    const account = await db.one("SELECT * FROM users WHERE id=?", [session.user_id]);
    return account && !account.banned ? { session, account } : void 0;
  }
  async function authenticate(req, _reply) {
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : void 0;
    let resolved = await resolveSession(bearer || req.cookies.dorham_session);
    const mediaPath = /^\/api\/v1\/attachments\/([0-9a-f-]{36})\/media$/.exec(req.url.split("?")[0]);
    const mediaTicket = req.query?.media_ticket;
    if (mediaPath && ["GET", "HEAD"].includes(req.method) && mediaTicket !== void 0) {
      resolved = void 0;
      const sessionId = attachments.media.resolveTicket(mediaTicket, mediaPath[1]);
      const session = sessionId ? await db.one("SELECT * FROM sessions WHERE id=? AND expires_at>?", [sessionId, Date.now()]) : void 0;
      const account = session ? await db.one("SELECT * FROM users WHERE id=? AND banned=0", [session.user_id]) : void 0;
      if (session && account) resolved = { session, account };
    }
    if (!resolved) fail(401, "UNAUTHENTICATED", "Please sign in.");
    req.account = resolved.account;
    req.session = resolved.session;
    if (req.account.must_change_password && !["/api/v1/auth/me", "/api/v1/auth/password", "/api/v1/auth/logout"].includes(req.url.split("?")[0])) fail(403, "PASSWORD_CHANGE_REQUIRED", "Change your temporary password before continuing.");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !bearer) {
      if (!req.headers.origin || !allowed(req.headers.origin) || !equal(String(req.headers["x-csrf-token"] || ""), req.session.csrf)) fail(403, "CSRF", "Refresh your session and retry.");
    }
  }
  const setCookie = (reply, access) => reply.setCookie("dorham_session", access, { httpOnly: true, secure: c.secure, sameSite: "lax", path: "/", maxAge: 30 * 86400 });
  async function sessionFor(userId, native, reply, device = "Unknown device") {
    const access = token(), refresh = native ? token() : null, csrf = token(), now = Date.now();
    await db.transaction(async (tx) => {
      const old = await tx.all("SELECT id FROM sessions WHERE user_id=? ORDER BY created_at DESC", [userId]);
      for (const s of old.slice(2)) await tx.run("DELETE FROM sessions WHERE id=?", [s.id]);
      await tx.run("INSERT INTO sessions(id,user_id,access_hash,refresh_hash,csrf,native,access_expires,expires_at,created_at,device_name,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?)", [randomUUID4(), userId, hash(access), refresh ? hash(refresh) : null, csrf, Number(native), now + (native ? 15 * 6e4 : 30 * 864e5), now + 30 * 864e5, now, device.slice(0, 160), now]);
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
  app2.get("/api/v1/config", async () => ({ registrationOpen: c.registrationOpen, mediaTransport: c.mediaTransport, publicUrl: c.publicUrl, guestsEnabled: c.guestsEnabled }));
  const authRate = options.rateLimit === false ? {} : { rateLimit: { max: 60, timeWindow: "15 minutes", keyGenerator: (req) => req.ip } };
  const accountAttempts = /* @__PURE__ */ new Map();
  app2.addHook("preHandler", async (req) => {
    if (options.rateLimit === false || req.method !== "POST" || !["/api/v1/auth/login", "/api/v1/auth/register", "/api/v1/auth/recover"].includes(req.url.split("?")[0])) return;
    const username = req.body?.username;
    if (typeof username !== "string" || username.length > 32) return;
    const key = hash(username.toLowerCase()), now = Date.now();
    let item = accountAttempts.get(key);
    if (!item || item.until < now) {
      item = { count: 0, until: now + 15 * 6e4 };
      if (accountAttempts.size >= 1e3) accountAttempts.delete(accountAttempts.keys().next().value);
      accountAttempts.set(key, item);
    }
    if (++item.count > 60) fail(429, "RATE_LIMIT", "Too many authentication attempts. Try again later.");
  });
  app2.post("/api/v1/auth/register", { config: authRate }, async (req, reply) => {
    if (!c.registrationOpen) fail(403, "REGISTRATION_CLOSED", "Registration is closed.");
    const body = registerSchema.parse(req.body), username = body.username.toLowerCase();
    const encoded = await passwordHash(body.password);
    const userId = await db.transaction(async (tx) => {
      const count = await tx.one("SELECT COUNT(*) AS count FROM users");
      if (count.count >= c.maxUsers) fail(409, "ACCOUNT_LIMIT", "This instance has reached its account limit.");
      if (await tx.one("SELECT id FROM users WHERE username=?", [username])) fail(409, "USERNAME_TAKEN", "This username is unavailable.");
      const userId2 = randomUUID4();
      await tx.run("INSERT INTO users(id,username,display_name,password_hash,created_at,language) VALUES(?,?,?,?,?,?)", [userId2, username, body.displayName, encoded, Date.now(), body.language || ""]);
      return userId2;
    });
    await service.notify("state:changed", {});
    return reply.code(201).send(await sessionFor(userId, req.headers["x-dorham-native"] === "1", reply, String(req.headers["user-agent"] || "Unknown device")));
  });
  app2.post("/api/v1/auth/login", { config: authRate }, async (req, reply) => {
    const body = credentialsSchema.extend({ requestId }).parse(req.body);
    const user = await db.one("SELECT * FROM users WHERE username=?", [body.username.toLowerCase()]);
    if (!user || user.guest || user.banned) {
      await passwordHash(body.password);
      fail(401, "INVALID_CREDENTIALS", "Username or password is incorrect.");
    }
    if (!await passwordVerify(user.password_hash, body.password)) fail(401, "INVALID_CREDENTIALS", "Username or password is incorrect.");
    return sessionFor(user.id, req.headers["x-dorham-native"] === "1", reply, String(req.headers["user-agent"] || "Unknown device"));
  });
  app2.post("/api/v1/auth/refresh", { config: authRate }, async (req) => {
    const body = z6.object({ refreshToken: z6.string().min(20).max(512), requestId }).parse(req.body), fingerprint = hash(body.refreshToken);
    const outcome2 = await db.transaction(async (tx) => {
      const reused = await tx.one("SELECT session_id FROM used_refresh WHERE hash=?", [fingerprint]);
      if (reused) {
        await tx.run("DELETE FROM sessions WHERE id=?", [reused.session_id]);
        return null;
      }
      const old = await tx.one("SELECT * FROM sessions WHERE refresh_hash=? AND native=1 AND expires_at>=?", [fingerprint, Date.now()]);
      if (!old) return null;
      if (!await tx.one("SELECT id FROM users WHERE id=? AND banned=0", [old.user_id])) return null;
      const accessToken = token(), refreshToken = token();
      await tx.run("INSERT INTO used_refresh(hash,session_id,expires_at) VALUES(?,?,?)", [fingerprint, old.id, old.expires_at]);
      await tx.run("UPDATE sessions SET access_hash=?,refresh_hash=?,access_expires=?,expires_at=?,last_seen=? WHERE id=?", [hash(accessToken), hash(refreshToken), Date.now() + 15 * 6e4, Date.now() + 30 * 864e5, Date.now(), old.id]);
      return { accessToken, refreshToken, csrf: old.csrf };
    });
    if (!outcome2) fail(401, "REFRESH_INVALID", "Session expired. Sign in again.");
    return outcome2;
  });
  publicAccountRoutes(app2, service, authRate, sessionFor, disconnectInvalidSessions);
  await app2.register(async (api) => {
    api.addHook("preHandler", authenticate);
    protectedAccountRoutes(api, service, disconnectInvalidSessions);
    api.get("/games", async (req) => {
      const channelId = id.parse(req.query.channelId);
      return { games: await games.list(req.account.id, channelId), chess: await chess.voiceGames(req.account.id, channelId) };
    });
    api.post("/games", { bodyLimit: 16384 }, async (req) => games.create(req.account.id, gameCreate.parse(req.body)));
    api.get("/games/:id", async (req) => games.get(req.account.id, id.parse(req.params.id)));
    api.post("/games/:id", { bodyLimit: 16384 }, async (req) => games.command(req.account.id, id.parse(req.params.id), gameCommand.parse(req.body)));
    api.get("/chess", async (req) => {
      const q = req.query;
      return { games: q.channelId ? await chess.voiceGames(req.account.id, id.parse(q.channelId)) : await chess.list(req.account.id, id.parse(q.serverId)) };
    });
    api.post("/chess", async (req) => chess.create(req.account.id, chessCreate.parse(req.body)));
    api.get("/chess/:id", async (req) => chess.get(req.account.id, id.parse(req.params.id)));
    api.post("/chess/:id", async (req) => chess.command(req.account.id, id.parse(req.params.id), chessCommand.parse(req.body)));
    attachments.register(api);
    api.post("/auth/renew", async (req, reply) => {
      z6.object({ requestId }).parse(req.body);
      if (req.session.native) fail(400, "NATIVE_REFRESH", "Use native credential renewal.");
      const access = token(), now = Date.now();
      await db.run("UPDATE sessions SET access_hash=?,access_expires=?,expires_at=?,last_seen=? WHERE id=?", [hash(access), now + 30 * 864e5, now + 30 * 864e5, now, req.session.id]);
      setCookie(reply, access);
      return { success: true, csrf: req.session.csrf };
    });
    api.get("/auth/me", async (req) => ({ user: publicUser(req.account), csrf: req.session.csrf }));
    api.post("/auth/logout", async (req, reply) => {
      z6.object({ requestId }).parse(req.body);
      await db.run("DELETE FROM sessions WHERE id=?", [req.session.id]);
      for (const s of io.sockets.sockets.values()) if (s.data.sessionId === req.session.id) s.disconnect(true);
      reply.clearCookie("dorham_session", { path: "/" });
      return { success: true };
    });
    api.post("/auth/password", async (req) => {
      const b = z6.object({ currentPassword: z6.string().max(128), password: passwordSchema, requestId }).parse(req.body);
      if (req.account.guest || !await passwordVerify(req.account.password_hash, b.currentPassword)) fail(401, "INVALID_CREDENTIALS", "Current password is incorrect.");
      const encoded = await passwordHash(b.password);
      const result = await service.mutate(req.account.id, b.requestId, "password.change", { fingerprint: hash(b.password) }, async (tx) => {
        await tx.run("UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?", [encoded, req.account.id]);
        await tx.run("DELETE FROM sessions WHERE user_id=? AND id<>?", [req.account.id, req.session.id]);
        return { success: true };
      });
      await disconnectInvalidSessions();
      return result;
    });
    api.post("/admin/claim", async (req) => {
      const b = z6.object({ secret: z6.string().max(256), requestId }).parse(req.body);
      if (!c.bootstrapSecret || !equal(c.bootstrapSecret, b.secret)) fail(403, "FORBIDDEN", "Bootstrap secret is invalid.");
      return service.mutate(req.account.id, b.requestId, "admin.claim", {}, async (tx) => {
        if (await tx.one("SELECT value FROM meta WHERE key='admin_claimed'")) fail(409, "ALREADY_CLAIMED", "Instance administration has already been claimed.");
        if (req.account.guest) fail(403, "GUEST_ACCOUNT", "Register before claiming administration.");
        await audit(tx, req.account.id, "admin.claim", req.account.id);
        await tx.run("UPDATE users SET instance_admin=1 WHERE id=?", [req.account.id]);
        await tx.run("INSERT INTO meta(key,value) VALUES('admin_claimed',?)", [req.account.id]);
        return { success: true };
      });
    });
    api.get("/bootstrap", async (req) => service.bootstrap(req.account.id));
    api.patch("/profile", async (req) => {
      const b = schemas.profile.parse(req.body);
      const result = await service.mutate(req.account.id, b.requestId, "profile.change", b, async (tx) => {
        await tx.run("UPDATE users SET display_name=?,bio=?,status=?,language=? WHERE id=?", [b.displayName, b.bio, b.status, b.language || req.account.language, req.account.id]);
        return { success: true };
      });
      await service.notify("state:changed", {});
      await service.notify("voice:changed", {});
      return result;
    });
    api.post("/profile/avatar", async (req) => {
      if (req.account.guest) fail(403, "GUEST_UPLOAD", "Guests cannot upload files.");
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
      let retiredAvatar = null;
      const result = await service.mutate(req.account.id, rid, "avatar.change", { hash: hash(bytes.toString("base64")) }, async (tx) => {
        let size = 0;
        for (const f of await readdir(avatarDir)) size += (await stat3(path3.join(avatarDir, f))).size;
        if (size + image.length > c.maxAvatarsMiB * 1024 * 1024) fail(507, "AVATAR_QUOTA", "Avatar storage is full.");
        const name = `${randomUUID4()}.webp`;
        await writeFile(path3.join(avatarDir, name), image, { flag: "wx" });
        const old = await tx.one("SELECT avatar FROM users WHERE id=?", [req.account.id]);
        await tx.run("UPDATE users SET avatar=? WHERE id=?", [`/avatars/${name}`, req.account.id]);
        retiredAvatar = old?.avatar || null;
        return { avatar: `/avatars/${name}` };
      });
      if (retiredAvatar) await unlink2(path3.join(avatarDir, path3.basename(retiredAvatar))).catch(() => {
      });
      await service.notify("state:changed", {});
      await service.notify("voice:changed", {});
      return result;
    });
    api.get("/channels/:id", async (req) => service.channel(db, req.account.id, id.parse(req.params.id)));
    api.get("/channels/:id/overrides", async (req) => service.channelOverrides(req.account.id, id.parse(req.params.id), schemas.role.parse(req.query.role)));
    api.post("/servers", async (req) => {
      const b = z6.object({ name: schemas.name, requestId }).parse(req.body);
      return service.createServer(req.account.id, b.requestId, b.name);
    });
    api.patch("/servers/:id", async (req) => {
      const b = z6.object({ name: schemas.name.optional(), delete: z6.boolean().optional(), allowGuests: z6.boolean().optional(), allowMemberInvites: z6.boolean().optional(), requestId }).refine((b2) => b2.name || b2.delete || b2.allowGuests !== void 0 || b2.allowMemberInvites !== void 0).parse(req.body);
      return service.changeServer(req.account.id, b.requestId, id.parse(req.params.id), b);
    });
    api.post("/servers/:id/channels", async (req) => {
      const b = schemas.channel.parse(req.body);
      return service.createChannel(req.account.id, b.requestId, id.parse(req.params.id), b.name, b.kind);
    });
    api.patch("/channels/:id", async (req) => {
      const b = z6.object({ name: schemas.name.optional(), delete: z6.boolean().optional(), role: schemas.role.optional(), permissions: schemas.permissions.optional(), expectedRevision: z6.number().int().min(0).optional(), requestId }).refine((b2) => b2.name || b2.delete || b2.role && b2.permissions).parse(req.body);
      return service.changeChannel(req.account.id, b.requestId, id.parse(req.params.id), b);
    });
    api.post("/servers/:id/invites", async (req) => {
      const b = z6.object({ hours: z6.number().int().min(1).max(168).default(24), uses: z6.number().int().min(1).max(100).default(10), requestId }).parse(req.body);
      return service.invite(req.account.id, b.requestId, id.parse(req.params.id), token(), b.hours, b.uses);
    });
    api.get("/servers/:id/invites", async (req) => service.invitations(req.account.id, id.parse(req.params.id)));
    api.delete("/servers/:id/invites/:code", async (req) => {
      const b = z6.object({ requestId }).parse(req.body), p = req.params;
      return service.revokeInvitation(req.account.id, b.requestId, id.parse(p.id), z6.string().min(10).max(100).parse(p.code));
    });
    api.get("/servers/:id/roles", async (req) => service.customRoles(req.account.id, id.parse(req.params.id)));
    api.post("/servers/:id/roles", async (req) => {
      const b = z6.object({ roleId: z6.string().uuid().optional(), name: z6.string().trim().min(1).max(32).optional(), color: z6.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), permissions: schemas.permissions.optional(), delete: z6.boolean().optional(), userId: id.optional(), assigned: z6.boolean().optional(), requestId }).strict().parse(req.body);
      return service.changeCustomRole(req.account.id, b.requestId, id.parse(req.params.id), b);
    });
    api.post("/invites/join", async (req) => {
      const b = z6.object({ code: z6.string().min(10).max(100), requestId }).parse(req.body);
      return service.joinInvite(req.account.id, b.requestId, b.code);
    });
    api.get("/servers/:id/members", async (req) => service.members(req.account.id, id.parse(req.params.id)));
    api.patch("/servers/:serverId/members/:userId", async (req) => {
      const b = z6.object({ role: schemas.role.optional(), remove: z6.boolean().optional(), requestId }).refine((b2) => b2.role || b2.remove).parse(req.body), p = req.params;
      return service.changeMember(req.account.id, b.requestId, id.parse(p.serverId), id.parse(p.userId), b);
    });
    api.post("/servers/:id/leave", async (req) => {
      const b = z6.object({ requestId }).parse(req.body);
      return service.leaveServer(req.account.id, b.requestId, id.parse(req.params.id));
    });
    api.post("/dms/:id/close", async (req) => {
      const b = z6.object({ requestId }).parse(req.body);
      return service.closeDirectMessage(req.account.id, b.requestId, id.parse(req.params.id));
    });
    api.post("/users/:id/block", async (req) => {
      const b = z6.object({ blocked: z6.boolean(), requestId }).parse(req.body);
      return service.blockUser(req.account.id, b.requestId, id.parse(req.params.id), b.blocked);
    });
    api.post("/dms", async (req) => {
      const b = z6.object({ userId: id, requestId }).parse(req.body);
      const result = await service.dm(req.account.id, b.requestId, b.userId);
      await service.notify("state:changed", {});
      return result;
    });
    api.get("/conversations/:id/messages", async (req) => {
      const b = z6.object({ before: z6.coerce.number().int().min(1).optional(), after: z6.coerce.number().int().min(0).optional() }).parse(req.query);
      return service.history(req.account.id, id.parse(req.params.id), b.before, b.after);
    });
    api.post("/messages", async (req) => {
      const b = messageSchema.parse(req.body);
      return service.send(req.account.id, b.requestId, b.conversationId, b.content, b.replyTo, b.attachmentIds);
    });
    api.patch("/messages/:id", async (req) => {
      const b = z6.object({ content: z6.string().trim().min(1).max(4e3).optional(), delete: z6.boolean().optional(), emoji: z6.enum(["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F389}", "\u{1F440}", "\u2705"]).optional(), removeReaction: z6.boolean().optional(), requestId }).refine((b2) => b2.content || b2.delete || b2.emoji).parse(req.body);
      return service.changeMessage(req.account.id, b.requestId, id.parse(req.params.id), b);
    });
    api.post("/conversations/:id/read", async (req) => {
      const b = z6.object({ sequence: z6.number().int().min(0), requestId }).parse(req.body);
      return service.read(req.account.id, b.requestId, id.parse(req.params.id), b.sequence);
    });
    api.get("/voice/:id", async (req) => service.room(req.account.id, id.parse(req.params.id)));
    api.post("/voice/:id/moderate", async (req) => {
      const b = z6.object({ userId: id, action: z6.enum(["mute", "unmute", "deafen", "undeafen", "denyShare", "allowShare", "kick", "stopShare"]), requestId }).parse(req.body);
      return service.moderate(req.account.id, b.requestId, id.parse(req.params.id), b.userId, b.action);
    });
    api.patch("/voice/:id/policy", async (req) => {
      const b = z6.object({ locked: z6.boolean(), userLimit: z6.number().int().min(1).max(c.maxVoice), tagMode: z6.enum(["ANY", "ALL"]), requiredTags: z6.array(z6.string().uuid()).max(32), requestId }).parse(req.body);
      return service.voicePolicy(req.account.id, b.requestId, id.parse(req.params.id), b);
    });
    api.post("/voice/:id/move", async (req) => {
      const b = z6.object({ userId: id, channelId: id, requestId }).parse(req.body);
      return service.moveVoice(req.account.id, b.requestId, id.parse(req.params.id), b.userId, b.channelId);
    });
    api.get("/servers/:id/tags", async (req) => ({ tags: await service.tags(req.account.id, id.parse(req.params.id)) }));
    api.post("/servers/:id/tags", async (req) => {
      const b = z6.object({ tagId: z6.string().uuid().optional(), name: z6.string().trim().min(1).max(32).optional(), color: z6.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), delete: z6.boolean().optional(), userId: id.optional(), assigned: z6.boolean().optional(), requestId }).parse(req.body);
      return service.changeTag(req.account.id, b.requestId, id.parse(req.params.id), b);
    });
    api.get("/admin/metrics", async (req) => {
      if (!req.account.instance_admin) fail(403, "FORBIDDEN", "Instance administrator required.");
      let disk = 0;
      for (const f of await readdir(c.dataDir)) {
        const s = await stat3(path3.join(c.dataDir, f));
        if (s.isFile()) disk += s.size;
      }
      return { uptimeSeconds: process.uptime(), memory: process.memoryUsage(), cpu: process.cpuUsage(), eventLoop: { meanMs: eventLoop.mean / 1e6, p95Ms: eventLoop.percentile(95) / 1e6, maxMs: eventLoop.max / 1e6 }, realtime, sfuControl: sfu.metrics, dataBytes: disk, storage: await storageStatus(), connectedUsers: new Set([...io.sockets.sockets.values()].map((s) => s.data.userId)).size, accounts: (await db.one("SELECT COUNT(*) AS count FROM users")).count, messages: (await db.one("SELECT COUNT(*) AS count FROM messages")).count, shares: (await db.one("SELECT COUNT(*) AS count FROM share_leases")).count };
    });
  }, { prefix: "/api/v1" });
  const io = new SocketServer(app2.server, { cors: { origin: c.origins, credentials: true }, maxHttpBufferSize: 128 * 1024, connectionStateRecovery: { maxDisconnectionDuration: 12e4, skipMiddlewares: false }, pingInterval: 2e4, pingTimeout: 1e4, allowRequest: (req, callback) => callback(null, allowed(req.headers.origin)) });
  mediaAdmission(app2, service, (socketId) => io.sockets.sockets.get(socketId)?.data.sessionId);
  games.online = (uid) => [...io.sockets.sockets.values()].some((s) => s.data.userId === uid);
  games.notify = async (g, directoryChanged, canvas) => {
    const audience = new Set((await db.all("SELECT user_id FROM voice_members WHERE channel_id=?", [g.channelId])).map((r) => r.user_id));
    g.seats.forEach((p) => audience.add(p.id));
    for (const socket of io.sockets.sockets.values()) if (audience.has(socket.data.userId)) {
      if (canvas) {
        if (socket.data.gameWatching === g.id && (g.kind !== "telephone" || g.seats[canvas.seat]?.id === socket.data.userId)) socket.emit("game:canvas", canvas);
      } else socket.emit("game:changed", { id: g.id, channelId: g.channelId, revision: g.revision, directoryChanged });
    }
  };
  chess.online = (uid) => [...io.sockets.sockets.values()].some((s) => s.data.userId === uid);
  chess.notify = async (g, directoryChanged) => {
    const members = new Set((await db.all("SELECT u.id AS user_id FROM users u JOIN servers s ON s.id=? LEFT JOIN members m ON m.server_id=s.id AND m.user_id=u.id WHERE u.banned=0 AND (u.instance_admin=1 OR (m.user_id IS NOT NULL AND (u.guest=0 OR s.allow_guests=1)))", [g.serverId])).map((r) => r.user_id));
    if (!members.has(g.whiteId) || g.blackId && !members.has(g.blackId)) return;
    const voice = g.channelId ? new Set((await db.all("SELECT user_id FROM voice_members WHERE channel_id=?", [g.channelId])).map((r) => r.user_id)) : null;
    for (const s of io.sockets.sockets.values()) if (members.has(s.data.userId) && (!voice || voice.has(s.data.userId) || s.data.userId === g.whiteId || s.data.userId === g.blackId)) s.emit("chess:changed", { id: g.id, serverId: g.serverId, channelId: g.channelId || null, directoryChanged, challengeTo: g.status === "pending" ? g.blackId : null });
  };
  io.use(async (socket, next) => {
    try {
      const cookieValue = String(socket.handshake.headers.cookie || "").split(";").map((s) => s.trim()).find((s) => s.startsWith("dorham_session="))?.split("=")[1];
      const resolved = await resolveSession(socket.handshake.auth.token || cookieValue);
      if (!resolved || resolved.account.must_change_password) throw new Error("Please sign in and replace any temporary password.");
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
    const session = await db.one("SELECT s.id FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.id=? AND s.expires_at>=? AND s.access_expires>=? AND u.banned=0 AND u.must_change_password=0", [socket.data.sessionId, Date.now(), Date.now()]);
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
  const connectionLatency = new ConnectionLatencyMonitor();
  async function measureConnection(s) {
    try {
      await validSocket(s);
      await connectionLatency.probe(s);
    } catch {
      connectionLatency.remove(s.id);
    }
  }
  let samplingConnections = false;
  const latencyTimer = setInterval(async () => {
    if (samplingConnections) return;
    samplingConnections = true;
    try {
      await Promise.allSettled([...io.sockets.sockets.values()].map(measureConnection));
      io.emit("connection:latencies", connectionLatency.snapshot(io.sockets.sockets.values()));
    } finally {
      samplingConnections = false;
    }
  }, 15e3);
  latencyTimer.unref();
  const voiceRefresh = new SingleFlight(async () => {
    const sockets = [...io.sockets.sockets.values()];
    const snapshot = await service.voiceSnapshot(sockets.map((s) => ({ socketId: s.id, userId: s.data.userId, channelId: s.data.voiceChannel })));
    for (const update of snapshot) {
      const s = io.sockets.sockets.get(update.socketId);
      if (!s) continue;
      const directoryKey = JSON.stringify(update.directory);
      if (s.data.directoryKey !== directoryKey) {
        s.data.directoryKey = directoryKey;
        s.emit("voice:directory", update.directory);
      }
      if (update.room === null) {
        s.emit("voice:removed", {});
        s.data.voiceChannel = null;
        s.data.roomKey = null;
      } else if (update.room) {
        const roomKey = JSON.stringify({ ...update.room, shares: update.room.shares.map(({ expiresAt: _expiry, ...share }) => share) });
        if (s.data.roomKey !== roomKey) {
          s.data.roomKey = roomKey;
          s.emit("voice:room", update.room);
        }
      }
    }
  });
  service.notify = async (kind, payload) => {
    if (kind === "conversation:event") {
      const audience = await service.conversationAudience([...io.sockets.sockets.values()].map((s) => ({ socketId: s.id, userId: s.data.userId })), payload.conversationId);
      for (const id2 of audience) io.sockets.sockets.get(id2)?.emit(kind, payload);
    } else if (kind === "voice:move") {
      const target = io.sockets.sockets.get(payload.socketId);
      if (target) {
        target.data.voiceChannel = null;
        target.emit("voice:move", { channelId: payload.channelId });
      }
    } else if (kind === "voice:changed" || kind === "voice:state:changed") {
      await voiceRefresh.run();
      if (kind === "voice:changed") {
        await chess.reconcileVoice();
        await games.reconcileVoice();
      }
      if (kind === "voice:changed" && sfu.client) try {
        await sfu.synchronize();
      } catch (err) {
        app2.log.error({ err }, "SFU permission synchronization failed");
        fail(503, "SFU_UNAVAILABLE", "Control changes were saved, but SFU enforcement could not be confirmed. Retry when the media server is available.");
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
    void chess.presence(socket.data.userId, true).catch(chess.onError);
    void games.reconcileVoice().catch(games.onError);
    void measureConnection(socket).then(() => {
      if (socket.connected) socket.emit("connection:latencies", connectionLatency.snapshot(io.sockets.sockets.values()));
    });
    let windowStart = Date.now(), eventCount = 0;
    const handle = (event, fn) => socket.on(event, async (body, ack) => {
      if (typeof ack !== "function") return;
      const started = performance.now(), metric = realtime.actions[event] ||= { count: 0, failures: 0, totalMs: 0, maxMs: 0, slow: 0 };
      metric.count++;
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
        metric.failures++;
        ack({ ok: false, error: { code: e.code || "INVALID_REQUEST", message: e instanceof ZodError ? "Invalid real-time payload." : e instanceof AppError || e.code === "TURN_UNAVAILABLE" ? e.message : "Real-time action failed." } });
      } finally {
        const elapsed = performance.now() - started;
        metric.totalMs += elapsed;
        metric.maxMs = Math.max(metric.maxMs, elapsed);
        if (elapsed > 500) metric.slow++;
      }
    });
    handle("message:send", async (b) => {
      const m = messageSchema.parse(b);
      return service.send(socket.data.userId, m.requestId, m.conversationId, m.content, m.replyTo, m.attachmentIds);
    });
    handle("game:watch", async (b) => {
      const gameId = id.parse(b.id);
      const view = await games.get(socket.data.userId, gameId);
      socket.data.gameWatching = gameId;
      return view;
    });
    handle("game:unwatch", async (b) => {
      if (socket.data.gameWatching === id.parse(b.id)) socket.data.gameWatching = null;
      return {};
    });
    handle("typing", async (b) => {
      const v = z6.object({ conversationId: id, active: z6.boolean() }).parse(b);
      const audience = await service.conversationAudience([...io.sockets.sockets.values()].filter((s) => s.id !== socket.id).map((s) => ({ socketId: s.id, userId: s.data.userId })), v.conversationId, socket.data.userId);
      for (const id2 of audience) io.sockets.sockets.get(id2)?.emit("typing", { ...v, userId: socket.data.userId });
      return {};
    });
    handle("voice:join", async (b) => {
      const v = z6.object({ channelId: id, eligible: z6.boolean() }).parse(b);
      const result = await service.joinVoice(socket.data.userId, socket.id, v.channelId, v.eligible);
      socket.data.voiceChannel = v.channelId;
      return result;
    });
    handle("voice:leave", async (b) => {
      z6.object({ requestId }).parse(b);
      const result = await service.voiceAction(socket.data.userId, socket.id, "leave");
      socket.data.voiceChannel = null;
      return result;
    });
    handle("voice:heartbeat", async (b) => {
      const v = z6.object({ eligible: z6.boolean().optional() }).parse(b);
      const result = await service.voiceAction(socket.data.userId, socket.id, "heartbeat", v);
      if ("room" in result) socket.emit("voice:room", result.room);
      return result;
    });
    handle("voice:state", async (b) => {
      const v = z6.object({ muted: z6.boolean(), deafened: z6.boolean(), requestId }).parse(b);
      return service.voiceAction(socket.data.userId, socket.id, "state", v);
    });
    handle("share:start", async (b) => {
      if (b?.protocolVersion !== 2) fail(428, "UPGRADE_REQUIRED", "Update Dorham to 0.5.0 before sharing your screen.");
      const v = shareStartSchema.parse(b);
      return service.share(socket.data.userId, socket.id, v.requestId, false, v.includeAudio);
    });
    handle("share:update", async (b) => {
      const v = shareUpdateSchema.parse(b);
      return service.updateShare(socket.data.userId, socket.id, v.requestId, v);
    });
    handle("share:stop", async (b) => {
      const v = z6.object({ requestId }).parse(b);
      return service.share(socket.data.userId, socket.id, v.requestId, true);
    });
    handle("voice:sfu", async (b) => {
      const v = z6.object({ channelId: id }).parse(b);
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
    socket.on("disconnect", async (reason) => {
      realtime.disconnects[reason] = (realtime.disconnects[reason] || 0) + 1;
      connectionLatency.remove(socket.id);
      try {
        const vm = await db.one("SELECT channel_id FROM voice_members WHERE socket_id=?", [socket.id]);
        if (vm) await service.voiceAction(socket.data.userId, socket.id, "leave");
        if (![...io.sockets.sockets.values()].some((s) => s.data.userId === socket.data.userId)) io.emit("presence", { userId: socket.data.userId, online: false });
        if (!chess.online(socket.data.userId)) await chess.presence(socket.data.userId, false);
        await games.reconcileVoice();
      } catch (err) {
        app2.log.error({ err }, "Disconnect cleanup failed");
      }
    });
  });
  app2.get("/api/v1/presence", { preHandler: authenticate }, async () => ({ online: [...new Set([...io.sockets.sockets.values()].map((s) => s.data.userId))], latencies: connectionLatency.snapshot(io.sockets.sockets.values()) }));
  await app2.register(staticPlugin, { root: avatarDir, prefix: "/avatars/", decorateReply: false, maxAge: 36e5, immutable: true });
  const webRoot = path3.resolve("apps/web/dist");
  if (existsSync(webRoot)) {
    await app2.register(staticPlugin, { root: webRoot, prefix: "/" });
    app2.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/avatars/")) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found." } });
      return reply.sendFile("index.html");
    });
  }
  let maintenanceRunning = false, nextStorageCheck = 0, storageWasPressured = false, nextMaintenance = performance.now() + 5e3;
  const maintenance = setInterval(async () => {
    const started = performance.now();
    realtime.maintenance.maxTimerDelayMs = Math.max(realtime.maintenance.maxTimerDelayMs, started - nextMaintenance);
    nextMaintenance = started + 5e3;
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      await service.cleanup();
      await disconnectInvalidSessions();
      await service.notify("voice:changed", {});
      if (Date.now() >= nextStorageCheck) {
        nextStorageCheck = Date.now() + 6e4;
        await attachments.cleanup();
        const storage = await storageStatus();
        if (storage.warnings.length && !storageWasPressured) app2.log.warn({ storage }, "Storage pressure: act before writes fail");
        storageWasPressured = storage.warnings.length > 0;
      }
    } catch (err) {
      app2.log.error({ err }, "Maintenance failed");
    } finally {
      maintenanceRunning = false;
      realtime.maintenance.passes++;
      realtime.maintenance.maxMs = Math.max(realtime.maintenance.maxMs, performance.now() - started);
    }
  }, 5e3);
  maintenance.unref();
  app2.addHook("preClose", async () => {
    chess.close();
    games.close();
    clearInterval(maintenance);
    clearInterval(latencyTimer);
    io.engine.close();
  });
  app2.addHook("onClose", async () => {
    await new Promise((resolve) => io.close(() => resolve()));
    await attachments.close();
    await db.close();
    if (existsSync(lockPath) && readFileSync(lockPath, "utf8") === String(process.pid)) unlinkSync(lockPath);
  });
  return { app: app2, db, service, io, chess, games, attachments, config: c };
}

// apps/api/src/index.ts
import { writeFile as writeFile2 } from "fs/promises";
import path4 from "path";
var { app, config: config2 } = await createApp();
await app.listen({ port: config2.port, host: config2.host });
await writeFile2(path4.join(config2.dataDir, "runtime-status.json"), JSON.stringify({
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