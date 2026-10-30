// apps/api/src/config.ts
import "dotenv/config";
import path from "path";
function config(overrides = {}) {
  const num = (key, fallback, allowZero = false) => {
    const n = Number(process.env[key] || fallback);
    if (!Number.isSafeInteger(n) || n < (allowZero ? 0 : 1)) throw new Error(`Invalid ${key}`);
    return n;
  };
  const list = (key, fallback = "") => (process.env[key] ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);
  const production = process.env.NODE_ENV === "production";
  const c = {
    dataDir: path.resolve(process.env.DATA_DIR || "./data"),
    databaseUrl: process.env.DATABASE_URL || "",
    port: num("SERVER_PORT", 3001),
    host: process.env.HOST || (production ? "0.0.0.0" : "127.0.0.1"),
    publicUrl: process.env.PUBLIC_URL || "http://localhost:3001",
    origins: list("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3001,capacitor://localhost,https://localhost,dorham://app"),
    secure: process.env.COOKIE_SECURE === "true" || production,
    production,
    bootstrapSecret: process.env.BOOTSTRAP_ADMIN_SECRET || "",
    registrationOpen: process.env.REGISTRATION_OPEN !== "false",
    maxUsers: num("MAX_USERS", 100),
    maxOnline: num("MAX_ONLINE_USERS", 20),
    maxVoice: num("MAX_VOICE_PARTICIPANTS", 16),
    roomShares: num("MAX_ROOM_SHARES", 0, true),
    globalShares: num("MAX_GLOBAL_SHARES", 0, true),
    retentionDays: num("MESSAGE_RETENTION_DAYS", 90),
    maxMessages: num("MAX_MESSAGES", 5e4),
    maxDatabaseMiB: num("MAX_DATABASE_MIB", 256),
    maxAvatarsMiB: num("MAX_AVATARS_MIB", 16),
    stunUrls: list("STUN_URLS"),
    turnUrls: list("TURN_URLS"),
    turnUsername: process.env.TURN_USERNAME || "",
    turnPassword: process.env.TURN_PASSWORD || "",
    turnSecret: process.env.TURN_SECRET || "",
    cloudflareTurnKeyId: process.env.CLOUDFLARE_TURN_KEY_ID || "",
    cloudflareTurnApiToken: process.env.CLOUDFLARE_TURN_API_TOKEN || "",
    mediaTransport: process.env.MEDIA_TRANSPORT === "livekit" ? "livekit" : "mesh",
    screenMaxBitrate: num("SCREEN_MAX_BITRATE", 45e4),
    screenMaxFrameRate: num("SCREEN_MAX_FRAME_RATE", 30),
    standardShareSlots: num("STANDARD_SHARE_SLOTS", 3),
    trustedProxies: list("TRUSTED_PROXIES"),
    guestsEnabled: process.env.GUESTS_ENABLED !== "false",
    maxGuests: num("MAX_GUESTS", 100),
    attachmentDir: path.resolve(process.env.ATTACHMENT_DIR || path.join(process.env.DATA_DIR || "./data", "attachments")),
    attachmentBudgetMiB: num("ATTACHMENT_BUDGET_MIB", 2048),
    uploadReserveMiB: num("UPLOAD_FREE_RESERVE_MIB", 2048),
    uploadConcurrency: num("UPLOAD_CONCURRENCY", 2),
    uploadSoftMiB: num("UPLOAD_DAILY_SOFT_MIB", 512),
    uploadHardMiB: num("UPLOAD_DAILY_HARD_MIB", 1024),
    uploadSmallMiB: num("UPLOAD_SMALL_FILE_MIB", 2),
    livekitUrl: process.env.LIVEKIT_URL || "",
    livekitKey: process.env.LIVEKIT_API_KEY || "",
    livekitSecret: process.env.LIVEKIT_API_SECRET || "",
    livekitApiUrl: process.env.LIVEKIT_API_URL || "",
    mediaAdmissionSecret: process.env.MEDIA_ADMISSION_SECRET || "",
    ...overrides
  };
  if (Boolean(c.cloudflareTurnKeyId) !== Boolean(c.cloudflareTurnApiToken)) throw new Error("Both Cloudflare TURN key ID and API token are required");
  if (c.cloudflareTurnKeyId && (!/^[a-zA-Z0-9_-]{1,128}$/.test(c.cloudflareTurnKeyId) || c.turnUrls.length)) throw new Error("Use one TURN provider and a valid Cloudflare TURN key ID");
  if (c.mediaTransport === "livekit" && (!c.livekitUrl || !c.livekitKey || !c.livekitSecret)) throw new Error("LiveKit credentials required");
  if (c.screenMaxBitrate < 64e3 || c.screenMaxBitrate > 1e7 || c.screenMaxFrameRate > 30) throw new Error("Invalid screen publishing policy");
  if (!process.env.ATTACHMENT_DIR && overrides.dataDir && !overrides.attachmentDir) c.attachmentDir = path.join(c.dataDir, "attachments");
  if (c.attachmentDir === c.dataDir || c.attachmentDir === path.parse(c.attachmentDir).root) throw new Error("ATTACHMENT_DIR must be a dedicated attachment directory.");
  if (c.uploadHardMiB < c.uploadSoftMiB || c.uploadSmallMiB > 100) throw new Error("Invalid shared upload policy.");
  if (c.mediaAdmissionSecret && c.mediaAdmissionSecret.length < 32) throw new Error("MEDIA_ADMISSION_SECRET must contain at least 32 characters.");
  if (c.production && !c.publicUrl.startsWith("https://")) throw new Error("Production PUBLIC_URL must use HTTPS");
  return c;
}

// apps/api/src/db.ts
import { mkdirSync } from "fs";
import path2 from "path";
import Sqlite from "better-sqlite3";
import { drizzle as sqliteDrizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as pgDrizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";

// apps/api/src/migrations.ts
import { createHash } from "crypto";
async function migrateExpansion(db) {
  await db.transaction(async (tx) => {
    if (await tx.one("SELECT version FROM schema_migrations WHERE version=2")) return;
    for (const query of [
      "ALTER TABLE users ADD COLUMN guest INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE servers ADD COLUMN allow_guests INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE channels ADD COLUMN locked INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN user_limit INTEGER NOT NULL DEFAULT 16",
      "ALTER TABLE channels ADD COLUMN tag_mode TEXT NOT NULL DEFAULT 'ANY'",
      "ALTER TABLE voice_members ADD COLUMN server_deafened INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sessions ADD COLUMN device_name TEXT NOT NULL DEFAULT 'Unknown device'",
      "ALTER TABLE sessions ADD COLUMN last_seen BIGINT NOT NULL DEFAULT 0",
      "CREATE TABLE recovery_codes (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(user_id,code_hash))",
      "CREATE TABLE recovery_questions (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, question TEXT NOT NULL, answer_hash TEXT NOT NULL)",
      "CREATE TABLE recovery_attempts (subject TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at BIGINT NOT NULL)",
      "CREATE TABLE audit_log (id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target_id TEXT, details TEXT NOT NULL, created_at BIGINT NOT NULL)",
      "CREATE INDEX audit_age ON audit_log(created_at)",
      "CREATE TABLE tags (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, UNIQUE(server_id,name))",
      "CREATE TABLE user_tags (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(user_id,tag_id))",
      "CREATE TABLE channel_tags (channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(channel_id,tag_id))",
      "CREATE TABLE voice_restrictions (channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, muted INTEGER NOT NULL DEFAULT 0, deafened INTEGER NOT NULL DEFAULT 0, sharing_allowed INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(channel_id,user_id))",
      "CREATE TABLE attachments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, message_id TEXT REFERENCES messages(id) ON DELETE SET NULL, request_id TEXT NOT NULL, name TEXT NOT NULL, size BIGINT NOT NULL, digest TEXT, state TEXT NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, UNIQUE(user_id,request_id))",
      "CREATE INDEX attachments_quota ON attachments(user_id,created_at)",
      "CREATE INDEX attachments_expiry ON attachments(state,expires_at)",
      "CREATE TABLE attachment_usage (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, bytes BIGINT NOT NULL, created_at BIGINT NOT NULL)",
      "CREATE INDEX attachment_usage_user ON attachment_usage(user_id,created_at)"
    ]) await tx.run(query);
    await tx.run("INSERT INTO schema_migrations(version,applied_at) VALUES(2,?)", [Date.now()]);
  });
  await db.transaction(async (tx) => {
    if (await tx.one("SELECT version FROM schema_migrations WHERE version=3")) return;
    await tx.run("ALTER TABLE invites ADD COLUMN code TEXT");
    for (const row of await tx.all("SELECT response FROM mutations WHERE operation='invite.create' ORDER BY created_at DESC LIMIT 5000")) {
      let code;
      try {
        code = JSON.parse(row.response).code;
      } catch {
        continue;
      }
      if (typeof code === "string" && /^[a-zA-Z0-9_-]{10,100}$/.test(code)) await tx.run("UPDATE invites SET code=? WHERE hash=? AND expires_at>? AND remaining>0", [code, createHash("sha256").update(code).digest("hex"), Date.now()]);
    }
    await tx.run("ALTER TABLE dm_members ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
    await tx.run("CREATE TABLE user_blocks (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(user_id,blocked_id))");
    await tx.run("CREATE TABLE custom_roles (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, permissions TEXT NOT NULL, UNIQUE(server_id,name))");
    await tx.run("CREATE TABLE member_roles (server_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE, PRIMARY KEY(server_id,user_id,role_id), FOREIGN KEY(server_id,user_id) REFERENCES members(server_id,user_id) ON DELETE CASCADE)");
    await tx.run("INSERT INTO schema_migrations(version,applied_at) VALUES(3,?)", [Date.now()]);
  });
  await db.transaction(async (tx) => {
    if (await tx.one("SELECT version FROM schema_migrations WHERE version=4")) return;
    for (const query of [
      "ALTER TABLE channel_overrides ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE share_leases ADD COLUMN tier TEXT NOT NULL DEFAULT 'fallback'",
      "ALTER TABLE share_leases ADD COLUMN started_at BIGINT NOT NULL DEFAULT 0",
      "ALTER TABLE share_leases ADD COLUMN requested_fps INTEGER NOT NULL DEFAULT 15",
      "ALTER TABLE share_leases ADD COLUMN include_audio INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE share_leases ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 1"
    ]) await tx.run(query);
    await tx.run("INSERT INTO schema_migrations(version,applied_at) VALUES(4,?)", [Date.now()]);
  });
  await db.transaction(async (tx) => {
    if (await tx.one("SELECT version FROM schema_migrations WHERE version=5")) return;
    await tx.run("ALTER TABLE servers ADD COLUMN allow_member_invites INTEGER NOT NULL DEFAULT 1");
    await tx.run("INSERT INTO schema_migrations(version,applied_at) VALUES(5,?)", [Date.now()]);
  });
  await db.transaction(async (tx) => {
    if (await tx.one("SELECT version FROM schema_migrations WHERE version=6")) return;
    await tx.run("CREATE TABLE chess_games (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, white_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, black_id TEXT REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL, updated_at BIGINT NOT NULL, state TEXT NOT NULL)");
    await tx.run("CREATE INDEX chess_server ON chess_games(server_id,status,updated_at)");
    await tx.run("CREATE INDEX chess_white ON chess_games(white_id,status)");
    await tx.run("CREATE INDEX chess_black ON chess_games(black_id,status)");
    await tx.run("INSERT INTO schema_migrations(version,applied_at) VALUES(6,?)", [Date.now()]);
  });
  await db.transaction(async (tx) => {
    if (await tx.one("SELECT version FROM schema_migrations WHERE version=7")) return;
    await tx.run("ALTER TABLE chess_games ADD COLUMN channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE");
    await tx.run("CREATE INDEX chess_voice ON chess_games(channel_id,status,updated_at)");
    await tx.run("INSERT INTO schema_migrations(version,applied_at) VALUES(7,?)", [Date.now()]);
  });
}

// apps/api/src/db.ts
function statement(query, params = []) {
  const parts = query.split("?");
  if (parts.length - 1 !== params.length) throw new Error("SQL parameter mismatch");
  const chunks = [sql.raw(parts[0])];
  params.forEach((value, i) => {
    chunks.push(sql`${value}`, sql.raw(parts[i + 1]));
  });
  return sql.join(chunks, sql.raw(""));
}
var schema = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', avatar TEXT, status TEXT NOT NULL DEFAULT 'online', instance_admin INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, access_hash TEXT NOT NULL UNIQUE, refresh_hash TEXT UNIQUE, csrf TEXT NOT NULL, native INTEGER NOT NULL DEFAULT 0, access_expires BIGINT NOT NULL, expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS used_refresh (hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, expires_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS members (server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, joined_at BIGINT NOT NULL, PRIMARY KEY(server_id,user_id))`,
  `CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, sequence BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL, conversation_id TEXT UNIQUE REFERENCES conversations(id), created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS channel_overrides (channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, role TEXT NOT NULL, permissions TEXT NOT NULL, PRIMARY KEY(channel_id,role))`,
  `CREATE TABLE IF NOT EXISTS dm_members (conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(conversation_id,user_id))`,
  `CREATE TABLE IF NOT EXISTS dm_pairs (pair_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sequence BIGINT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL, reply_to TEXT REFERENCES messages(id) ON DELETE SET NULL, created_at BIGINT NOT NULL, edited_at BIGINT, deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS messages_page ON messages(conversation_id,sequence)`,
  `CREATE INDEX IF NOT EXISTS messages_age ON messages(created_at)`,
  `CREATE TABLE IF NOT EXISTS reactions (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), emoji TEXT NOT NULL, PRIMARY KEY(message_id,user_id,emoji))`,
  `CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sequence BIGINT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at BIGINT NOT NULL, UNIQUE(conversation_id,sequence))`,
  `CREATE INDEX IF NOT EXISTS events_age ON events(created_at)`,
  `CREATE TABLE IF NOT EXISTS read_cursors (conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), sequence BIGINT NOT NULL, PRIMARY KEY(conversation_id,user_id))`,
  `CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL, remaining INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES users(id))`,
  `CREATE TABLE IF NOT EXISTS voice_members (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, socket_id TEXT NOT NULL, epoch TEXT NOT NULL, muted INTEGER NOT NULL DEFAULT 0, deafened INTEGER NOT NULL DEFAULT 0, server_muted INTEGER NOT NULL DEFAULT 0, eligible INTEGER NOT NULL DEFAULT 0, heartbeat BIGINT NOT NULL, joined_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS share_leases (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES voice_members(user_id) ON DELETE CASCADE, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS coordinators (channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE, user_id TEXT, epoch BIGINT NOT NULL DEFAULT 0, expires_at BIGINT NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS mutations (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, request_id TEXT NOT NULL, operation TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(user_id,request_id))`,
  `CREATE TABLE IF NOT EXISTS global_locks (id INTEGER PRIMARY KEY)`,
  `INSERT INTO global_locks(id) VALUES(1) ON CONFLICT(id) DO NOTHING`
];
async function openDatabase(c) {
  mkdirSync(c.dataDir, { recursive: true });
  if (c.databaseUrl) {
    pg.types.setTypeParser(20, Number);
    const pool = new pg.Pool({ connectionString: c.databaseUrl, max: 4 });
    const connection = (client) => {
      const orm2 = pgDrizzle(client);
      const all2 = async (query, params) => (await orm2.execute(statement(query, params))).rows;
      return { all: all2, one: async (q, p) => (await all2(q, p))[0], run: async (q, p) => {
        await orm2.execute(statement(q, p));
      } };
    };
    const db2 = {
      ...connection(pool),
      dialect: "postgres",
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT id FROM global_locks WHERE id=1 FOR UPDATE");
          const result = await fn(connection(client));
          await client.query("COMMIT");
          return result;
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
      backup: async () => {
        throw new Error("PostgreSQL backups require pg_dump; see docs/OPERATIONS.md");
      }
    };
    for (const query of schema) await db2.run(query);
    await db2.run("INSERT INTO schema_migrations(version,applied_at) VALUES(1,?) ON CONFLICT(version) DO NOTHING", [Date.now()]);
    await migrateExpansion(db2);
    return db2;
  }
  const raw = new Sqlite(path2.join(c.dataDir, "dorham.sqlite"));
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");
  raw.pragma("auto_vacuum = INCREMENTAL");
  raw.pragma("journal_size_limit = 16777216");
  raw.pragma("wal_autocheckpoint = 1000");
  raw.pragma(`max_page_count = ${Math.floor(c.maxDatabaseMiB * 1024 * 1024 / Number(raw.pragma("page_size", { simple: true })))}`);
  const orm = sqliteDrizzle(raw);
  const all = async (q, p) => orm.all(statement(q, p));
  const conn = { all, one: async (q, p) => (await all(q, p))[0], run: async (q, p) => {
    orm.run(statement(q, p));
  } };
  let tail = Promise.resolve();
  const exclusive = (fn) => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => {
    });
    return next;
  };
  const db = {
    dialect: "sqlite",
    all: (q, p) => exclusive(() => conn.all(q, p)),
    one: (q, p) => exclusive(() => conn.one(q, p)),
    run: (q, p) => exclusive(() => conn.run(q, p)),
    transaction: (fn) => exclusive(async () => {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(conn);
        raw.exec("COMMIT");
        return result;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    }),
    close: () => exclusive(async () => {
      raw.pragma("wal_checkpoint(TRUNCATE)");
      raw.close();
    }),
    backup: (dest) => exclusive(async () => {
      await raw.backup(dest);
    })
  };
  await db.transaction(async (tx) => {
    for (const query of schema) await tx.run(query);
    await tx.run("INSERT INTO schema_migrations(version,applied_at) VALUES(1,?) ON CONFLICT(version) DO NOTHING", [Date.now()]);
  });
  await migrateExpansion(db);
  return db;
}

export {
  config,
  openDatabase
};
//# sourceMappingURL=chunk-KAONWHCO.js.map