import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
test.use({ trace: 'off', video: 'off' });
async function instrument(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('dorham-sounds', JSON.stringify({ voice: false, messages: false }));
    const meters = new Map<AudioContext, AnalyserNode>(); (window as any).__meters = meters; const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function(destination: any, ...args: any[]): any { if (destination === this.context.destination) { let a = meters.get(this.context as AudioContext); if (!a) { a = (this.context as AudioContext).createAnalyser(); a.fftSize = 1024; meters.set(this.context as AudioContext, a); } (connect as any).call(this, a); } return (connect as any).call(this, destination, ...args); };
    const Peer = RTCPeerConnection; (window as any).RTCPeerConnection = new Proxy(Peer, { construct(T, args) { const filter = (c: RTCConfiguration) => ({ ...c, iceTransportPolicy: 'relay' as const, iceServers: c.iceServers?.map(s => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => u.startsWith('turns:')) })).filter(s => s.urls.length) }); const pc = new T(filter(args[0] || {})), configure = pc.setConfiguration.bind(pc); pc.setConfiguration = c => configure(filter(c || {})); return pc; } });
    navigator.mediaDevices.getUserMedia = async () => { const c = new AudioContext(), o = c.createOscillator(), g = c.createGain(), d = c.createMediaStreamDestination(); o.frequency.value = 440; g.gain.value = 0.08; o.connect(g).connect(d); o.start(); await c.resume(); d.stream.getAudioTracks()[0].addEventListener('ended', () => { o.stop(); void c.close(); }); return d.stream; };
    navigator.mediaDevices.getDisplayMedia = async () => { const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; const draw = canvas.getContext('2d')!; let n = 0; const timer = setInterval(() => { draw.fillStyle = n++ % 2 ? '#7567d8' : '#34bca5'; draw.fillRect(0,0,640,360); }, 66), stream = canvas.captureStream(15); stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer)); return stream; };
  });
}
async function rms(page: Page) { return page.evaluate(async () => { let sum = 0; for (let i=0;i<10;i++) { for (const [c,a] of (window as any).__meters as Map<AudioContext, AnalyserNode>) if(c.state==='running') { const b = new Float32Array(a.fftSize); a.getFloatTimeDomainData(b); sum += b.reduce((v,x)=>v+x*x,0)/b.length; } await new Promise(r=>setTimeout(r,25)); } return Math.sqrt(sum/10); }); }
test('installed Windows and Chrome decode SFU voice/screens, deafen and explicitly stop watching', async ({ browser, baseURL }) => {
  test.setTimeout(150000); test.skip(!process.env.DORHAM_WINDOWS_EXE || process.env.DORHAM_SFU_ISOLATED_TEST !== '1', 'Requires installed candidate and isolated SFU');
  const profile = await mkdtemp(path.join(os.tmpdir(),'dorham-gaming-windows-')); if (path.dirname(profile)!==path.resolve(os.tmpdir())) throw new Error('Unexpected profile directory');
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string,string]=>typeof e[1]==='string')); delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await electron.launch({ executablePath: process.env.DORHAM_WINDOWS_EXE!, args:[`--user-data-dir=${profile}`,'--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'], env });
  const context = await browser.newContext({ permissions:['microphone'] }), first = await context.newPage(), second = await desktop.firstWindow();
  try {
    await instrument(first); await instrument(second); await first.goto('/'); await second.reload();
    const suffix=Date.now().toString().slice(-7);
    for (const [i,page] of [first,second].entries()) { await page.getByRole('button',{name:'Create an account',exact:true}).click(); if(i===1) await page.getByLabel('Server address',{exact:true}).fill(baseURL!); await page.getByLabel('Display name',{exact:true}).fill(`WindowsSfu${suffix}_${i}`); await page.getByLabel('Username',{exact:true}).fill(`WindowsSfu${suffix}_${i}`); await page.getByLabel('Password',{exact:true}).fill('Synthetic-fixture-2026'); await page.getByRole('button',{name:'Create account',exact:true}).click(); await expect(page.locator('.app')).toBeVisible(); }
    const created = await first.evaluate(async () => { const auth = await (await fetch('/api/v1/auth/me')).json(), headers={'Content-Type':'application/json','X-CSRF-Token':auth.csrf}; const s=await (await fetch('/api/v1/servers',{method:'POST',headers,body:JSON.stringify({requestId:crypto.randomUUID(),name:'Installed SFU lab'})})).json(); return (await fetch(`/api/v1/servers/${s.id}/invites`,{method:'POST',headers,body:JSON.stringify({requestId:crypto.randomUUID()})})).json(); });
    await second.getByRole('button',{name:'Join a server',exact:true}).click(); await second.getByLabel('Invite link or code',{exact:true}).fill(created.code); await second.getByRole('button',{name:'Join the conversation',exact:true}).click();
    for(const page of [first,second]) { await page.getByRole('button',{name:'Open Installed SFU lab',exact:true}).click(); await page.getByRole('button',{name:'Lounge',exact:true}).click(); }
    for(const page of [first,second]) await expect.poll(()=>rms(page),{timeout:45000}).toBeGreaterThan(0.03);
    await expect(second.getByRole('checkbox',{name:'Share sound',exact:true})).toBeDisabled();
    await first.getByRole('button',{name:'Share screen',exact:true}).click(); await expect(second.locator('.screen video')).toHaveCount(0); await second.getByRole('button',{name:'Watch stream',exact:true}).click(); await expect.poll(()=>second.locator('.screen video').evaluate((v:HTMLVideoElement)=>v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(5);
    await second.getByRole('button',{name:'Deafen',exact:true}).click(); await expect.poll(()=>rms(second)).toBeLessThan(0.000001); await second.getByRole('button',{name:'Undeafen',exact:true}).click(); await expect.poll(()=>rms(second)).toBeGreaterThan(0.03);
    await second.getByRole('button',{name:'Share screen',exact:true}).click(); await first.getByRole('button',{name:'Watch stream',exact:true}).click(); await expect.poll(()=>first.locator('.screen video').evaluate((v:HTMLVideoElement)=>v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(5);
    await second.getByRole('button',{name:'Close stream viewer',exact:true}).click(); await expect(second.locator('.screen video')).toHaveCount(0); await expect(second.locator('.voice-panel')).toBeVisible(); await mkdir('artifacts/evidence',{recursive:true}); await writeFile('artifacts/evidence/v050-windows-sfu.json',JSON.stringify({installed:true,decodedBidirectionalVoice:true,decodedBidirectionalScreens:true,explicitWatch:true,deafenSilence:true,voicePreservedOnClose:true,unsafeSystemAudioDisabled:true,transport:'TURN/TLS media; private isolated signaling',physicalCaptureAndFeedbackExclusion:'untested'},null,2));
  } finally { await desktop.close(); await context.close(); await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:300}); }
});
