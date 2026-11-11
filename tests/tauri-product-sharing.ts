import { chromium, expect, type Page } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';
import { completeRecovery } from './browser/recovery-helper';

const run = promisify(execFile);

export async function proveProductSharing(host: Page, server: string, ownerToken: string, fixture: string, transport: string, hostPid: number, videoOnly = false) {
  const args = transport === 'livekit' ? ['--disable-features=WebRtcHideLocalIpsWithMdns'] : [];
  if (videoOnly) args.push('--mute-audio');
  const viewer = await chromium.launch({ channel: 'msedge', headless: true, args });
  const source = spawn(path.resolve(fixture), videoOnly ? ['selected'] : ['selected', 'tones'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const captureHelpers = async (): Promise<string[]> => {
    const filter = `ParentProcessId = ${hostPid} AND (Name = 'CaptureVideo.exe' OR Name = 'ShareAudio.exe')`;
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction Stop | Sort-Object Name | Select-Object -ExpandProperty Name)`,
    ], { windowsHide: true, timeout: 6000 });
    return JSON.parse(stdout);
  };
  try {
    await once(source.stdout, 'data', { signal: AbortSignal.timeout(10000) });
    const receiver = await viewer.newPage();
    await receiver.addInitScript(() => {
      const tracks = new Set<MediaStreamTrack>();
      Object.defineProperty(window, '__ownedDecodedAudio', { value: tracks });
      const Native = RTCPeerConnection;
      window.RTCPeerConnection = new Proxy(Native, {
        construct(target, args) {
          const connection = Reflect.construct(target, args) as RTCPeerConnection;
          connection.addEventListener('track', ({ track }) => { if (track.kind === 'audio') tracks.add(track); });
          return connection;
        },
      });
    });
    async function denyMicrophone(page: Page, origin: string) {
      const cdp = await page.context().newCDPSession(page);
      const { targetInfo } = await cdp.send('Target.getTargetInfo');
      await cdp.send('Browser.setPermission', {
        origin, browserContextId: targetInfo.browserContextId,
        permission: { name: 'microphone' }, setting: 'denied',
      });
      await cdp.detach();
    }
    await denyMicrophone(receiver, server);
    async function api(route: string, data: object, token?: string) {
      const response = await fetch(server + '/api/v1' + route, {
        method: 'POST', headers: {
          'Content-Type': 'application/json', 'X-Dorham-Native': '1',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        }, body: JSON.stringify({ requestId: randomUUID(), ...data }),
      });
      expect(response.ok, route).toBe(true);
      return await response.json();
    }
    const username = `viewer_${Date.now().toString(36)}`;
    const password = 'Owned sharing viewer fixture password';
    const account = await api('/auth/register', { username, password, displayName: 'Owned sharing viewer' });
    const room = await api('/servers', { name: 'Native sharing qualification' }, ownerToken);
    const invite = await api(`/servers/${room.id}/invites`, { uses: 2 }, ownerToken);
    await api('/invites/join', { code: invite.code }, account.accessToken);
    await receiver.goto(server);
    await receiver.getByLabel('Username', { exact: true }).fill(username);
    await receiver.getByLabel('Password', { exact: true }).fill(password);
    await receiver.getByRole('button', { name: 'Let’s get you in', exact: true }).click();
    await completeRecovery(receiver);
    await host.reload();
    for (const page of [host, receiver]) {
      await page.getByRole('button', { name: 'Open Native sharing qualification', exact: true }).click();
      await page.getByRole('button', { name: 'Lounge', exact: true }).click();
      await expect(page.locator('.gaming-voice')).toBeVisible();
    }
    await expect(host.locator('.voice-panel')).toContainText('Listening only', { timeout: 25000 });
    await host.getByRole('button', { name: 'Share screen', exact: true }).click();
    const dialog = host.getByRole('dialog', { name: 'Screen sharing', exact: true });
    const choose = async () => {
      if (!videoOnly) await dialog.getByRole('checkbox', { name: 'Share sound', exact: true }).check();
      const opening = host.context().waitForEvent('page', { timeout: 15000 });
      await dialog.getByRole('button', { name: 'Choose screen', exact: true }).click();
      return opening;
    };
    let picker = await choose();
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Choose screen', exact: true })).toBeEnabled();
    await expect(receiver.getByRole('button', { name: 'Watch stream', exact: true })).toHaveCount(0);
    for (let attempt = 0; attempt < 2; attempt++) {
      await receiver.evaluate(() => (window as unknown as { __ownedDecodedAudio: Set<MediaStreamTrack> }).__ownedDecodedAudio.clear());
      picker = await choose();
      await picker.getByRole('option', { name: 'Dorham owned capture fixture selected', exact: true }).click();
      if (!videoOnly) await picker.locator('#scope').selectOption('application');
      await picker.getByRole('button', { name: 'Share', exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 15000 });
      if (!videoOnly) await expect(host.getByText('Selected application sound', { exact: false })).toBeVisible();
      await receiver.getByRole('button', { name: 'Watch stream', exact: true }).click();
      const video = receiver.locator('.screen video');
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.getVideoPlaybackQuality().totalVideoFrames), { timeout: 20000 }).toBeGreaterThan(5);
      if (!videoOnly) await expect.poll(() => receiver.evaluate(async () => {
        const tracks = (window as unknown as { __ownedDecodedAudio: Set<MediaStreamTrack> }).__ownedDecodedAudio;
        const track = [...tracks].filter(track => track.readyState === 'live' && !track.muted).at(-1);
        if (!track) return -Infinity;
        const context = new AudioContext();
        try {
          const input = context.createMediaStreamSource(new MediaStream([track]));
          const analyser = context.createAnalyser();
          analyser.fftSize = 4096;
          input.connect(analyser);
          await context.resume();
          await new Promise(resolve => setTimeout(resolve, 250));
          const bins = new Float32Array(analyser.frequencyBinCount);
          analyser.getFloatFrequencyData(bins);
          const index = Math.round(400 * analyser.fftSize / context.sampleRate);
          return Math.max(...bins.slice(index - 1, index + 2));
        } finally {
          await context.close();
        }
      }), { timeout: 20000 }).toBeGreaterThan(-65);
      await expect.poll(captureHelpers, { timeout: 10000 }).toEqual(videoOnly ? ['CaptureVideo.exe'] : ['CaptureVideo.exe', 'ShareAudio.exe']);
      console.log(JSON.stringify({ transport, attempt: attempt + 1, receiverDecodedVideo: true, ...(!videoOnly && { receiverDecodedSelectedAppTone: true }) }));
      if (attempt === 0) await host.getByRole('button', { name: 'Stop sharing', exact: true }).click();
      else source.kill();
      await expect(video).toHaveCount(0, { timeout: 12000 });
      await expect.poll(captureHelpers, { timeout: 10000 }).toEqual([]);
      if (attempt === 0) await host.getByRole('button', { name: 'Share screen', exact: true }).click();
    }
    console.log(JSON.stringify({ transport, realOwnedWindow: true, receiverDecodedVideo: true, ...(!videoOnly && { receiverDecodedSelectedAppTone: true }), cancel: true, stopRestart: true, sourceClosureStopsShare: true, captureHelpersExited: true, permissionDeniedListenOnly: true }));
  } finally {
    if (source.exitCode === null) source.kill();
    await viewer.close();
  }
}
