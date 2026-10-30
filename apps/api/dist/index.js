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
} from "./chunk-VFHQ757F.js";

// apps/api/src/app.ts
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import { Server as SocketServer } from "socket.io";
import { z as z4, ZodError } from "zod";
import { randomUUID as randomUUID2 } from "crypto";
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
      await tx.run("INSERT INTO sessions(id,user_id,access_hash,refresh_hash,csrf,native,access_expires,expires_at,created_at,device_name,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?)", [randomUUID2(), userId, hash(access), refresh ? hash(refresh) : null, csrf, Number(native), now + (native ? 15 * 6e4 : 30 * 864e5), now + 30 * 864e5, now, device.slice(0, 160), now]);
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
      const userId2 = randomUUID2();
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
    const body = z4.object({ refreshToken: z4.string().min(20).max(512), requestId }).parse(req.body), fingerprint = hash(body.refreshToken);
    const outcome = await db.transaction(async (tx) => {
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
    if (!outcome) fail(401, "REFRESH_INVALID", "Session expired. Sign in again.");
    return outcome;
  });
  publicAccountRoutes(app2, service, authRate, sessionFor, disconnectInvalidSessions);
  await app2.register(async (api) => {
    api.addHook("preHandler", authenticate);
    protectedAccountRoutes(api, service, disconnectInvalidSessions);
    attachments.register(api);
    api.post("/auth/renew", async (req, reply) => {
      z4.object({ requestId }).parse(req.body);
      if (req.session.native) fail(400, "NATIVE_REFRESH", "Use native credential renewal.");
      const access = token(), now = Date.now();
      await db.run("UPDATE sessions SET access_hash=?,access_expires=?,expires_at=?,last_seen=? WHERE id=?", [hash(access), now + 30 * 864e5, now + 30 * 864e5, now, req.session.id]);
      setCookie(reply, access);
      return { success: true, csrf: req.session.csrf };
    });
    api.get("/auth/me", async (req) => ({ user: publicUser(req.account), csrf: req.session.csrf }));
    api.post("/auth/logout", async (req, reply) => {
      z4.object({ requestId }).parse(req.body);
      await db.run("DELETE FROM sessions WHERE id=?", [req.session.id]);
      for (const s of io.sockets.sockets.values()) if (s.data.sessionId === req.session.id) s.disconnect(true);
      reply.clearCookie("dorham_session", { path: "/" });
      return { success: true };
    });
    api.post("/auth/password", async (req) => {
      const b = z4.object({ currentPassword: z4.string().max(128), password: passwordSchema, requestId }).parse(req.body);
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
      const b = z4.object({ secret: z4.string().max(256), requestId }).parse(req.body);
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
        const name = `${randomUUID2()}.webp`;
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
      const b = z4.object({ name: schemas.name, requestId }).parse(req.body);
      return service.createServer(req.account.id, b.requestId, b.name);
    });
    api.patch("/servers/:id", async (req) => {
      const b = z4.object({ name: schemas.name.optional(), delete: z4.boolean().optional(), allowGuests: z4.boolean().optional(), allowMemberInvites: z4.boolean().optional(), requestId }).refine((b2) => b2.name || b2.delete || b2.allowGuests !== void 0 || b2.allowMemberInvites !== void 0).parse(req.body);
      return service.changeServer(req.account.id, b.requestId, id.parse(req.params.id), b);
    });
    api.post("/servers/:id/channels", async (req) => {
      const b = schemas.channel.parse(req.body);
      return service.createChannel(req.account.id, b.requestId, id.parse(req.params.id), b.name, b.kind);
    });
    api.patch("/channels/:id", async (req) => {
      const b = z4.object({ name: schemas.name.optional(), delete: z4.boolean().optional(), role: schemas.role.optional(), permissions: schemas.permissions.optional(), expectedRevision: z4.number().int().min(0).optional(), requestId }).refine((b2) => b2.name || b2.delete || b2.role && b2.permissions).parse(req.body);
      return service.changeChannel(req.account.id, b.requestId, id.parse(req.params.id), b);
    });
    api.post("/servers/:id/invites", async (req) => {
      const b = z4.object({ hours: z4.number().int().min(1).max(168).default(24), uses: z4.number().int().min(1).max(100).default(10), requestId }).parse(req.body);
      return service.invite(req.account.id, b.requestId, id.parse(req.params.id), token(), b.hours, b.uses);
    });
    api.get("/servers/:id/invites", async (req) => service.invitations(req.account.id, id.parse(req.params.id)));
    api.delete("/servers/:id/invites/:code", async (req) => {
      const b = z4.object({ requestId }).parse(req.body), p = req.params;
      return service.revokeInvitation(req.account.id, b.requestId, id.parse(p.id), z4.string().min(10).max(100).parse(p.code));
    });
    api.get("/servers/:id/roles", async (req) => service.customRoles(req.account.id, id.parse(req.params.id)));
    api.post("/servers/:id/roles", async (req) => {
      const b = z4.object({ roleId: z4.string().uuid().optional(), name: z4.string().trim().min(1).max(32).optional(), color: z4.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), permissions: schemas.permissions.optional(), delete: z4.boolean().optional(), userId: id.optional(), assigned: z4.boolean().optional(), requestId }).strict().parse(req.body);
      return service.changeCustomRole(req.account.id, b.requestId, id.parse(req.params.id), b);
    });
    api.post("/invites/join", async (req) => {
      const b = z4.object({ code: z4.string().min(10).max(100), requestId }).parse(req.body);
      return service.joinInvite(req.account.id, b.requestId, b.code);
    });
    api.get("/servers/:id/members", async (req) => service.members(req.account.id, id.parse(req.params.id)));
    api.patch("/servers/:serverId/members/:userId", async (req) => {
      const b = z4.object({ role: schemas.role.optional(), remove: z4.boolean().optional(), requestId }).refine((b2) => b2.role || b2.remove).parse(req.body), p = req.params;
      return service.changeMember(req.account.id, b.requestId, id.parse(p.serverId), id.parse(p.userId), b);
    });
    api.post("/servers/:id/leave", async (req) => {
      const b = z4.object({ requestId }).parse(req.body);
      return service.leaveServer(req.account.id, b.requestId, id.parse(req.params.id));
    });
    api.post("/dms/:id/close", async (req) => {
      const b = z4.object({ requestId }).parse(req.body);
      return service.closeDirectMessage(req.account.id, b.requestId, id.parse(req.params.id));
    });
    api.post("/users/:id/block", async (req) => {
      const b = z4.object({ blocked: z4.boolean(), requestId }).parse(req.body);
      return service.blockUser(req.account.id, b.requestId, id.parse(req.params.id), b.blocked);
    });
    api.post("/dms", async (req) => {
      const b = z4.object({ userId: id, requestId }).parse(req.body);
      const result = await service.dm(req.account.id, b.requestId, b.userId);
      await service.notify("state:changed", {});
      return result;
    });
    api.get("/conversations/:id/messages", async (req) => {
      const b = z4.object({ before: z4.coerce.number().int().min(1).optional(), after: z4.coerce.number().int().min(0).optional() }).parse(req.query);
      return service.history(req.account.id, id.parse(req.params.id), b.before, b.after);
    });
    api.post("/messages", async (req) => {
      const b = messageSchema.parse(req.body);
      return service.send(req.account.id, b.requestId, b.conversationId, b.content, b.replyTo, b.attachmentIds);
    });
    api.patch("/messages/:id", async (req) => {
      const b = z4.object({ content: z4.string().trim().min(1).max(4e3).optional(), delete: z4.boolean().optional(), emoji: z4.enum(["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F389}", "\u{1F440}", "\u2705"]).optional(), removeReaction: z4.boolean().optional(), requestId }).refine((b2) => b2.content || b2.delete || b2.emoji).parse(req.body);
      return service.changeMessage(req.account.id, b.requestId, id.parse(req.params.id), b);
    });
    api.post("/conversations/:id/read", async (req) => {
      const b = z4.object({ sequence: z4.number().int().min(0), requestId }).parse(req.body);
      return service.read(req.account.id, b.requestId, id.parse(req.params.id), b.sequence);
    });
    api.get("/voice/:id", async (req) => service.room(req.account.id, id.parse(req.params.id)));
    api.post("/voice/:id/moderate", async (req) => {
      const b = z4.object({ userId: id, action: z4.enum(["mute", "unmute", "deafen", "undeafen", "denyShare", "allowShare", "kick", "stopShare"]), requestId }).parse(req.body);
      return service.moderate(req.account.id, b.requestId, id.parse(req.params.id), b.userId, b.action);
    });
    api.patch("/voice/:id/policy", async (req) => {
      const b = z4.object({ locked: z4.boolean(), userLimit: z4.number().int().min(1).max(c.maxVoice), tagMode: z4.enum(["ANY", "ALL"]), requiredTags: z4.array(z4.string().uuid()).max(32), requestId }).parse(req.body);
      return service.voicePolicy(req.account.id, b.requestId, id.parse(req.params.id), b);
    });
    api.post("/voice/:id/move", async (req) => {
      const b = z4.object({ userId: id, channelId: id, requestId }).parse(req.body);
      return service.moveVoice(req.account.id, b.requestId, id.parse(req.params.id), b.userId, b.channelId);
    });
    api.get("/servers/:id/tags", async (req) => ({ tags: await service.tags(req.account.id, id.parse(req.params.id)) }));
    api.post("/servers/:id/tags", async (req) => {
      const b = z4.object({ tagId: z4.string().uuid().optional(), name: z4.string().trim().min(1).max(32).optional(), color: z4.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), delete: z4.boolean().optional(), userId: id.optional(), assigned: z4.boolean().optional(), requestId }).parse(req.body);
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
    handle("typing", async (b) => {
      const v = z4.object({ conversationId: id, active: z4.boolean() }).parse(b);
      const audience = await service.conversationAudience([...io.sockets.sockets.values()].filter((s) => s.id !== socket.id).map((s) => ({ socketId: s.id, userId: s.data.userId })), v.conversationId, socket.data.userId);
      for (const id2 of audience) io.sockets.sockets.get(id2)?.emit("typing", { ...v, userId: socket.data.userId });
      return {};
    });
    handle("voice:join", async (b) => {
      const v = z4.object({ channelId: id, eligible: z4.boolean() }).parse(b);
      const result = await service.joinVoice(socket.data.userId, socket.id, v.channelId, v.eligible);
      socket.data.voiceChannel = v.channelId;
      return result;
    });
    handle("voice:leave", async (b) => {
      z4.object({ requestId }).parse(b);
      const result = await service.voiceAction(socket.data.userId, socket.id, "leave");
      socket.data.voiceChannel = null;
      return result;
    });
    handle("voice:heartbeat", async (b) => {
      const v = z4.object({ eligible: z4.boolean().optional() }).parse(b);
      const result = await service.voiceAction(socket.data.userId, socket.id, "heartbeat", v);
      if ("room" in result) socket.emit("voice:room", result.room);
      return result;
    });
    handle("voice:state", async (b) => {
      const v = z4.object({ muted: z4.boolean(), deafened: z4.boolean(), requestId }).parse(b);
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
      const v = z4.object({ requestId }).parse(b);
      return service.share(socket.data.userId, socket.id, v.requestId, true);
    });
    handle("voice:sfu", async (b) => {
      const v = z4.object({ channelId: id }).parse(b);
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
  return { app: app2, db, service, io, attachments, config: c };
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