import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Sqlite from 'better-sqlite3';
import { drizzle as sqliteDrizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as pgDrizzle } from 'drizzle-orm/node-postgres';
import { sql, type SQL } from 'drizzle-orm';
import pg from 'pg';
import type { Config } from './config';
import { migrateExpansion } from './migrations';

export type Row = Record<string, any>;
export interface Connection {
  all<T extends Row = Row>(query: string, params?: unknown[]): Promise<T[]>;
  one<T extends Row = Row>(query: string, params?: unknown[]): Promise<T | undefined>;
  run(query: string, params?: unknown[]): Promise<void>;
}
export interface Database extends Connection {
  transaction<T>(fn: (tx: Connection) => Promise<T>): Promise<T>;
  close(): Promise<void>; backup(destination: string): Promise<void>; dialect: 'sqlite' | 'postgres';
}
// Parameters stay bound by Drizzle; SQL text is internal and never supplied by users.
function statement(query: string, params: unknown[] = []): SQL {
  const parts = query.split('?');
  if (parts.length - 1 !== params.length) throw new Error('SQL parameter mismatch');
  const chunks: SQL[] = [sql.raw(parts[0])];
  params.forEach((value, i) => { chunks.push(sql`${value}`, sql.raw(parts[i + 1])); });
  return sql.join(chunks, sql.raw(''));
}
const schema = [
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

export async function openDatabase(c: Config): Promise<Database> {
  mkdirSync(c.dataDir, { recursive: true });
  if (c.databaseUrl) {
    pg.types.setTypeParser(20, Number);
    const pool = new pg.Pool({ connectionString: c.databaseUrl, max: 4 });
    const connection = (client: pg.Pool | pg.PoolClient): Connection => {
      const orm = pgDrizzle(client);
      const all = async <T extends Row>(query: string, params?: unknown[]) => (await orm.execute(statement(query, params))).rows as T[];
      return { all, one: async (q, p) => (await all<any>(q, p))[0], run: async (q, p) => { await orm.execute(statement(q, p)); } };
    };
    const db: Database = {
      ...connection(pool), dialect: 'postgres',
      transaction: async fn => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT id FROM global_locks WHERE id=1 FOR UPDATE');
          const result = await fn(connection(client)); await client.query('COMMIT'); return result;
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      },
      close: () => pool.end(), backup: async () => { throw new Error('PostgreSQL backups require pg_dump; see docs/OPERATIONS.md'); }
    };
    // Initialization precedes transactional locking; PostgreSQL deploys use one migrator.
    for (const query of schema) await db.run(query);
    await db.run('INSERT INTO schema_migrations(version,applied_at) VALUES(1,?) ON CONFLICT(version) DO NOTHING', [Date.now()]);
    await migrateExpansion(db); return db;
  }
  const raw = new Sqlite(path.join(c.dataDir, 'dorham.sqlite'));
  raw.pragma('journal_mode = WAL'); raw.pragma('foreign_keys = ON'); raw.pragma('busy_timeout = 5000'); raw.pragma('auto_vacuum = INCREMENTAL'); raw.pragma('journal_size_limit = 16777216'); raw.pragma('wal_autocheckpoint = 1000');
  raw.pragma(`max_page_count = ${Math.floor(c.maxDatabaseMiB * 1024 * 1024 / Number(raw.pragma('page_size', { simple: true })))}`);
  const orm = sqliteDrizzle(raw);
  const all = async <T extends Row>(q: string, p?: unknown[]) => orm.all(statement(q, p)) as T[];
  const conn: Connection = { all, one: async (q, p) => (await all<any>(q, p))[0], run: async (q, p) => { orm.run(statement(q, p)); } };
  // Serialize reads as well as writes so another request cannot observe an unfinished transaction.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => { const next = tail.then(fn, fn); tail = next.catch(() => {}); return next; };
  const db: Database = {
    dialect: 'sqlite', all: (q, p) => exclusive(() => conn.all(q, p)), one: (q, p) => exclusive(() => conn.one(q, p)), run: (q, p) => exclusive(() => conn.run(q, p)),
    transaction: fn => exclusive(async () => { raw.exec('BEGIN IMMEDIATE'); try { const result = await fn(conn); raw.exec('COMMIT'); return result; } catch (e) { raw.exec('ROLLBACK'); throw e; } }),
    close: () => exclusive(async () => { raw.pragma('wal_checkpoint(TRUNCATE)'); raw.close(); }),
    backup: dest => exclusive(async () => { await raw.backup(dest); })
  };
  await db.transaction(async tx => { for (const query of schema) await tx.run(query); await tx.run('INSERT INTO schema_migrations(version,applied_at) VALUES(1,?) ON CONFLICT(version) DO NOTHING', [Date.now()]); });
  await migrateExpansion(db); return db;
}
