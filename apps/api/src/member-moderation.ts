import type { Connection } from './db';
import type { Service } from './service';
import { canManage, type Role } from '@dorham/contracts';
import { canMoveMember, timeoutDurations, type MemberModerationInfo } from '../../../packages/contracts/src/moderation';
import { fail } from './security';
import { audit } from './accounts';

async function powers(service: Service, tx: Connection, actorId: string, serverId: string, targetId: string) {
 const actor = await service.member(tx, actorId, serverId), target = await service.member(tx, targetId, serverId);
 const actorRole = await service.authority(tx, actor), targetRole = await service.authority(tx, target);
 const p = await service.memberPermissions(tx, actor.role, actorId, serverId);
 const account = await tx.one('SELECT instance_admin FROM users WHERE id=?', [targetId]);
 const protectedTarget = actorId === targetId || (!actor.globalAdmin && account?.instance_admin);
 const higher = !protectedTarget && canManage(actorRole, targetRole);
 return { target, targetRole, actions: { voice: Boolean(p.moderate && higher), move: Boolean(p.moderate && !protectedTarget && canMoveMember(actorRole, targetRole)), timeout: Boolean(p.moderate && higher), kick: Boolean(p.manageMembers && higher), ban: Boolean(p.manageMembers && higher) } };
}
export async function moderationInfo(service: Service, actorId: string, serverId: string, targetId: string): Promise<MemberModerationInfo> {
 return service.db.transaction(async tx => {
  const { target, targetRole, actions } = await powers(service, tx, actorId, serverId, targetId);
  const vm = await tx.one('SELECT v.* FROM voice_members v JOIN channels c ON c.id=v.channel_id WHERE v.user_id=? AND c.server_id=?', [targetId, serverId]);
  const restriction = vm && await tx.one('SELECT sharing_allowed FROM voice_restrictions WHERE user_id=? AND channel_id=?', [targetId, vm.channel_id]);
  return { userId: targetId, role: targetRole, timeoutUntil: Number(target.timeout_until || 0), actions, voice: vm ? { channelId: vm.channel_id, serverMuted: Boolean(vm.server_muted), serverDeafened: Boolean(vm.server_deafened), sharingAllowed: restriction?.sharing_allowed !== 0 } : null };
 });
}
export async function moderateMember(service: Service, actorId: string, rid: string, serverId: string, targetId: string, body: { action: 'kick' | 'ban' | 'unban' | 'timeout' | 'untimeout'; seconds?: number; reason?: string }) {
 const result = await service.mutate(actorId, rid, 'member.moderate', { serverId, targetId, ...body }, async tx => {
  if (body.action === 'unban') {
   const actor = await service.member(tx, actorId, serverId, 'manageMembers');
   const ban = await tx.one('SELECT * FROM server_bans WHERE server_id=? AND user_id=?', [serverId, targetId]);
   if (!ban) fail(404, 'NOT_BANNED', 'This user is not banned from this server.');
   if (!canManage(await service.authority(tx, actor), ban!.target_role as Role)) fail(403, 'HIERARCHY', 'You cannot manage this role.');
   await tx.run('DELETE FROM server_bans WHERE server_id=? AND user_id=?', [serverId, targetId]);
  } else {
   const { targetRole, actions } = await powers(service, tx, actorId, serverId, targetId);
   if (!actions[body.action === 'untimeout' ? 'timeout' : body.action]) fail(403, 'HIERARCHY', 'You cannot moderate this member.');
   if (body.action === 'timeout' || body.action === 'untimeout') {
    if (body.action === 'timeout' && !timeoutDurations.includes(body.seconds as any)) fail(400, 'INVALID_TIMEOUT', 'Choose a timeout duration.');
    if (body.action === 'timeout') await tx.run('INSERT INTO server_timeouts(server_id,user_id,actor_id,expires_at,reason) VALUES(?,?,?,?,?) ON CONFLICT(server_id,user_id) DO UPDATE SET actor_id=excluded.actor_id,expires_at=excluded.expires_at,reason=excluded.reason', [serverId, targetId, actorId, Date.now() + body.seconds! * 1000, body.reason || '']);
    else await tx.run('DELETE FROM server_timeouts WHERE server_id=? AND user_id=?', [serverId, targetId]);
   } else {
    if (body.action === 'ban') await tx.run('INSERT INTO server_bans(server_id,user_id,actor_id,target_role,reason,created_at) VALUES(?,?,?,?,?,?)', [serverId, targetId, actorId, targetRole, body.reason || '', Date.now()]);
    await tx.run('DELETE FROM user_tags WHERE user_id=? AND tag_id IN (SELECT id FROM tags WHERE server_id=?)', [targetId, serverId]);
    await tx.run('DELETE FROM members WHERE server_id=? AND user_id=?', [serverId, targetId]);
   }
   if (body.action !== 'untimeout') await tx.run('DELETE FROM voice_members WHERE user_id=? AND channel_id IN (SELECT id FROM channels WHERE server_id=?)', [targetId, serverId]);
  }
  await audit(tx, actorId, `member.${body.action}`, targetId, { serverId, seconds: body.seconds, reason: body.reason });
  return { success: true };
 });
 await service.notify('state:changed', {}); await service.notify('voice:changed', {}); return result;
}
export async function serverBans(service: Service, actorId: string, serverId: string) {
 return service.db.transaction(async tx => {
  const actor = await service.member(tx, actorId, serverId, 'manageMembers'), role = await service.authority(tx, actor);
  return { bans: (await tx.all('SELECT b.user_id,b.reason,b.created_at,b.target_role,u.display_name FROM server_bans b JOIN users u ON u.id=b.user_id WHERE b.server_id=? ORDER BY b.created_at DESC', [serverId])).map(b => ({ userId: b.user_id, displayName: b.display_name, reason: b.reason, createdAt: Number(b.created_at), canUnban: canManage(role, b.target_role as Role) })) };
 });
}
