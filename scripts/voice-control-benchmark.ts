import { harness, event } from '../tests/helpers';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
// Isolated control-plane workload. Registration is outside the timed region;
// no external SFU is contacted and no media capacity result is implied.
const h=await harness({roomShares:0,globalShares:0});
try {
 const users=[];for(let i=0;i<10;i++)users.push(await h.register(`bench${i}`));
 const server=(await h.api(users[0],'/servers',{name:'CPU benchmark'})).json(),invite=(await h.api(users[0],`/servers/${server.id}/invites`,{uses:10})).json();for(const u of users.slice(1))await h.api(u,'/invites/join',{code:invite.code});
 const b=(await h.api(users[0],'/bootstrap')).json(),voice=b.channels.find((c:any)=>c.kind==='voice');const sockets=[];for(const u of users)sockets.push(await h.connect(u));for(const s of sockets)await event(s,'voice:join',{channelId:voice.id,eligible:true});for(const s of sockets.slice(0,3))await event(s,'share:start',{requestId:randomUUID()});
 h.config.mediaTransport='livekit';
 let reads=0,writes=0;const transaction=h.db.transaction.bind(h.db);h.db.transaction=fn=>transaction(tx=>fn({...tx,all:async(q,p)=>{reads++;return tx.all(q,p);},one:async(q,p)=>{reads++;return tx.one(q,p);},run:async(q,p)=>{writes++;await tx.run(q,p);}}));for(const key of ['all','one','run'] as const){const original=h.db[key].bind(h.db);(h.db as any)[key]=async(...args:any[])=>{if(key==='run')writes++;else reads++;return(original as any)(...args);};}
 const cpu=process.cpuUsage(),start=performance.now();for(let round=0;round<10;round++)for(const s of sockets)await event(s,'voice:heartbeat',{eligible:true});for(let i=0;i<10;i++)await h.service.notify('voice:changed',{});
 const spent=process.cpuUsage(cpu);const result={label:'current-sfu',node:process.version,clients:10,shares:3,heartbeats:100,voiceNotifications:10,sqlReads:reads,sqlWrites:writes,elapsedMs:performance.now()-start,cpuMs:(spent.user+spent.system)/1000,rssMiB:process.memoryUsage().rss/1048576};await mkdir('artifacts/evidence',{recursive:true});await writeFile('artifacts/evidence/cpu-control-current-sfu.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await h.close();}
