// apps/api/src/config.ts
import "dotenv/config";
import path from "path";
function config(overrides = {}) {
  const num = (key, fallback) => {
    const n = Number(process.env[key] || fallback);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${key}`);
    return n;
  };
  const list = (key, fallback = "") => (process.env[key] || fallback).split(",").map((s) => s.trim()).filter(Boolean);
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
    roomShares: num("MAX_ROOM_SHARES", 2),
    globalShares: num("MAX_GLOBAL_SHARES", 5),
    retentionDays: num("MESSAGE_RETENTION_DAYS", 90),
    maxMessages: num("MAX_MESSAGES", 5e4),
    maxDatabaseMiB: num("MAX_DATABASE_MIB", 256),
    maxAvatarsMiB: num("MAX_AVATARS_MIB", 16),
    stunUrls: list("STUN_URLS", "stun:stun.l.google.com:19302"),
    turnUrls: list("TURN_URLS"),
    turnUsername: process.env.TURN_USERNAME || "",
    turnPassword: process.env.TURN_PASSWORD || "",
    turnSecret: process.env.TURN_SECRET || "",
    cloudflareTurnKeyId: process.env.CLOUDFLARE_TURN_KEY_ID || "",
    cloudflareTurnApiToken: process.env.CLOUDFLARE_TURN_API_TOKEN || "",
    mediaTransport: process.env.MEDIA_TRANSPORT === "livekit" ? "livekit" : "mesh",
    livekitUrl: process.env.LIVEKIT_URL || "",
    livekitKey: process.env.LIVEKIT_API_KEY || "",
    livekitSecret: process.env.LIVEKIT_API_SECRET || "",
    ...overrides
  };
  if (Boolean(c.cloudflareTurnKeyId) !== Boolean(c.cloudflareTurnApiToken)) throw new Error("Both Cloudflare TURN key ID and API token are required");
  if (c.cloudflareTurnKeyId && (!/^[a-zA-Z0-9_-]{1,128}$/.test(c.cloudflareTurnKeyId) || c.turnUrls.length)) throw new Error("Use one TURN provider and a valid Cloudflare TURN key ID");
  if (c.mediaTransport === "livekit" && (!c.livekitUrl || !c.livekitKey || !c.livekitSecret)) throw new Error("LiveKit credentials required");
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
  return db;
}

export {
  config,
  openDatabase
};
//# sourceMappingURL=chunk-CIPPY6MO.js.map