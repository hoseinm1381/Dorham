import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdir, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { test, expect, type Page } from '@playwright/test';
import { chooseScreen, completeRecovery } from './recovery-helper';

const signalPort = 37900, mediaPort = 37902, proxyPort = 37903;
const bitrate = 190000;
const vp8Only = process.env.DORHAM_TEST_PUBLISH_VP8 === '1';
test.use({ trace: 'off', video: 'off', actionTimeout: 12000, navigationTimeout: 12000 });
test.skip(process.env.DORHAM_SCREEN_RELAY_TEST !== '1', 'Requires an isolated LiveKit and FFmpeg fixture.');

async function instrument(page: Page, weak: boolean, vp8Only: boolean) {
  await page.addInitScript(({ weak, vp8Only, mediaPort, proxyPort }) => {
    if (vp8Only) {
      const getCapabilities = RTCRtpSender.getCapabilities.bind(RTCRtpSender);
      RTCRtpSender.getCapabilities = kind => {
        const result = getCapabilities(kind);
        return result && { ...result, codecs: result.codecs.filter(codec => codec.mimeType.toLowerCase() !== 'video/vp9') };
      };
    }
    const peers: RTCPeerConnection[] = [];
    Object.assign(window, { relayTestPeers: peers });
    function rewrite(sdp: string) {
      return sdp.replace(new RegExp('(^| )' + mediaPort + '(?= )', 'g'), (_, prefix) => prefix + proxyPort);
    }
    const NativePeer = RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(NativePeer, {
      construct(ctor, args) {
        const pc = new ctor(...args);
        if (weak) {
          // Force peer-reflexive discovery through the proxy. If LiveKit sees
          // Chrome's unshaped address it can nominate a direct pair instead.
          Object.defineProperty(pc, 'onicecandidate', { configurable: true, value: null, writable: true });
          const candidate = pc.addIceCandidate.bind(pc), description = pc.setRemoteDescription.bind(pc);
          pc.addIceCandidate = (input?: RTCIceCandidateInit | null) => {
            return candidate(input?.candidate ? { candidate: rewrite(input.candidate), sdpMid: input.sdpMid, sdpMLineIndex: input.sdpMLineIndex, usernameFragment: input.usernameFragment } : input);
          };
          pc.setRemoteDescription = input => description({ type: input.type, sdp: rewrite(input.sdp ?? '') });
        }
        peers.push(pc);
        return pc;
      },
    });
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d')!;
      let seed = 123456;
      const stream = canvas.captureStream(15);
      const paint = () => {
        for (let y = 0; y < 720; y += 48) for (let x = 0; x < 1280; x += 48) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          ctx.fillStyle = 'hsl(' + (seed % 360) + ' 78% ' + (30 + seed % 60) + '%)';
          ctx.fillRect(x, y, 48, 48);
        }
      };
      paint();
      setInterval(paint, 67); // page teardown releases the synthetic capture
      return stream;
    };
  }, { weak, vp8Only, mediaPort, proxyPort });
}

async function stats(page: Page) {
  return page.evaluate(async () => {
    const peers = (window as unknown as { relayTestPeers: RTCPeerConnection[] }).relayTestPeers;
    const icePorts: number[] = [];
    const video: { id: string; height: number; frames: number; codec: string; bytes: number }[] = [];
    const encodings: { count: number; codec: string }[] = [];
    let audioSamples = 0, concealed = 0;
    for (const pc of peers.filter(peer => peer.connectionState === 'connected')) {
      const report = await pc.getStats();
      for (const row of report.values()) {
        if (row.type === 'transport') {
          const pair = report.get(row.selectedCandidatePairId);
          const remote = report.get(pair?.remoteCandidateId);
          if (remote?.port) icePorts.push(remote.port);
        }
        if (row.type === 'inbound-rtp' && row.kind === 'video' && row.framesDecoded) {
          video.push({ id: row.id, height: row.frameHeight, frames: row.framesDecoded, codec: report.get(row.codecId)?.mimeType, bytes: row.bytesReceived });
        }
        if (row.type === 'inbound-rtp' && row.kind === 'audio') {
          audioSamples += row.totalSamplesReceived ?? 0;
          concealed += row.concealedSamples ?? 0;
        }
      }
      for (const sender of pc.getSenders().filter(item => item.track?.kind === 'video')) {
        const parameters = sender.getParameters();
        const sent = [...(await sender.getStats()).values()].find(row => row.type === 'outbound-rtp' && row.framesEncoded);
        if (sent) encodings.push({ count: parameters.encodings.length, codec: report.get(sent.codecId)?.mimeType });
      }
    }
    const displayed = Math.max(0, ...[...document.querySelectorAll<HTMLVideoElement>('.screen video')].map(element => element.videoHeight));
    return { icePorts, video, encodings, audioSamples, concealed, displayed };
  });
}

async function api(page: Page, route: string, body: object) {
  return page.evaluate(async ({ route, body }) => {
    const { csrf } = await (await fetch('/api/v1/auth/me')).json();
    const response = await fetch('/api/v1' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ ...body, requestId: crypto.randomUUID() }) });
    if (!response.ok) throw new Error('API ' + response.status);
    return response.json();
  }, { route, body });
}

test('one screen upload gives a weak viewer a smaller stream while preserving microphone audio', async ({ browser }) => {
  test.setTimeout(145000);
  const hostAddress = Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal)?.address;
  if (!hostAddress) throw new Error('Local SFU test requires an IPv4 interface for WebRTC.');
  const config = `port: ${signalPort}\nbind_addresses: ['127.0.0.1']\nrtc:\n  udp_port: ${mediaPort}\n  tcp_port: 0\n  node_ip: ${hostAddress}\n  use_external_ip: false\n  use_ice_lite: true\nkeys:\n  dorhamweaktest: 'fixture-screen-relay-local-only-do-not-use-in-production'\nroom:\n  enabled_codecs:\n    - mime: audio/opus\n    - mime: video/VP8\n    - mime: video/VP9\nlogging:\n  level: warn\n`;
  const livekit = spawn(process.env.DORHAM_TEST_LIVEKIT_EXE!, ['--config-body', config], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
  let serverError: Error | undefined;
  livekit.on('error', error => { serverError = error; });
  const socket = createSocket('udp4');
  const routes = new Map<number, ReturnType<typeof createSocket>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let capped = false, nextSend = 0, dropped = 0, forwarded = 0;
  socket.on('message', (packet, from) => {
    let route = routes.get(from.port);
    if (!route) {
      route = createSocket('udp4');
      route.on('message', data => {
        if (!capped) { socket.send(data, from.port, from.address); return; }
        const now = performance.now();
        const send = Math.max(now, nextSend);
        if (send - now > 250) { dropped++; return; }
        nextSend = send + (data.length + 28) * 8000 / bitrate;
        const timer = setTimeout(() => { timers.delete(timer); socket.send(data, from.port, from.address); forwarded++; }, send - now + 55);
        timers.add(timer);
      });
      routes.set(from.port, route);
    }
    route.send(packet, mediaPort, hostAddress);
  });
  try {
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(proxyPort, hostAddress, resolve); });
    await expect.poll(async () => {
      if (serverError) throw serverError;
      return fetch('http://127.0.0.1:' + signalPort, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false);
    }).toBe(true);
    console.log('Isolated SFU listening');
    const pages: Page[] = [];
    for (const weak of [false, false, true]) {
      const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1200, height: 800 } });
      const page = await context.newPage();
      await instrument(page, weak, vp8Only && pages.length === 0);
      pages.push(page);
    }
    const [streamer, strong, weak] = pages;
    console.log('Three browser clients opened');
    for (const [index, page] of pages.entries()) {
      const name = 'RelayTester' + index;
      await page.goto('/');
      await page.getByRole('button', { name: 'Create an account', exact: true }).click();
      await page.getByLabel('Display name', { exact: true }).fill(name);
      await page.getByLabel('Username', { exact: true }).fill(name);
      await page.getByLabel('Password', { exact: true }).fill(crypto.randomUUID());
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await completeRecovery(page);
    }
    console.log('Three test accounts ready');
    const server = await api(streamer, '/servers', { name: 'Screen relay fixture' });
    const invite = await api(streamer, '/servers/' + server.id + '/invites', {});
    for (const viewer of [strong, weak]) await api(viewer, '/invites/join', { code: invite.code });
    for (const page of pages) {
      await page.reload();
      await page.getByRole('button', { name: 'Open Screen relay fixture', exact: true }).click();
      await page.getByRole('button', { name: 'Lounge', exact: true }).click();
    }
    console.log('Three clients joined the voice channel');
    try {
      await expect.poll(async () => (await stats(weak)).icePorts).toContain(proxyPort);
    } catch (error) {
      console.log('Connected peer diagnostics:', await Promise.all(pages.map(stats)), 'Proxied endpoints:', routes.size);
      throw error;
    }
    await expect.poll(async () => (await stats(weak)).audioSamples).toBeGreaterThan(48000);
    console.log('Weak client is receiving voice over the UDP proxy');
    await streamer.getByRole('button', { name: 'Share screen', exact: true }).click();
    await chooseScreen(streamer);
    console.log('Synthetic screen capture selected');
    for (const viewer of [strong, weak]) {
      const watch = viewer.getByRole('button', { name: 'Watch stream', exact: true });
      if (await watch.count()) await watch.first().click();
      await expect.poll(async () => (await stats(viewer)).displayed, { timeout: 25000 }).toBeGreaterThanOrEqual(600);
    }
    const original = await stats(streamer);
    expect(original.encodings).toHaveLength(1);
    expect(original.encodings[0].count).toBe(1);
    expect(original.encodings[0].codec).toMatch(vp8Only ? /^video\/VP8$/i : /^video\/VP[89]$/i);
    capped = true;
    console.log('Both viewers are playing the original screen; applying the weak-link profile');
    await expect.poll(async () => (await stats(weak)).displayed, { timeout: 45000 }).toBe(240);
    const start = await stats(weak), strongStart = await stats(strong);
    const startTime = performance.now();
    const receivedFrames = async () => {
      const received = (await stats(weak)).video.find(row => row.height === 240);
      const before = received && start.video.find(row => row.id === received.id);
      return received && before ? received.frames - before.frames : 0;
    };
    try {
      await expect.poll(receivedFrames, { timeout: 14000 }).toBeGreaterThanOrEqual(20);
    } catch (error) {
      console.log('Capped-link diagnostics:', JSON.stringify({ dropped, forwarded, start, weak: await stats(weak), strong: await stats(strong) }));
      throw error;
    }
    const end = await stats(weak), strongEnd = await stats(strong);
    const seconds = (performance.now() - startTime) / 1000;
    const frameDelta = (height: number, initial: typeof start, final: typeof end) => final.video.filter(row => row.height === height).reduce((sum, row) => sum + row.frames - (initial.video.find(before => before.id === row.id)?.frames ?? 0), 0);
    const fallbackFps = frameDelta(240, start, end) / seconds;
    const strongFps = frameDelta(strongEnd.displayed, strongStart, strongEnd) / seconds;
    const receivedAudio = end.audioSamples - start.audioSamples;
    const concealment = (end.concealed - start.concealed) / receivedAudio;
    const evidence = { bitrate, addedDownlinkDelayMs: 55, dropped, forwarded, originalEncodings: original.encodings, strongHeight: strongEnd.displayed, strongFps, weakHeight: end.displayed, fallbackFps, receivedAudio, concealment };
    expect(dropped).toBeGreaterThan(0);
    expect(forwarded).toBeGreaterThan(0);
    expect(end.displayed).toBe(240);
    expect(strongEnd.displayed).toBeGreaterThanOrEqual(600);
    expect(fallbackFps).toBeGreaterThanOrEqual(3);
    expect(fallbackFps).toBeLessThanOrEqual(8);
    expect(strongFps).toBeGreaterThan(fallbackFps);
    expect(receivedAudio).toBeGreaterThan(seconds * 40000);
    expect(concealment).toBeLessThan(0.05);
    expect((await stats(streamer)).encodings).toEqual(original.encodings);
    capped = false;
    await expect.poll(async () => (await stats(weak)).displayed, { timeout: 42000 }).toBeGreaterThanOrEqual(600);
    const recoveredHeight = (await stats(weak)).displayed;
    await streamer.getByRole('button', { name: 'Stop sharing', exact: true }).click();
    await expect.poll(async () => (await stats(weak)).displayed).toBe(0);
    await mkdir('artifacts/evidence', { recursive: true });
    await writeFile(`artifacts/evidence/screen-relay-weak-link${vp8Only ? '-vp8' : ''}.json`, JSON.stringify({ ...evidence, recoveredHeight }, null, 2));
    console.log('Weak-link measurements:', JSON.stringify({ ...evidence, recoveredHeight }));
    for (const page of pages) await page.close();
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const route of routes.values()) route.close();
    socket.close();
    livekit.kill();
  }
});
