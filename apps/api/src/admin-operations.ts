import { randomUUID } from 'node:crypto';
import type { Database } from './db';
import { registerSchema } from '@dorham/contracts';
import { audit } from './accounts';
import { passwordHash, fail } from './security';

export async function resetPreview(db: Database) {
  const result: Record<string, number> = {};
  for (const table of ['users', 'sessions', 'servers', 'channels', 'messages', 'attachments']) result[table] = Number((await db.one(`SELECT COUNT(*) AS count FROM ${table}`))!.count);
  return { counts: result, preserves: ['servers', 'channels', 'channel role overrides', 'server and application settings', 'tag definitions and channel tag requirements'], removes: ['all previous accounts and sessions', 'all messages and DMs', 'all invitations', 'user tag assignments', 'uploaded attachments and avatars (copied into the private backup first)'], ownership: 'All existing servers transfer to the fresh super-admin. Other members must register and join again.' };
}
export async function initializeAdministrator(db: Database, input: unknown, reset = false) {
  const b = registerSchema.parse({ ...(input as object), requestId: randomUUID() }), encoded = await passwordHash(b.password), uid = randomUUID();
  await db.transaction(async tx => {
    if (!reset && ((await tx.one('SELECT id FROM users WHERE instance_admin=1')) || (await tx.one("SELECT value FROM meta WHERE key='admin_claimed'")))) fail(409, 'ALREADY_CLAIMED', 'A global administrator already exists.');
    if (reset) {
      // Keep the user FK valid while ownership moves; temporary username avoids
      // colliding with the requested username on an account being removed.
      await tx.run('INSERT INTO users(id,username,display_name,password_hash,instance_admin,created_at) VALUES(?,?,?,?,1,?)', [uid, `reset_${uid}`, b.displayName, encoded, Date.now()]);
      await tx.run('UPDATE servers SET owner_id=?', [uid]);
      await tx.run('DELETE FROM events'); await tx.run('DELETE FROM read_cursors'); await tx.run('DELETE FROM reactions');
      await tx.run('DELETE FROM attachments'); await tx.run('DELETE FROM messages'); await tx.run('DELETE FROM dm_members'); await tx.run('DELETE FROM dm_pairs');
      await tx.run("DELETE FROM conversations WHERE kind='dm'"); await tx.run('UPDATE conversations SET sequence=0');
      await tx.run('DELETE FROM recovery_attempts'); await tx.run('DELETE FROM invites'); await tx.run('DELETE FROM used_refresh'); await tx.run('DELETE FROM sessions'); await tx.run('DELETE FROM voice_members');
      await tx.run('UPDATE coordinators SET user_id=NULL,epoch=epoch+1,expires_at=0');
      await tx.run('DELETE FROM users WHERE id<>?', [uid]);
      for (const server of await tx.all('SELECT id FROM servers')) await tx.run('INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)', [server.id, uid, 'owner', Date.now()]);
      await tx.run('UPDATE users SET username=? WHERE id=?', [b.username.toLowerCase(), uid]);
    } else await tx.run('INSERT INTO users(id,username,display_name,password_hash,instance_admin,created_at) VALUES(?,?,?,?,1,?)', [uid, b.username.toLowerCase(), b.displayName, encoded, Date.now()]);
    await tx.run("INSERT INTO meta(key,value) VALUES('admin_claimed',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [uid]);
    await audit(tx, uid, reset ? 'accounts.reset' : 'admin.initialize', uid);
  }); return { id: uid, username: b.username.toLowerCase() };
}
