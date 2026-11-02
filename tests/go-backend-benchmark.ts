import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {io,type Socket} from 'socket.io-client';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=net.createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as net.AddressInfo).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
const result:any[]=[];
async function run(engine:'node'|'go',pair:number){const dataDir=await mkdtemp(path.join(os.tmpdir(),'dorham-go-benchmark-'));const listen=await port(),url=`http://127.0.0.1:${listen}`,sockets:Socket[]=[];
 const env={...process.env,NODE_ENV:'test',DATA_DIR:dataDir,DATABASE_URL:'',ATTACHMENT_DIR:path.join(dataDir,'attachments'),SERVER_PORT:String(listen),HOST:'127.0.0.1',PUBLIC_URL:url,COOKIE_SECURE:'false',MEDIA_TRANSPORT:'mesh',STUN_URLS:'',TURN_URLS:'',CLOUDFLARE_TURN_KEY_ID:'',CLOUDFLARE_TURN_API_TOKEN:'',BOOTSTRAP_ADMIN_SECRET:'benchmark-private-fixture',MAX_USERS:'100',MAX_ONLINE_USERS:'20',MAX_VOICE_PARTICIPANTS:'16'};
 const child=spawn(engine==='node'?process.execPath:path.resolve('artifacts/v1.1.0/dorham-windows-amd64.exe'),engine==='node'?['deployment/start.mjs']:[],{env,windowsHide:true,stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',b=>errors+=String(b));
 async function api(route:string,token='',body?:any){const r=await fetch(url+'/api/v1'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Dorham-Native':'1',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify({requestId:randomUUID(),...body}):undefined});if(!r.ok)throw Error(`${engine} ${route} ${r.status} ${await r.text()}`);return r.json();}
 async function event(s:Socket,name:string,b:any={}){return new Promise<any>((resolve,reject)=>s.timeout(5000).emit(name,b,(err:any,r:any)=>err?reject(err):!r.ok?reject(Error(JSON.stringify(r.error))):resolve(r.data)));}
 try {let ready=false;for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(`${engine} startup ${errors}`);try{if((await fetch(url+'/ready')).ok){ready=true;break}}catch{/* startup */}await sleep(100)}if(!ready)throw Error('startup timeout '+errors);
 const users:Array<{accessToken:string}>=[];for(let i=0;i<20;i++)users.push(await api('/auth/register','',{username:'bench_'+i,displayName:'Benchmark '+i,password:'Private-benchmark-2026'}));
 await api('/admin/claim',users[0].accessToken,{secret:'benchmark-private-fixture'});const metrics=()=>api('/admin/metrics',users[0].accessToken);
 const server=await api('/servers',users[0].accessToken,{name:'Equivalent workload'}),invite=await api(`/servers/${server.id}/invites`,users[0].accessToken,{uses:100});for(const u of users.slice(1))await api('/invites/join',u.accessToken,{code:invite.code});
 const bootstrap=await api('/bootstrap',users[0].accessToken),voice=bootstrap.channels.find((c:any)=>c.kind==='voice'),text=bootstrap.channels.find((c:any)=>c.kind==='text'),second=await api(`/servers/${server.id}/channels`,users[0].accessToken,{name:'Voice two',kind:'voice'});
 const initial=await metrics();const latencies:number[]=[];const began=performance.now();
 for(let round=0;round<8;round++)await Promise.all(users.map(async u=>{const start=performance.now();await api('/bootstrap',u.accessToken);latencies.push(performance.now()-start)}));
 for(const u of users){const s=io(url,{transports:['websocket'],auth:{token:u.accessToken},reconnection:false});sockets.push(s);await new Promise<void>((resolve,reject)=>{s.once('connect',resolve);s.once('connect_error',reject)});}
 for(let i=0;i<20;i++)await event(sockets[i],'voice:join',{channelId:i<12?voice.id:second.id,eligible:true});
 for(let round=0;round<5;round++){await Promise.all(sockets.map(s=>event(s,'voice:heartbeat',{eligible:true})));await Promise.all(sockets.map(s=>event(s,'voice:state',{requestId:randomUUID(),muted:round%2===0,deafened:false})));await Promise.all(sockets.map(s=>event(s,'message:send',{requestId:randomUUID(),conversationId:text.conversationId,content:'Comparable English و فارسی '+round})));}
 const workloadMs=performance.now()-began,loaded=await metrics();for(const s of sockets)s.disconnect();await sleep(6000);const idle=await metrics();latencies.sort((a,b)=>a-b);const percentile=(p:number)=>latencies[Math.min(latencies.length-1,Math.floor(latencies.length*p))];
 result.push({engine,pair,users:20,bootstrapRequests:160,voiceJoins:20,heartbeats:100,stateChanges:100,messages:100,workloadMs,bootstrapMs:{p50:percentile(.5),p95:percentile(.95),p99:percentile(.99)},rssMiB:{initial:initial.memory.rss/1048576,loaded:loaded.memory.rss/1048576,afterSixSecondIdle:idle.memory.rss/1048576},cpuMicroseconds:{user:Number(loaded.cpu.user)-Number(initial.cpu.user),system:Number(loaded.cpu.system)-Number(initial.cpu.system)},ttsActive:false});console.log(JSON.stringify(result.at(-1)));
 }finally{sockets.forEach(s=>s.disconnect());child.kill();await new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',()=>resolve())});await rm(dataDir,{recursive:true,force:true});}}
for(const [pair,order] of [['a',['node','go']],['b',['go','node']]] as const)for(const engine of order)await run(engine,pair==='a'?1:2);
await writeFile('artifacts/evidence/v110-backend-benchmark.json',JSON.stringify({platform:process.platform,scope:'separate fresh production backend processes, equivalent synthetic chat/voice control workload; no physical media or Piper inference',result,productionChanged:false},null,2));
