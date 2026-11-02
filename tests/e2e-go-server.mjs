import {spawn} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const dataDir=await mkdtemp(path.join(os.tmpdir(),'dorham-browser-go-'));
const nonce=process.env.DORHAM_FIXTURE_NONCE||randomUUID();
if(process.env.DORHAM_FIXTURE_MANIFEST)await writeFile(process.env.DORHAM_FIXTURE_MANIFEST,JSON.stringify({nonce,dataDir,pid:process.pid}));
const isolated=process.env.DORHAM_SFU_ISOLATED_TEST==='1';
const env={...process.env,DATA_DIR:dataDir,DATABASE_URL:'',ATTACHMENT_DIR:path.join(dataDir,'attachments'),SERVER_PORT:'3101',DORHAM_FIXTURE_PORT:'3101',DORHAM_FIXTURE_NONCE:nonce,NODE_ENV:'test',COOKIE_SECURE:'false',PUBLIC_URL:'http://127.0.0.1:3101',ALLOWED_ORIGINS:'http://127.0.0.1:3101,dorham://app,capacitor://localhost,https://localhost',BOOTSTRAP_ADMIN_SECRET:'browser-fixture-bootstrap-not-for-deployment',MAX_USERS:'100',MAX_ROOM_SHARES:'0',MAX_GLOBAL_SHARES:'0',STUN_URLS:'',...(!isolated?{MEDIA_TRANSPORT:'mesh',TURN_URLS:'',TURN_USERNAME:'',TURN_PASSWORD:'',TURN_SECRET:'',CLOUDFLARE_TURN_KEY_ID:'',CLOUDFLARE_TURN_API_TOKEN:''}:{})};
const child=spawn(path.resolve('artifacts/v1.1.0/dorham-fixture.exe'),[],{env,windowsHide:true,stdio:['ignore','inherit','inherit']});
let stopping=false;
async function close(){if(stopping)return;stopping=true;await fetch('http://127.0.0.1:3101/__fixture/'+nonce,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'shutdown'}),signal:AbortSignal.timeout(2000)}).catch(()=>child.kill());}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void close()});
child.once('error',error=>{console.error(error.message);process.exitCode=1});
const code=await new Promise(resolve=>child.once('exit',resolve));
// The browser guard owns cleanup, including isolated SFU rooms. Preserve its
// temporary DB until that cleanup has inspected the fixture's channel IDs.
process.exitCode=typeof code==='number'?code:1;
