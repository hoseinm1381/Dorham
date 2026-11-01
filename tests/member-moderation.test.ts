import { beforeEach, afterEach, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, event } from './helpers';
let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });
async function setup() {
 const owner = await h.register('mod_owner'), admin = await h.register('mod_admin'), peer = await h.register('mod_peer'), mod = await h.register('mod_moderator'), member = await h.register('mod_member');
 const server = (await h.api(owner, '/servers', { name: 'Moderation lab' })).json();
 const invite = (await h.api(owner, `/servers/${server.id}/invites`, {})).json();
 for (const u of [admin, peer, mod, member]) expect((await h.api(u, '/invites/join', { code: invite.code })).statusCode).toBe(200);
 for (const [u, role] of [[admin,'administrator'],[peer,'administrator'],[mod,'moderator']] as const) expect((await h.api(owner, `/servers/${server.id}/members/${u.id}`, { role }, 'PATCH')).statusCode).toBe(200);
 const channels = (await h.api(owner, '/bootstrap')).json().channels;
 return { owner, admin, peer, mod, member, server, invite, voice: channels.find((c: any) => c.kind === 'voice'), text: channels.find((c: any) => c.kind === 'text') };
}
const moderate = (a: any, s: string, u: string, action: string, extra = {}) => h.api(a, `/servers/${s}/members/${u}/moderate`, { action, ...extra });
it('protects peers and the owner from punishment while advertising peer voice moves', async () => {
 const x = await setup();
 for (const action of ['ban','kick','timeout']) {
  expect((await moderate(x.admin, x.server.id, x.peer.id, action, { seconds: 60 })).statusCode).toBe(403);
  expect((await moderate(x.admin, x.server.id, x.owner.id, action, { seconds: 60 })).statusCode).toBe(403);
  expect((await moderate(x.mod, x.server.id, x.admin.id, action, { seconds: 60 })).statusCode).toBe(403);
 }
 expect((await h.api(x.admin, `/servers/${x.server.id}/members/${x.peer.id}/moderation`)).json().actions).toEqual({ voice:false, move:true, timeout:false, kick:false, ban:false });
 expect((await moderate(x.owner,x.server.id,x.admin.id,'ban')).statusCode).toBe(200);
 expect((await moderate(x.peer,x.server.id,x.admin.id,'unban')).statusCode).toBe(403);
 expect((await moderate(x.owner,x.server.id,x.admin.id,'unban')).statusCode).toBe(200);
});
it('enforces a persistent server ban without banning the account elsewhere', async () => {
 const x = await setup(), socket = await h.connect(x.member);
 await event(socket,'voice:join',{channelId:x.voice.id,eligible:true});
 const removed = new Promise(resolve => socket.once('voice:removed',resolve));
 const rid=randomUUID();
 expect((await moderate(x.mod,x.server.id,x.member.id,'ban',{reason:'test reason',requestId:rid})).statusCode).toBe(200); await removed;
 expect((await moderate(x.mod,x.server.id,x.member.id,'ban',{reason:'test reason',requestId:rid})).statusCode).toBe(200);
 expect(await h.db.one('SELECT * FROM voice_members WHERE user_id=?',[x.member.id])).toBeUndefined();
 expect((await h.api(x.member,'/invites/join',{code:x.invite.code})).json().error.code).toBe('SERVER_BANNED');
 expect((await h.api(x.member,`/conversations/${x.text.conversationId}/messages`)).statusCode).toBe(403);
 await expect(event(socket,'voice:join',{channelId:x.voice.id,eligible:false})).rejects.toThrow('SERVER_BANNED');
 expect((await h.api(x.member,'/auth/me')).statusCode).toBe(200);
 const bans=(await h.api(x.owner,`/servers/${x.server.id}/bans`)).json().bans;expect(bans[0]).toMatchObject({userId:x.member.id,reason:'test reason',canUnban:true});
 expect((await moderate(x.admin,x.server.id,x.member.id,'unban')).statusCode).toBe(200);
 expect((await h.api(x.member,'/invites/join',{code:x.invite.code})).statusCode).toBe(200);
});
it('blocks chat, reactions and voice during timeout, including after leave and rejoin', async () => {
 const x=await setup(), socket=await h.connect(x.member);
 const msg=(await h.api(x.owner,'/messages',{conversationId:x.text.conversationId,content:'hello'})).json().payload;
 await event(socket,'voice:join',{channelId:x.voice.id,eligible:true});
 expect((await moderate(x.mod,x.server.id,x.member.id,'timeout',{seconds:600})).statusCode).toBe(200);
 expect(await h.db.one('SELECT * FROM voice_members WHERE user_id=?',[x.member.id])).toBeUndefined();
 expect((await h.api(x.member,'/messages',{conversationId:x.text.conversationId,content:'blocked'})).json().error.code).toBe('TIMED_OUT');
 expect((await h.api(x.member,`/messages/${msg.id}`,{emoji:'👍'},'PATCH')).statusCode).toBe(403);
 await expect(event(socket,'voice:join',{channelId:x.voice.id,eligible:false})).rejects.toThrow('TIMED_OUT');
 expect((await h.api(x.member,`/conversations/${x.text.conversationId}/messages`)).statusCode).toBe(200);
 expect((await h.api(x.member,`/servers/${x.server.id}/leave`,{})).statusCode).toBe(200);
 expect((await h.api(x.member,'/invites/join',{code:x.invite.code})).statusCode).toBe(200);
 expect((await h.api(x.member,'/messages',{conversationId:x.text.conversationId,content:'still blocked'})).statusCode).toBe(403);
 const dm=(await h.api(x.member,'/dms',{userId:x.peer.id})).json();expect((await h.api(x.member,'/messages',{conversationId:dm.id,content:'DM allowed'})).statusCode).toBe(200);
 expect((await moderate(x.admin,x.server.id,x.member.id,'untimeout')).statusCode).toBe(200);
 expect((await h.api(x.member,'/messages',{conversationId:x.text.conversationId,content:'allowed'})).statusCode).toBe(200);
 await event(socket,'voice:join',{channelId:x.voice.id,eligible:false});
});
it('expires timeouts automatically and does not let timed-out moderators act or lose rank protection', async () => {
 const x=await setup();
 expect((await moderate(x.admin,x.server.id,x.mod.id,'timeout',{seconds:60})).statusCode).toBe(200);
 expect((await moderate(x.mod,x.server.id,x.member.id,'ban')).statusCode).toBe(403);
 await h.db.run('UPDATE server_timeouts SET expires_at=? WHERE server_id=? AND user_id=?',[Date.now()-1,x.server.id,x.mod.id]);
 await h.service.cleanup();
 expect(await h.db.one('SELECT * FROM server_timeouts WHERE user_id=?',[x.mod.id])).toBeUndefined();
 expect((await moderate(x.mod,x.server.id,x.member.id,'timeout',{seconds:60})).statusCode).toBe(200);
 expect((await moderate(x.owner,x.server.id,x.mod.id,'timeout',{seconds:42})).statusCode).toBe(400);
});
it('moves peer admins, but respects the owner, destination capacity and cross-server boundaries', async () => {
 const x=await setup(), socket=await h.connect(x.peer);
 await event(socket,'voice:join',{channelId:x.voice.id,eligible:true});
 const dest=(await h.api(x.owner,`/servers/${x.server.id}/channels`,{name:'Destination',kind:'voice'})).json();
 const move=new Promise<any>(resolve=>socket.once('voice:move',resolve));
 expect((await h.api(x.admin,`/voice/${x.voice.id}/move`,{userId:x.peer.id,channelId:dest.id})).statusCode).toBe(200);expect((await move).channelId).toBe(dest.id);
 await event(socket,'voice:join',{channelId:dest.id,eligible:true});
 const ownerSocket=await h.connect(x.owner);await event(ownerSocket,'voice:join',{channelId:x.voice.id,eligible:true});
 expect((await h.api(x.admin,`/voice/${x.voice.id}/move`,{userId:x.owner.id,channelId:dest.id})).statusCode).toBe(403);
 await h.db.run('UPDATE channels SET user_limit=1 WHERE id=?',[x.voice.id]);
 expect((await h.api(x.admin,`/voice/${dest.id}/move`,{userId:x.peer.id,channelId:x.voice.id})).json().error.code).toBe('ROOM_FULL');
 expect((await h.db.one('SELECT channel_id FROM voice_members WHERE user_id=?',[x.peer.id]))!.channel_id).toBe(dest.id);
 const outsiderServer=(await h.api(x.owner,'/servers',{name:'Other'})).json();const other=(await h.api(x.owner,'/bootstrap')).json().channels.find((c:any)=>c.serverId===outsiderServer.id&&c.kind==='voice');
 expect((await h.api(x.owner,`/voice/${dest.id}/move`,{userId:x.peer.id,channelId:other.id})).statusCode).toBe(400);
});
