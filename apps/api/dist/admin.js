import {
  audit,
  fail,
  passwordHash,
  registerSchema
} from "./chunk-2GUYZ3ZR.js";
import {
  config,
  openDatabase
} from "./chunk-GUKVT4SI.js";

// scripts/admin.ts
import path from "path";
import { existsSync } from "fs";
import { readFile, mkdir, cp, rename } from "fs/promises";
import Sqlite from "better-sqlite3";

// apps/api/src/admin-operations.ts
import { randomUUID } from "crypto";
async function resetPreview(db2) {
  const result = {};
  for (const table of ["users", "sessions", "servers", "channels", "messages", "attachments"]) result[table] = Number((await db2.one(`SELECT COUNT(*) AS count FROM ${table}`)).count);
  return { counts: result, preserves: ["servers", "channels", "channel role overrides", "server and application settings", "tag definitions and channel tag requirements"], removes: ["all previous accounts and sessions", "all messages and DMs", "all invitations", "user tag assignments", "uploaded attachments and avatars (copied into the private backup first)"], ownership: "All existing servers transfer to the fresh super-admin. Other members must register and join again." };
}
async function initializeAdministrator(db2, input, reset = false) {
  const b = registerSchema.parse({ ...input, requestId: randomUUID() }), encoded = await passwordHash(b.password), uid = randomUUID();
  await db2.transaction(async (tx) => {
    if (!reset && (await tx.one("SELECT id FROM users WHERE instance_admin=1") || await tx.one("SELECT value FROM meta WHERE key='admin_claimed'"))) fail(409, "ALREADY_CLAIMED", "A global administrator already exists.");
    if (reset) {
      await tx.run("INSERT INTO users(id,username,display_name,password_hash,instance_admin,created_at) VALUES(?,?,?,?,1,?)", [uid, `reset_${uid}`, b.displayName, encoded, Date.now()]);
      await tx.run("UPDATE servers SET owner_id=?", [uid]);
      await tx.run("DELETE FROM events");
      await tx.run("DELETE FROM read_cursors");
      await tx.run("DELETE FROM reactions");
      await tx.run("DELETE FROM attachments");
      await tx.run("DELETE FROM messages");
      await tx.run("DELETE FROM dm_members");
      await tx.run("DELETE FROM dm_pairs");
      await tx.run("DELETE FROM conversations WHERE kind='dm'");
      await tx.run("UPDATE conversations SET sequence=0");
      await tx.run("DELETE FROM recovery_attempts");
      await tx.run("DELETE FROM invites");
      await tx.run("DELETE FROM used_refresh");
      await tx.run("DELETE FROM sessions");
      await tx.run("DELETE FROM voice_members");
      await tx.run("UPDATE coordinators SET user_id=NULL,epoch=epoch+1,expires_at=0");
      await tx.run("DELETE FROM users WHERE id<>?", [uid]);
      for (const server of await tx.all("SELECT id FROM servers")) await tx.run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)", [server.id, uid, "owner", Date.now()]);
      await tx.run("UPDATE users SET username=? WHERE id=?", [b.username.toLowerCase(), uid]);
    } else await tx.run("INSERT INTO users(id,username,display_name,password_hash,instance_admin,created_at) VALUES(?,?,?,?,1,?)", [uid, b.username.toLowerCase(), b.displayName, encoded, Date.now()]);
    await tx.run("INSERT INTO meta(key,value) VALUES('admin_claimed',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [uid]);
    await audit(tx, uid, reset ? "accounts.reset" : "admin.initialize", uid);
  });
  return { id: uid, username: b.username.toLowerCase() };
}

// scripts/admin.ts
var c = config();
var action = process.argv[2];
if (!["preview", "init", "reset"].includes(action)) throw new Error("Usage: npm run admin -- preview | init | reset [--credentials /private/account.json --confirm INIT-SUPERADMIN|RESET-ALL-USERS --backup /private/backup-directory]");
var arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? "" : process.argv[i + 1] || "";
};
if (existsSync(path.join(c.dataDir, "instance.lock"))) {
  const pid = Number(await readFile(path.join(c.dataDir, "instance.lock"), "utf8"));
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid instance lock. Verify service ownership manually.");
  try {
    process.kill(pid, 0);
    throw new Error("Stop Dorham before previewing or changing accounts.");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
}
if (action !== "preview" && arg("--confirm") !== (action === "reset" ? "RESET-ALL-USERS" : "INIT-SUPERADMIN")) throw new Error("Explicit confirmation is required. Preview and read docs/ACCOUNT-RESET.md first.");
var backupDir = "";
if (action === "reset") {
  if (c.databaseUrl) throw new Error("PostgreSQL reset is not automated: prepare and verify pg_dump with an operator-reviewed transaction. SQLite reset only is supported by this CLI.");
  backupDir = path.resolve(arg("--backup") || "");
  const relative = path.relative(c.dataDir, backupDir);
  if (!arg("--backup") || !relative || !relative.startsWith("..") && !path.isAbsolute(relative) || existsSync(backupDir)) throw new Error("Choose a new private backup directory outside DATA_DIR.");
  if (!arg("--credentials")) throw new Error("Provide a private JSON file with username, displayName and password; do not put credentials on the command line.");
  await mkdir(backupDir, { recursive: true, mode: 448 });
  const old = new Sqlite(path.join(c.dataDir, "dorham.sqlite"), { readonly: true, fileMustExist: true });
  try {
    await old.backup(path.join(backupDir, "dorham.sqlite"));
  } finally {
    old.close();
  }
  const check = new Sqlite(path.join(backupDir, "dorham.sqlite"), { readonly: true });
  try {
    if (check.pragma("integrity_check")[0].integrity_check !== "ok" || check.pragma("foreign_key_check").length) throw new Error("Backup integrity check failed.");
  } finally {
    check.close();
  }
  for (const [name, dir] of [["avatars", path.join(c.dataDir, "avatars")], ["attachments", c.attachmentDir]]) if (existsSync(dir)) await cp(dir, path.join(backupDir, name), { recursive: true, errorOnExist: true, force: false });
}
var db = await openDatabase(c);
try {
  console.log(JSON.stringify(await resetPreview(db), null, 2));
  if (action !== "preview") {
    const input = JSON.parse(await readFile(path.resolve(arg("--credentials")), "utf8"));
    const user = await initializeAdministrator(db, input, action === "reset");
    if (action === "reset") {
      for (const dir of [path.join(c.dataDir, "avatars"), c.attachmentDir]) if (existsSync(dir)) {
        await rename(dir, `${dir}.before-account-reset-${Date.now()}`);
        await mkdir(dir, { mode: 448 });
      }
    }
    console.log(JSON.stringify({ success: true, account: user, backup: backupDir || void 0 }));
  }
} finally {
  await db.close();
}
//# sourceMappingURL=admin.js.map