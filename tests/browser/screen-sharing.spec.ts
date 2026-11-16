import { completeRecovery } from './recovery-helper';
import {devices,test,expect,type Page} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
test.use({trace:'off',actionTimeout:12000});
async function register(p:Page,name:string){await p.goto('/');await p.getByRole('button',{name:'Create an account',exact:true}).click();await p.getByLabel('Display name',{exact:true}).fill(name);await p.getByLabel('Username',{exact:true}).fill(name);await p.getByLabel('Password',{exact:true}).fill('Synthetic-sharing-2026');await p.getByRole('button',{name:'Create account',exact:true}).click();await completeRecovery(p); await expect(p.locator('.app')).toBeVisible();}
async function api(p:Page,route:string,body?:any){return p.evaluate(async({route,body})=>{const me=await(await fetch('/api/v1/auth/me')).json(),r=await fetch('/api/v1'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrf},body:body?JSON.stringify({requestId:crypto.randomUUID(),...body}):undefined});if(!r.ok)throw Error(await r.text());return r.json();},{route,body});}
async function instrument(p:Page){await p.addInitScript(()=>{
  const Peer=RTCPeerConnection;(window as any).__sharePeers=[];(window as any).RTCPeerConnection=new Proxy(Peer,{construct(T,args){const pc=new T(args[0]);(window as any).__sharePeers.push(pc);return pc;}});
  (window as any).__captures=[];navigator.mediaDevices.getDisplayMedia=async constraints=>{(window as any).__captures.push(constraints);if((window as any).__cancelCapture)throw new DOMException('Capture cancelled','NotAllowedError');const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const c=canvas.getContext('2d')!;let n=0;const timer=setInterval(()=>{c.fillStyle=n++%2?'#9b7fec':'#3cb59d';c.fillRect(0,0,640,360);c.fillStyle='#fff';c.fillText(String(n),n%500,100);},33),stream=canvas.captureStream(30);if(constraints?.audio&&!(window as any).__omitShareAudio){const audio=new AudioContext(),tone=audio.createOscillator(),gain=audio.createGain(),out=audio.createMediaStreamDestination();tone.frequency.value=640;gain.gain.value=.04;tone.connect(gain).connect(out);tone.start();void audio.resume();stream.addTrack(out.stream.getAudioTracks()[0]);stream.getVideoTracks()[0].addEventListener('ended',()=>{tone.stop();void audio.close();});}stream.getTracks()[0].addEventListener('ended',()=>clearInterval(timer));return stream;};
});}
async function limits(p:Page){return p.evaluate(()=>(window as any).__sharePeers.flatMap((pc:RTCPeerConnection)=>pc.getSenders().filter(sender=>sender.track?.kind==='video').flatMap(sender=>sender.getParameters().encodings.map(e=>({bitrate:e.maxBitrate,fps:e.maxFramerate})))));}

async function configure(p:Page, quality:string, bitrate:number, starting=false, sound=false){
  await p.getByRole('button',{name:starting?'Share screen':'Adjust sharing settings',exact:true}).click();
  const popup=p.getByRole('dialog',{name:'Screen sharing',exact:true});
  await popup.getByRole('button',{name:'Advanced',exact:true}).click();
  await popup.getByRole('combobox',{name:'Screen resolution',exact:true}).selectOption(quality.startsWith('480')?'480':'720');
  await popup.getByRole('combobox',{name:'Screen FPS',exact:true}).selectOption(quality.endsWith('30')?'30':'15');
  await popup.getByRole('combobox',{name:'Screen bandwidth',exact:true}).selectOption(String(bitrate));
  if (starting) {
    const shareSound = popup.getByRole('checkbox', { name: 'Share sound', exact: true });
    await expect(shareSound).toBeChecked();
    if (!sound) await shareSound.uncheck();
  }
  await popup.getByRole('button',{name:starting?'Choose screen':'Apply sharing settings',exact:true}).click();
  await expect(popup).toBeHidden();
}
test('sharing popup applies every bandwidth live without recapture and preserves leases, rewatching and saved preferences',async({browser})=>{
  const contexts=await Promise.all([browser.newContext({permissions:['microphone']}),browser.newContext({permissions:['microphone']})]),[a,b]=await Promise.all(contexts.map(c=>c.newPage())),errors:string[]=[];
  try{
    for(const p of [a,b]){p.on('pageerror',e=>errors.push(e.message));await instrument(p);}const suffix=Date.now().toString().slice(-7);await register(a,'ShareA'+suffix);await register(b,'ShareB'+suffix);
    const server=await api(a,'/servers',{name:'Sharing controls'}),invite=await api(a,`/servers/${server.id}/invites`,{uses:5});await api(b,'/invites/join',{code:invite.code});
    for(const p of [a,b]){await p.getByRole('button',{name:'Open Sharing controls',exact:true}).click();await p.getByRole('button',{name:'Lounge',exact:true}).click();}
    for(const p of [a,b]){await expect(p.locator('.voice-card')).toHaveCount(0);await expect(p.getByRole('button',{name:'Voice controls',exact:true})).toHaveCount(0);await expect(p.getByRole('button',{name:'Minimize voice',exact:true})).toHaveCount(0);await expect(p.locator('.voice-mini-members button')).toHaveCount(2);}
    const withAudio=process.env.MEDIA_TRANSPORT==='livekit',reserve=withAudio?48000:0;
    await expect(a.getByRole('combobox',{name:'Screen bandwidth',exact:true})).toHaveCount(0);await configure(a,'480p30',1500000,true,withAudio);
    await expect(b.getByRole('button',{name:'Watch stream',exact:true})).toBeVisible();
    await a.getByRole('checkbox',{name:'Preview my screen',exact:true}).check();await expect.poll(()=>a.locator('.screen video').evaluate((v:HTMLVideoElement)=>v.videoWidth)).toBe(640);await a.getByRole('button',{name:'Stop watching stream',exact:true}).click();await expect(a.locator('.screen video')).toHaveCount(0);await expect(a.getByRole('button',{name:'Stop sharing',exact:true})).toBeVisible();
    await b.getByRole('button',{name:'Watch stream',exact:true}).click();await expect.poll(()=>b.locator('.screen video').evaluate((v:HTMLVideoElement)=>v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(5);
    await expect.poll(()=>limits(a)).toEqual([{bitrate:1500000-reserve,fps:30}]);expect(await a.evaluate(()=>(window as any).__captures[0].video.height.ideal)).toBe(480);
    const channel=(await api(a,'/bootstrap')).channels.find((c:any)=>c.kind==='voice'),lease=(await api(a,`/voice/${channel.id}`)).shares[0].id;
    const results=[];for(const n of [300000,450000,600000,750000,900000,1050000,1200000,1350000,1500000]){await configure(a,'480p30',n);await expect.poll(()=>limits(a)).toEqual([{bitrate:n-reserve,fps:30}]);results.push(await limits(a));}
    await configure(a,'720p15',1500000);await expect.poll(()=>limits(a)).toEqual([{bitrate:1500000-reserve,fps:15}]);await configure(a,'480p30',1500000);await expect.poll(()=>limits(a)).toEqual([{bitrate:1500000-reserve,fps:30}]);
    expect((await api(a,`/voice/${channel.id}`)).shares[0].id).toBe(lease);expect(await a.evaluate(()=>(window as any).__captures.length)).toBe(1);
    await b.getByRole('button',{name:'Close stream',exact:true}).click();await b.setViewportSize({width:390,height:844});await expect(b.getByRole('button',{name:'Watch stream',exact:true})).toBeVisible();expect(await b.locator('.gaming-voice').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await b.getByRole('button',{name:'Watch stream',exact:true}).click();await expect.poll(()=>b.locator('.screen video').evaluate((v:HTMLVideoElement)=>v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(5);await b.setViewportSize({width:1280,height:720});await b.screenshot({path:'artifacts/evidence/voice-stage-simplified-screen.png'});
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

test('browser keeps sharing and briefly warns when the picker returns video without sound', async ({ page }) => {
  await instrument(page);
  await register(page, 'SoundDefault' + Date.now().toString().slice(-7));
  await api(page, '/servers', { name: 'Browser share sound' });
  await page.getByRole('button', { name: 'Open Browser share sound', exact: true }).click();
  await page.getByRole('button', { name: 'Lounge', exact: true }).click();

  const startShare = async (audioAvailable: boolean, shareAudio = true) => {
    await page.evaluate(available => { (window as any).__omitShareAudio = !available; }, audioAvailable);
    await page.getByRole('button', { name: 'Share screen', exact: true }).click();
    const setup = page.getByRole('dialog', { name: 'Screen sharing', exact: true });
    const sound = setup.getByRole('checkbox', { name: 'Share sound', exact: true });
    await expect(sound).toBeChecked();
    if (!shareAudio) await sound.uncheck();
    await setup.getByRole('button', { name: 'Choose screen', exact: true }).click();
    await expect(setup).toBeHidden();
    await expect(page.getByRole('button', { name: 'Stop sharing', exact: true })).toBeVisible();
  };
  const stopShare = async () => {
    await page.getByRole('button', { name: 'Stop sharing', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Share screen', exact: true })).toBeEnabled();
  };
  const channel = (await api(page, '/bootstrap')).channels.find((item: any) => item.kind === 'voice');
  const audioInLease = async () => (await api(page, `/voice/${channel.id}`)).shares[0]?.includeAudio;
  const hint = page.getByRole('status').filter({ hasText: 'Sharing without sound. Enable audio in the browser picker next time.' });

  await startShare(false);
  await expect(hint).toBeVisible({ timeout: 1500 });
  await expect.poll(audioInLease).toBe(false);
  await expect(hint).toBeHidden({ timeout: 3500 });
  await expect(page.getByRole('button', { name: 'Stop sharing', exact: true })).toBeVisible();
  await stopShare();

  await startShare(true);
  await expect.poll(audioInLease).toBe(true);
  await expect(hint).toHaveCount(0);
  await stopShare();

  await startShare(false, false);
  await expect.poll(audioInLease).toBe(false);
  await expect(hint).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__captures.map((capture: DisplayMediaStreamOptions) => Boolean(capture.audio)))).toEqual([true, true, false]);
  await stopShare();
});

test('phone web viewer keeps playing across rotation and expands without browser fullscreen', async ({ browser }) => {
  const publisher = await browser.newContext({ permissions: ['microphone'] });
  const viewer = await browser.newContext({ ...devices['iPhone 13'], permissions: ['microphone'] });
  const a = await publisher.newPage(), b = await viewer.newPage();
  const portrait = { width: 390, height: 664 }, landscape = { width: 844, height: 390 };
  const errors: string[] = [];
  b.on('pageerror', error => errors.push(error.message));
  try {
    await instrument(a);
    await b.setViewportSize(landscape);
    const suffix = Date.now().toString().slice(-7);
    await register(a, 'PhoneHost' + suffix);
    await register(b, 'PhoneViewer' + suffix);
    await expect(b.locator('.main')).toHaveJSProperty('clientWidth', landscape.width);
    await b.setViewportSize(portrait);
    const server = await api(a, '/servers', { name: 'Phone viewing' });
    const invite = await api(a, `/servers/${server.id}/invites`, { uses: 5 });
    await api(b, '/invites/join', { code: invite.code });
    const navigation = b.getByRole('button', { name: 'Toggle navigation', exact: true });
    await navigation.tap();
    for (const page of [a, b]) {
      await page.getByRole('button', { name: 'Open Phone viewing', exact: true }).click();
      await page.getByRole('button', { name: 'Lounge', exact: true }).click();
    }
    await configure(a, '720p15', 900000, true);
    await b.getByRole('button', { name: 'Watch stream', exact: true }).tap();
    const video = b.locator('.screen video');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(5);
    const original = await video.elementHandle();
    await b.setViewportSize(landscape);
    await expect(navigation).toBeVisible();
    await expect(b.locator('.main')).toHaveJSProperty('clientWidth', landscape.width);
    const fullscreen = b.getByRole('button', { name: 'Fullscreen stream', exact: true });
    const exit = b.getByRole('button', { name: 'Exit fullscreen stream', exact: true });
    await b.bringToFront();
    await fullscreen.tap();
    await expect(b.locator('.stream-view:fullscreen')).toBeVisible();
    await exit.tap();
    await expect(b.locator('.stream-view:fullscreen')).toHaveCount(0);
    await b.evaluate(() => {
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => false });
      Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: undefined });
    });
    await fullscreen.tap();
    await expect(exit).toBeVisible();
    expect((await video.boundingBox())!.height).toBeGreaterThan(landscape.height * 0.85);
    const frames = await video.evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames);
    await b.setViewportSize(portrait);
    await expect(exit).toBeInViewport();
    expect((await video.boundingBox())!.width).toBeGreaterThan(portrait.width * 0.95);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(frames);
    expect(await video.evaluate((element, initial) => element === initial, original)).toBe(true);
    await b.keyboard.press('Escape');
    await expect(fullscreen).toBeVisible();
    await b.evaluate(() => {
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => true });
      Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: () => Promise.reject(new DOMException('Fullscreen unavailable', 'NotAllowedError')) });
    });
    await fullscreen.tap();
    await expect(exit).toBeInViewport();
    await exit.tap();
    await expect(fullscreen).toBeVisible();
    await b.setViewportSize(landscape);
    await b.getByRole('button', { name: 'Show chat', exact: true }).tap();
    await expect(b.getByRole('textbox', { name: 'Message', exact: true })).toBeInViewport();
    await expect(video).toBeInViewport();
    await b.getByRole('button', { name: 'Stop watching stream', exact: true }).tap();
    await expect(video).toHaveCount(0);
    await navigation.tap();
    await expect(b.getByRole('button', { name: 'Disconnect voice', exact: true })).toBeInViewport();
    await b.setViewportSize({ width: 320, height: 568 });
    await expect(b.getByRole('button', { name: 'Account settings', exact: true })).toBeInViewport();
    await b.getByRole('button', { name: 'Close navigation', exact: true }).tap({ position: { x: 304, y: 140 } });
    await expect(b.locator('.main')).toHaveJSProperty('clientWidth', 320);
    await expect.poll(() => b.locator('.topbar').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await Promise.allSettled([publisher.close(), viewer.close()]);
  }
});
