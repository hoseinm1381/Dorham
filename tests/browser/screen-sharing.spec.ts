import { completeRecovery } from './recovery-helper';
import {test,expect,type Page} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
test.use({trace:'off',actionTimeout:12000});
async function register(p:Page,name:string){await p.goto('/');await p.getByRole('button',{name:'Create an account',exact:true}).click();await p.getByLabel('Display name',{exact:true}).fill(name);await p.getByLabel('Username',{exact:true}).fill(name);await p.getByLabel('Password',{exact:true}).fill('Synthetic-sharing-2026');await p.getByRole('button',{name:'Create account',exact:true}).click();await completeRecovery(p); await expect(p.locator('.app')).toBeVisible();}
async function api(p:Page,route:string,body?:any){return p.evaluate(async({route,body})=>{const me=await(await fetch('/api/v1/auth/me')).json(),r=await fetch('/api/v1'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrf},body:body?JSON.stringify({requestId:crypto.randomUUID(),...body}):undefined});if(!r.ok)throw Error(await r.text());return r.json();},{route,body});}
async function instrument(p:Page){await p.addInitScript(()=>{
  const Peer=RTCPeerConnection;(window as any).__sharePeers=[];(window as any).RTCPeerConnection=new Proxy(Peer,{construct(T,args){const pc=new T(args[0]);(window as any).__sharePeers.push(pc);return pc;}});
  (window as any).__captures=[];navigator.mediaDevices.getDisplayMedia=async constraints=>{(window as any).__captures.push(constraints);if((window as any).__cancelCapture)throw new DOMException('Capture cancelled','NotAllowedError');const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const c=canvas.getContext('2d')!;let n=0;const timer=setInterval(()=>{c.fillStyle=n++%2?'#9b7fec':'#3cb59d';c.fillRect(0,0,640,360);c.fillStyle='#fff';c.fillText(String(n),n%500,100);},33),stream=canvas.captureStream(30);if(constraints?.audio){const audio=new AudioContext(),tone=audio.createOscillator(),gain=audio.createGain(),out=audio.createMediaStreamDestination();tone.frequency.value=640;gain.gain.value=.04;tone.connect(gain).connect(out);tone.start();void audio.resume();stream.addTrack(out.stream.getAudioTracks()[0]);stream.getVideoTracks()[0].addEventListener('ended',()=>{tone.stop();void audio.close();});}stream.getTracks()[0].addEventListener('ended',()=>clearInterval(timer));return stream;};
});}
async function limits(p:Page){return p.evaluate(()=>(window as any).__sharePeers.flatMap((pc:RTCPeerConnection)=>pc.getSenders().filter(sender=>sender.track?.kind==='video').flatMap(sender=>sender.getParameters().encodings.map(e=>({bitrate:e.maxBitrate,fps:e.maxFramerate})))));}

async function configure(p:Page, quality:string, bitrate:number, starting=false, sound=false){
  await p.getByRole('button',{name:starting?'Share screen':'Adjust sharing settings',exact:true}).click();
  const popup=p.getByRole('dialog',{name:'Screen sharing',exact:true});
  await popup.getByRole('button',{name:'Advanced',exact:true}).click();
  await popup.getByRole('combobox',{name:'Screen resolution',exact:true}).selectOption(quality.startsWith('480')?'480':'720');
  await popup.getByRole('combobox',{name:'Screen FPS',exact:true}).selectOption(quality.endsWith('30')?'30':'15');
  await popup.getByRole('combobox',{name:'Screen bandwidth',exact:true}).selectOption(String(bitrate));
  if(starting&&sound)await popup.getByRole('checkbox',{name:'Share sound',exact:true}).check();
  await popup.getByRole('button',{name:starting?'Choose screen':'Apply sharing settings',exact:true}).click();
  await expect(popup).toBeHidden();
}
test('sharing popup applies every bandwidth live without recapture and preserves leases, rewatching and saved preferences',async({browser})=>{
  const contexts=await Promise.all([browser.newContext({permissions:['microphone']}),browser.newContext({permissions:['microphone']})]),[a,b]=await Promise.all(contexts.map(c=>c.newPage())),errors:string[]=[];
  try{
    for(const p of [a,b]){p.on('pageerror',e=>errors.push(e.message));await instrument(p);}const suffix=Date.now().toString().slice(-7);await register(a,'ShareA'+suffix);await register(b,'ShareB'+suffix);
    const server=await api(a,'/servers',{name:'Sharing controls'}),invite=await api(a,`/servers/${server.id}/invites`,{uses:5});await api(b,'/invites/join',{code:invite.code});
    for(const p of [a,b]){await p.getByRole('button',{name:'Open Sharing controls',exact:true}).click();await p.getByRole('button',{name:'Lounge',exact:true}).click();}
    const withAudio=process.env.MEDIA_TRANSPORT==='livekit',reserve=withAudio?48000:0;
    await expect(a.getByRole('combobox',{name:'Screen bandwidth',exact:true})).toHaveCount(0);await configure(a,'480p30',1500000,true,withAudio);
    await b.getByRole('button',{name:'Watch stream',exact:true}).click();await expect.poll(()=>b.locator('.screen video').evaluate((v:HTMLVideoElement)=>v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(5);
    await expect.poll(()=>limits(a)).toEqual([{bitrate:1500000-reserve,fps:30}]);expect(await a.evaluate(()=>(window as any).__captures[0].video.height.ideal)).toBe(480);
    const channel=(await api(a,'/bootstrap')).channels.find((c:any)=>c.kind==='voice'),lease=(await api(a,`/voice/${channel.id}`)).shares[0].id;
    const results=[];for(const n of [300000,450000,600000,750000,900000,1050000,1200000,1350000,1500000]){await configure(a,'480p30',n);await expect.poll(()=>limits(a)).toEqual([{bitrate:n-reserve,fps:30}]);results.push(await limits(a));}
    await configure(a,'720p15',1500000);await expect.poll(()=>limits(a)).toEqual([{bitrate:1500000-reserve,fps:15}]);await configure(a,'480p30',1500000);await expect.poll(()=>limits(a)).toEqual([{bitrate:1500000-reserve,fps:30}]);
    expect((await api(a,`/voice/${channel.id}`)).shares[0].id).toBe(lease);expect(await a.evaluate(()=>(window as any).__captures.length)).toBe(1);
    await b.getByRole('button',{name:'Close stream',exact:true}).click();await b.getByRole('button',{name:'Watch stream',exact:true}).click();await expect.poll(()=>b.locator('.screen video').evaluate((v:HTMLVideoElement)=>v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(5);
    await a.getByRole('button',{name:'Adjust sharing settings',exact:true}).click();await a.getByRole('button',{name:'Advanced',exact:true}).click();
    await a.screenshot({path:`artifacts/evidence/v075-sharing-${withAudio?'sfu':'mesh'}-desktop.png`});await a.setViewportSize({width:390,height:844});
    expect(await a.locator('.modal').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await a.screenshot({path:`artifacts/evidence/v075-sharing-${withAudio?'sfu':'mesh'}-mobile.png`});
    await a.getByRole('button',{name:'Close dialog',exact:true}).click();await a.setViewportSize({width:1280,height:720});
    await a.getByRole('button',{name:'Stop sharing',exact:true}).click();await expect(b.locator('.screen video')).toHaveCount(0);await a.reload();await a.getByRole('button',{name:'Open Sharing controls',exact:true}).click();await a.getByRole('button',{name:'Lounge',exact:true}).click();
    await a.getByRole('button',{name:'Share screen',exact:true}).click();await a.getByRole('button',{name:'Advanced',exact:true}).click();await expect(a.getByLabel('Screen resolution',{exact:true})).toHaveValue('480');await expect(a.getByLabel('Screen FPS',{exact:true})).toHaveValue('30');await expect(a.getByLabel('Screen bandwidth',{exact:true})).toHaveValue('1500000');
    await a.evaluate(()=>(window as any).__cancelCapture=true);await a.getByRole('button',{name:'Choose screen',exact:true}).click();await expect(a.getByRole('button',{name:'Choose screen',exact:true})).toBeEnabled();await expect.poll(async()=>(await api(a,`/voice/${channel.id}`)).shares.length).toBe(0);
    expect(errors).toEqual([]);await writeFile(`artifacts/evidence/v075-screen-sharing-${withAudio?'sfu':'mesh'}-browser.json`,JSON.stringify({transport:process.env.MEDIA_TRANSPORT||'mesh',popupOnly:true,startingChoiceHonored:true,bandwidths:results,sharedAudioWithinBudget:withAudio,liveChangesNoRecapture:true,sameLease:true,rewatchKeepsLimit:true,persisted:true,cancelReleasesLease:true,mobileNoOverflow:true,errors},null,2));
  }finally{await Promise.allSettled(contexts.map(c=>c.close()));}
});
