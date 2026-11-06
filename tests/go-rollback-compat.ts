import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import Sqlite from 'better-sqlite3';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';
import { createGoApp } from './go-harness';

const dataDir=await mkdtemp(path.join(os.tmpdir(),'dorham-go-rollback-'));
const c=config({dataDir,databaseUrl:'',mediaTransport:'mesh',production:false,secure:false,stunUrls:[],turnUrls:[],turnSecret:'',cloudflareTurnKeyId:'',cloudflareTurnApiToken:'',uploadReserveMiB:1});
let node:Awaited<ReturnType<typeof createApp>>|undefined;
let go:Awaited<ReturnType<typeof createGoApp>>|undefined;
type Inject={inject:(options:any)=>Promise<any>};
let app:Inject;
const checks: Record<string,boolean>={};
async function request(route:string,token='',body?:any,method=body?'POST':'GET') {const response=await app.inject({method,url:'/api/v1'+route,headers:{'x-dorham-native':'1',...(token?{authorization:'Bearer '+token}:{})},payload:body});assert.ok(response.statusCode>=200&&response.statusCode<300,`${route}: ${response.statusCode} ${response.body}`);return response.json();}
const body=(value:any)=>({requestId:randomUUID(),...value});
async function register(username:string){return request('/auth/register','',body({username,displayName:username,password:'Compatibility-سلام-123'}));}
try {
 node=await createApp(c,{logger:false,rateLimit:false});app=node.app;
 const a=await register('compat_owner'),b=await register('compat_peer');
 const createServer=body({name:'Go rollback bilingual سلام'}),server=await request('/servers',a.accessToken,createServer);
 const invite=await request(`/servers/${server.id}/invites`,a.accessToken,body({}));await request('/invites/join',b.accessToken,body({code:invite.code}));
 const snapshot=await request('/bootstrap',a.accessToken),channel=snapshot.channels.find((v:any)=>v.kind==='text');
 const messageBody=body({conversationId:channel.conversationId,content:'Persistent سلام @compat_peer'});
 const message=await request('/messages',a.accessToken,messageBody);await request(`/messages/${message.payload.id}`,b.accessToken,body({emoji:'👍'}),'PATCH');
 const bytes=await sharp({create:{width:24,height:16,channels:3,background:'#65b6a4'}}).png().toBuffer();
 const attachment=await request('/attachments',a.accessToken,body({conversationId:channel.conversationId,name:'rollback.png',size:bytes.length}));
 const upload=await app.inject({method:'POST',url:`/api/v1/attachments/${attachment.id}/content`,headers:{authorization:'Bearer '+a.accessToken,'content-type':'application/octet-stream','content-length':String(bytes.length)},payload:bytes});assert.equal(upload.statusCode,200);
 await request('/messages',a.accessToken,body({conversationId:channel.conversationId,content:'Preserved upload',attachmentIds:[attachment.id]}));
 const backup=path.join(dataDir,'before-go.sqlite');await node.db.backup(backup);const backupDB=new Sqlite(backup,{readonly:true});assert.equal((backupDB.prepare('PRAGMA integrity_check').get() as any).integrity_check,'ok');backupDB.close();
 await node.app.close();node=undefined;

 go=await createGoApp(c);app=go.app;
 assert.equal((await request('/auth/me',a.accessToken)).user.id,a.user.id);
 assert.equal((await request('/auth/login','',body({username:'compat_owner',password:'Compatibility-سلام-123'}))).user.id,a.user.id);checks.nodePasswordsAndSessionsAccepted=true;
 assert.equal((await request('/servers',a.accessToken,createServer)).id,server.id);
 const retry=await request('/messages',a.accessToken,messageBody);assert.equal(retry.payload.id,message.payload.id);checks.nodeReceiptsReplayWithoutDuplicate=true;
 const history=await request(`/conversations/${channel.conversationId}/messages`,b.accessToken);assert.equal(history.messages.length,2);assert.equal(history.messages[0].mentions[0].userId,b.user.id);assert.equal(history.messages[0].reactions[0].emoji,'👍');checks.historyMentionsReactionsPreserved=true;
 const download=await app.inject({method:'GET',url:`/api/v1/attachments/${attachment.id}/download`,headers:{authorization:'Bearer '+b.accessToken}});assert.equal(download.statusCode,200);assert.equal(createHash('sha256').update(download.rawPayload).digest('hex'),createHash('sha256').update(bytes).digest('hex'));checks.nodeAttachmentReadableByGo=true;
 const renewed=await request('/auth/refresh','',body({refreshToken:b.refreshToken}));
 const fresh=await register('go_created');
 const goServerBody=body({name:'Created by Go'}),goServer=await request('/servers',a.accessToken,goServerBody);
 const goMessageBody=body({conversationId:channel.conversationId,content:'Go writes English و فارسی'}),goMessage=await request('/messages',a.accessToken,goMessageBody);
 const goAttachment=await request('/attachments',a.accessToken,body({conversationId:channel.conversationId,name:'go.png',size:bytes.length}));
 const uploaded=await app.inject({method:'POST',url:`/api/v1/attachments/${goAttachment.id}/content`,headers:{authorization:'Bearer '+a.accessToken,'content-type':'application/octet-stream','content-length':String(bytes.length)},payload:bytes});assert.equal(uploaded.statusCode,200);
 await request('/messages',a.accessToken,body({conversationId:channel.conversationId,content:'Go upload',attachmentIds:[goAttachment.id]}));
 const retired = await register('go_retired');
 await go.db.run('UPDATE users SET instance_admin=1 WHERE id=?', [a.user.id]);
 const retiredChat = await request('/dms',renewed.accessToken,body({userId:retired.user.id}));
 await request('/messages',retired.accessToken,body({conversationId:retiredChat.id,content:'Retained across rollback'}));
 await request(`/admin/users/${retired.user.id}`,a.accessToken,body({action:'delete',confirmUsername:'go_retired'}));
 await go.close();go=undefined;

 node=await createApp(c,{logger:false,rateLimit:false});app=node.app;
 assert.equal((await request('/auth/login','',body({username:'go_created',password:'Compatibility-سلام-123'}))).user.id,fresh.user.id);checks.goPasswordsAcceptedByNode=true;
 assert.equal((await request('/auth/me',renewed.accessToken)).user.id,b.user.id);const nextRefresh=await request('/auth/refresh','',body({refreshToken:renewed.refreshToken}));assert.ok(nextRefresh.accessToken);checks.goNativeRefreshSurvivesRollback=true;
 assert.equal((await request('/servers',a.accessToken,goServerBody)).id,goServer.id);
 assert.equal((await request('/messages',a.accessToken,goMessageBody)).payload.id,goMessage.payload.id);checks.goReceiptsReplayOnNode=true;
 const after=await request(`/conversations/${channel.conversationId}/messages`,a.accessToken);assert.equal(after.messages.length,4);assert.equal(after.messages[2].content,goMessageBody.content);checks.goWritesPreservedOnRollback=true;
 const returned=await app.inject({method:'GET',url:`/api/v1/attachments/${goAttachment.id}/download`,headers:{authorization:'Bearer '+a.accessToken}});assert.equal(returned.statusCode,200);assert.deepEqual(returned.rawPayload,bytes);checks.goAttachmentReadableByNode=true;
 const retained=await request(`/conversations/${retiredChat.id}/messages`,nextRefresh.accessToken);
 assert.equal(retained.messages[0].author.displayName,'Deleted account');assert.equal(retained.messages[0].author.deleted,true);
 assert.equal((await request('/admin/users',a.accessToken)).users.some((u:any)=>u.id===retired.user.id),false);
 const rejected=await app.inject({method:'POST',url:`/api/v1/admin/users/${retired.user.id}`,headers:{authorization:'Bearer '+a.accessToken},payload:body({action:'unban'})});
 assert.equal(rejected.statusCode,409);checks.deletedAccountRemainsRetiredAfterRollback=true;
 assert.equal((await node.db.one('PRAGMA integrity_check'))!.integrity_check,'ok');assert.equal((await node.db.all('PRAGMA foreign_key_check')).length,0);assert.equal((await node.db.one('SELECT MAX(version) AS version FROM schema_migrations'))!.version,13);checks.integrityAndSchema13=true;
 await writeFile('artifacts/evidence/v110-node-go-node-rollback.json',JSON.stringify({passed:true,checks,databaseSchema:13,fixture:'private temporary synthetic accounts/uploads only',productionChanged:false},null,2));console.log(JSON.stringify({passed:true,checks}));
} finally {await go?.close();await node?.app.close();await rm(dataDir,{recursive:true,force:true});}
