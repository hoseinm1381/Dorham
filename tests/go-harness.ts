import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { config } from '../apps/api/src/config';

const synchronizers = new Map<string, () => Promise<void>>();
const fixtureSocketUrls = new WeakMap<object,string>();
export function bindGoFixtureSocket(socket:object,url:string) { fixtureSocketUrls.set(socket,url); }
export async function syncGoFixtureSocket(socket:object) { const url=fixtureSocketUrls.get(socket);if(url)await synchronizers.get(url)?.(); }

// This adapter runs the Go TEST binary, never the production server. Its random
// loopback-only fixture endpoint is absent from release builds.
export async function createGoApp(c: ReturnType<typeof config>) {
  const nonce = randomUUID();
  const keys: Record<string,string> = { dataDir:'DATA_DIR',databaseUrl:'DATABASE_URL',host:'HOST',port:'SERVER_PORT',publicUrl:'PUBLIC_URL',origins:'ALLOWED_ORIGINS',secure:'COOKIE_SECURE',bootstrapSecret:'BOOTSTRAP_ADMIN_SECRET',registrationOpen:'REGISTRATION_OPEN',maxUsers:'MAX_USERS',maxOnline:'MAX_ONLINE_USERS',maxVoice:'MAX_VOICE_PARTICIPANTS',roomShares:'MAX_ROOM_SHARES',globalShares:'MAX_GLOBAL_SHARES',retentionDays:'MESSAGE_RETENTION_DAYS',maxMessages:'MAX_MESSAGES',maxDatabaseMiB:'MAX_DATABASE_MIB',maxAvatarsMiB:'MAX_AVATARS_MIB',stunUrls:'STUN_URLS',turnUrls:'TURN_URLS',turnUsername:'TURN_USERNAME',turnPassword:'TURN_PASSWORD',turnSecret:'TURN_SECRET',cloudflareTurnKeyId:'CLOUDFLARE_TURN_KEY_ID',cloudflareTurnApiToken:'CLOUDFLARE_TURN_API_TOKEN',mediaTransport:'MEDIA_TRANSPORT',livekitUrl:'LIVEKIT_URL',livekitApiUrl:'LIVEKIT_API_URL',livekitKey:'LIVEKIT_API_KEY',livekitSecret:'LIVEKIT_API_SECRET',screenMaxBitrate:'SCREEN_MAX_BITRATE',screenMaxFrameRate:'SCREEN_MAX_FRAME_RATE',standardShareSlots:'STANDARD_SHARE_SLOTS',trustedProxies:'TRUSTED_PROXIES',guestsEnabled:'GUESTS_ENABLED',maxGuests:'MAX_GUESTS',attachmentDir:'ATTACHMENT_DIR',attachmentBudgetMiB:'ATTACHMENT_BUDGET_MIB',uploadReserveMiB:'UPLOAD_FREE_RESERVE_MIB',uploadConcurrency:'UPLOAD_CONCURRENCY',uploadSoftMiB:'UPLOAD_DAILY_SOFT_MIB',uploadHardMiB:'UPLOAD_DAILY_HARD_MIB',uploadSmallMiB:'UPLOAD_SMALL_FILE_MIB',mediaAdmissionSecret:'MEDIA_ADMISSION_SECRET',ttsIdleSeconds:'TTS_IDLE_SECONDS',ttsAudioCacheMiB:'TTS_AUDIO_CACHE_MIB' };
  const env: NodeJS.ProcessEnv={...process.env,NODE_ENV:'test',DORHAM_FIXTURE_NONCE:nonce};
  for(const [key,value] of Object.entries(c)){ if(keys[key])env[keys[key]]=Array.isArray(value)?value.join(','):String(value); }
  env.SERVER_PORT='3001'; env.DORHAM_FIXTURE_PORT='0';
  const child=spawn(path.resolve('artifacts/v1.1.0/dorham-fixture.exe'),[],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',errors=''; child.stderr.on('data',data=>{errors+=String(data)});
  const url=await new Promise<string>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Go fixture startup timeout '+errors)),15000);child.once('exit',code=>{clearTimeout(timeout);reject(Error(`Go fixture exited ${code}: ${errors}`))});child.stdout.on('data',data=>{output+=String(data);const line=output.split('\n').find(line=>line.startsWith('{'));if(line){try{const result=JSON.parse(line);if(result.fixtureURL){clearTimeout(timeout);resolve(result.fixtureURL)}}catch{/* incomplete stdout */}}});});
  const rawRpc=async(op:string,body:Record<string,unknown>={})=>{const response=await fetch(url+'/__fixture/'+nonce,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op,...body})});const result=await response.json();if(!response.ok)throw Error(JSON.stringify(result));return result;};
  const epoch=Date.now(), monotonic=performance.now();
  let pending:Promise<unknown>=Promise.resolve(), syncQueue:Promise<void>=Promise.resolve();
  const online=new Set<string>(), serverSockets=new Map<string,unknown>();
  const control=(action:string,extra:Record<string,unknown>={})=>rawRpc('control',{action,...extra});
  const gameHooks=(kind:'games'|'chess')=>({
    now:undefined as undefined|(()=>number),
    online:(uid:string)=>online.has(uid),
    get:async(uid:string,id:string)=>{await synchronize();return control(kind+'.get',{uid,id})},
    tick:async()=>{await synchronize();return control(kind+'.tick')},
    presence:async(uid:string,value:boolean)=>{await synchronize();return control(kind+'.presence',{uid,online:value})},
    reconcileVoice:async()=>{await synchronize();return control(kind+'.reconcileVoice')},
    close:()=>{pending=pending.then(()=>control(kind+'.close'))},
  });
  const games=gameHooks('games'), chess=gameHooks('chess');
  async function synchronize() {
    const run=async()=>{
      await pending;
      const offset=Date.now()-(epoch+performance.now()-monotonic);
      const state=await control('sync',{config:c,gameNow:games.now?.()??chess.now?.()??0,ticketOffset:Math.abs(offset)>1000?Math.round(offset):0});
      online.clear();for(const uid of state.online)online.add(uid);
      serverSockets.clear();for(const viewer of state.viewers)serverSockets.set(viewer.socketId,{id:viewer.socketId,data:{userId:viewer.userId,sessionId:viewer.sessionId}});
    };
    syncQueue=syncQueue.then(run,run);return syncQueue;
  }
  synchronizers.set(url,synchronize);
  const rpc=async(op:string,body:Record<string,unknown>={})=>{await synchronize();return rawRpc(op,body)};
  let closed=false;
  const close=async()=>{if(closed)return;closed=true;synchronizers.delete(url);await pending.catch(()=>{});await rawRpc('control',{action:'db.rollback'}).catch(()=>{});await rawRpc('shutdown').catch(()=>{});await new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();const timeout=setTimeout(()=>child.kill(),3000);child.once('exit',()=>{clearTimeout(timeout);resolve()})});};
  const inject=async(options: {method?:string;url:string;headers?:Record<string,unknown>;payload?:unknown})=>{await synchronize();const headers=Object.fromEntries(Object.entries(options.headers||{}).map(([key,value])=>[key,String(value)]));let body: BodyInit|undefined;if(options.payload!==undefined){if(Buffer.isBuffer(options.payload)||typeof options.payload==='string')body=options.payload as BodyInit;else{headers['Content-Type']='application/json';body=JSON.stringify(options.payload)}}const response=await fetch(url+options.url,{method:options.method||'GET',headers,body});const rawPayload=Buffer.from(await response.arrayBuffer());const content=rawPayload.toString();const cookies=response.headers.getSetCookie().map(raw=>{const [entry,...attributes]=raw.split(';').map(value=>value.trim()), separator=entry.indexOf('=');const parsed:Record<string,unknown>={name:entry.slice(0,separator),value:entry.slice(separator+1)};for(const attribute of attributes){const [name,value]=attribute.split('=');parsed[name.toLowerCase()==='httponly'?'httpOnly':name.toLowerCase()==='max-age'?'maxAge':name.toLowerCase()]=value??true}return parsed});return {statusCode:response.status,headers:Object.fromEntries(response.headers),cookies,body:content,payload:content,rawPayload,json:()=>JSON.parse(content)};};
  const db={one:async(query:string,args:unknown[]=[]) => (await rpc('db.one',{query,args})).value ?? undefined,all:(query:string,args:unknown[]=[])=>rpc('db.all',{query,args}),run:(query:string,args:unknown[]=[])=>rpc('db.run',{query,args}),backup:(destination:string)=>rpc('db.backup',{destination}),dialect:'sqlite',close};
  const transaction=async<T>(fn:(connection:typeof db)=>Promise<T>)=>{await synchronize();await control('db.begin');try{const result=await fn(db);await control('db.commit');return result}catch(error){await control('db.rollback');throw error}};
  Object.assign(db,{transaction});
  const service=new Proxy({db,c,notify:(kind:string,payload:unknown)=>control('hub.notify',{kind,payload})}, {get(target,key){if(key in target)return target[key as keyof typeof target];return (...args:unknown[])=>rpc('service',{name:String(key),args});}});
  const app={inject,close,listen:async()=>{},server:{address:()=>({port:Number(new URL(url).port)})}};
  return {app,db,service,config:c,url,close,games,chess,attachments:{cleanup:async()=>{await synchronize();return control('attachments.cleanup')}},io:{sockets:{sockets:serverSockets}}};
}
