import {
  config,
  openDatabase
} from "./chunk-TVTC4KB5.js";

// scripts/database.ts
import { existsSync } from "fs";
import { mkdir, rename, readFile } from "fs/promises";
import path from "path";
import Sqlite from "better-sqlite3";
var c = config();
var action = process.argv[2];
if (action === "restore") {
  if (c.databaseUrl) throw new Error("Use pg_restore / psql for PostgreSQL; see OPERATIONS.md.");
  const source = process.argv[3];
  if (!source) throw new Error("Usage: npm run db:restore -- /absolute/backup.sqlite");
  const lock = path.join(c.dataDir, "instance.lock");
  if (existsSync(lock)) {
    const pid = Number(await readFile(lock, "utf8"));
    try {
      process.kill(pid, 0);
      throw new Error("Stop the server before restoring.");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  }
  const backup = new Sqlite(path.resolve(source), { readonly: true, fileMustExist: true });
  if (backup.pragma("integrity_check")[0].integrity_check !== "ok") throw new Error("Backup integrity check failed");
  if (!backup.prepare("SELECT version FROM schema_migrations WHERE version=1").get()) throw new Error("Backup is not a recognized Dorham database");
  await mkdir(c.dataDir, { recursive: true });
  const target = path.join(c.dataDir, "dorham.sqlite"), temp = `${target}.restore-${Date.now()}`;
  await backup.backup(temp);
  backup.close();
  if (existsSync(target)) await rename(target, `${target}.before-${Date.now()}`);
  for (const suffix of ["-wal", "-shm"]) if (existsSync(`${target}${suffix}`)) await rename(`${target}${suffix}`, `${target}${suffix}.before-${Date.now()}`);
  await rename(temp, target);
  console.log("Database restored. Previous files preserved beside it. Restore matching avatars and attachments separately.");
} else {
  const db = await openDatabase(c);
  try {
    if (action === "migrate") console.log(`Schema ready (${db.dialect}).`);
    else if (action === "backup") {
      const destination = path.resolve(process.argv[3] || `artifacts/backups/dorham-${Date.now()}.sqlite`);
      await mkdir(path.dirname(destination), { recursive: true });
      if (existsSync(destination)) throw new Error("Backup destination already exists.");
      await db.backup(destination);
      console.log(`Verified online database snapshot created: ${destination}. Copy matching avatars and attachments separately and keep the backup off-host.`);
    } else throw new Error("Expected migrate, backup, or restore");
  } finally {
    await db.close();
  }
}
//# sourceMappingURL=database.js.map