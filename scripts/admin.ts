import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, mkdir, cp, rename } from 'node:fs/promises';
import Sqlite from 'better-sqlite3';
import { config } from '../apps/api/src/config';
import { openDatabase } from '../apps/api/src/db';
import { resetPreview, initializeAdministrator } from '../apps/api/src/admin-operations';

const c = config(), action = process.argv[2];
if (!['preview', 'init', 'reset'].includes(action)) throw new Error('Usage: npm run admin -- preview | init | reset [--credentials /private/account.json --confirm INIT-SUPERADMIN|RESET-ALL-USERS --backup /private/backup-directory]');
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? '' : process.argv[i + 1] || ''; };
if (existsSync(path.join(c.dataDir, 'instance.lock'))) {
  const pid = Number(await readFile(path.join(c.dataDir, 'instance.lock'), 'utf8'));
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid instance lock. Verify service ownership manually.');
  try { process.kill(pid, 0); throw new Error('Stop Dorham before previewing or changing accounts.'); } catch (e: any) { if (e.code !== 'ESRCH') throw e; }
}
if (action !== 'preview' && arg('--confirm') !== (action === 'reset' ? 'RESET-ALL-USERS' : 'INIT-SUPERADMIN')) throw new Error('Explicit confirmation is required. Preview and read docs/ACCOUNT-RESET.md first.');
// Create a pre-migration snapshot before opening a database for a destructive reset.
let backupDir = '';
if (action === 'reset') {
  if (c.databaseUrl) throw new Error('PostgreSQL reset is not automated: prepare and verify pg_dump with an operator-reviewed transaction. SQLite reset only is supported by this CLI.');
  backupDir = path.resolve(arg('--backup') || '');
  const relative = path.relative(c.dataDir, backupDir);
  if (!arg('--backup') || !relative || (!relative.startsWith('..') && !path.isAbsolute(relative)) || existsSync(backupDir)) throw new Error('Choose a new private backup directory outside DATA_DIR.');
  if (!arg('--credentials')) throw new Error('Provide a private JSON file with username, displayName and password; do not put credentials on the command line.');
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const old = new Sqlite(path.join(c.dataDir, 'dorham.sqlite'), { readonly: true, fileMustExist: true });
  try { await old.backup(path.join(backupDir, 'dorham.sqlite')); } finally { old.close(); }
  const check = new Sqlite(path.join(backupDir, 'dorham.sqlite'), { readonly: true });
  try { if ((check.pragma('integrity_check') as any[])[0].integrity_check !== 'ok' || (check.pragma('foreign_key_check') as any[]).length) throw new Error('Backup integrity check failed.'); } finally { check.close(); }
  for (const [name, dir] of [['avatars', path.join(c.dataDir, 'avatars')], ['attachments', c.attachmentDir]]) if (existsSync(dir)) await cp(dir, path.join(backupDir, name), { recursive: true, errorOnExist: true, force: false });
}
const db = await openDatabase(c);
try {
  console.log(JSON.stringify(await resetPreview(db), null, 2));
  if (action !== 'preview') {
    const input = JSON.parse(await readFile(path.resolve(arg('--credentials')), 'utf8'));
    const user = await initializeAdministrator(db, input, action === 'reset');
    if (action === 'reset') for (const dir of [path.join(c.dataDir, 'avatars'), c.attachmentDir]) if (existsSync(dir)) { await rename(dir, `${dir}.before-account-reset-${Date.now()}`); await mkdir(dir, { mode: 0o700 }); }
    console.log(JSON.stringify({ success: true, account: user, backup: backupDir || undefined }));
  }
} finally { await db.close(); }
