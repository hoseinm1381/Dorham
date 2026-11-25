import { expect, type Locator, type Page } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function proveCaptureBridge(page: Page, fixture: string, dorhamPid: number) {
  const source = spawn(path.resolve(fixture), ['selected'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const previews = process.env.DORHAM_TEST_PICKER_PREVIEWS === '1';
  const minimized = process.env.DORHAM_TEST_MINIMIZED_SOURCE === '1';
  const second = previews ? spawn(path.resolve(fixture), ['unrelated'], { stdio: ['ignore', 'pipe', 'inherit'] }) : undefined;
  let sourceHandle = '';
  let secondHandle = '';
  const sourceWindow = async (action: 'minimize' | 'maximize' | 'inspect') => {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('tests/fixtures/tauri-picker-source.ps1'), String(source.pid), sourceHandle, action], { windowsHide: true });
    return JSON.parse(stdout) as { minimized: boolean; maximized: boolean };
  };
  const previewHelpers = async () => {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='CaptureVideo.exe' AND ParentProcessId=${dorhamPid}" | Where-Object CommandLine -match ' previews ').Count`,
    ], { windowsHide: true });
    return Number(stdout.trim());
  };
  const fingerprint = (preview: Locator) => preview.evaluate(element => {
    const image = element.querySelector('img');
    if (!image?.complete || !image.naturalWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height).data.reduce((hash, value) => Math.imul(hash ^ value, 16777619), 0);
  });
  try {
    const [ready, secondReady] = await Promise.all((second ? [source, second] : [source]).map(child =>
      once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) }),
    ));
    sourceHandle = String(ready[0]).match(/^\d+/m)?.[0] ?? '';
    if (minimized && !previews) expect(await sourceWindow('minimize')).toMatchObject({ minimized: true });
    if (previews) {
      secondHandle = String(secondReady?.[0]).match(/^\d+/m)?.[0] ?? '';
      expect(sourceHandle).not.toBe('');
      expect(secondHandle).not.toBe('');
      expect(await sourceWindow('minimize')).toMatchObject({ minimized: true });
    }
    const denied = await page.evaluate(async () => {
      try { await window.desktop!.captureNativeVideo!({ width: 400, height: 220, fps: 15 }, false); return false; }
      catch { return true; }
    });
    expect(denied).toBe(true);
    await page.evaluate(async () => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args: object) => Promise<void> } }).__TAURI_INTERNALS__;
      await internals.invoke('desktop_command', { request: { method: 'setInCall', value: true } });
    });
    const pickerEvent = page.context().waitForEvent('page', { timeout: 15000 });
    const capture = page.evaluate(async () => {
      const share = await window.desktop!.captureNativeVideo!({ width: 400, height: 220, fps: 15 }, false);
      const input = new RTCPeerConnection({ iceServers: [] }), output = new RTCPeerConnection({ iceServers: [] });
      const video = document.createElement('video');
      video.id = 'dorham-owned-decoded-track';
      video.autoplay = true;
      video.muted = true;
      document.body.append(video);
      const a: RTCIceCandidate[] = [], b: RTCIceCandidate[] = [];
      input.onicecandidate = event => {
        if (event.candidate) {
          if (output.remoteDescription) void output.addIceCandidate(event.candidate);
          else a.push(event.candidate);
        }
      };
      output.onicecandidate = event => {
        if (event.candidate) {
          if (input.remoteDescription) void input.addIceCandidate(event.candidate);
          else b.push(event.candidate);
        }
      };
      output.ontrack = ({ streams }) => { video.srcObject = streams[0]; };
      const track = share.stream.getVideoTracks()[0];
      video.addEventListener('change-capture-quality', () => {
        void share.setQuality!({ width: 192, height: 108, fps: 10 });
      }, { once: true });
      track.addEventListener('ended', () => { video.dataset.sourceEnded = 'true'; }, { once: true });
      input.addTrack(track, share.stream);
      await input.setLocalDescription(await input.createOffer());
      await output.setRemoteDescription(input.localDescription!);
      await Promise.all(a.map(candidate => output.addIceCandidate(candidate)));
      await output.setLocalDescription(await output.createAnswer());
      await input.setRemoteDescription(output.localDescription!);
      await Promise.all(b.map(candidate => input.addIceCandidate(candidate)));
      return { selection: share.selection, tracks: share.stream.getAudioTracks().length };
    });
    // Attach a rejection handler while the separate picker window is being driven.
    void capture.catch(() => {});
    const picker = await pickerEvent;
    await expect(picker).toHaveURL('https://localhost/capture-picker.html');
    let option = picker.getByRole('option', { name: 'Dorham owned capture fixture selected', exact: true });
    if (previews) {
      const search = picker.getByRole('searchbox', { name: 'Search sources' });
      await search.fill('Dorham owned capture fixture selected');
      option = picker.locator(`button:has([data-preview="window:${sourceHandle}:${source.pid}"])`);
      await expect(option.locator('.preview')).toContainText('Minimized.');
      await option.click();
      await expect(picker.getByRole('button', { name: 'Share', exact: true })).toBeEnabled();
      await expect.poll(previewHelpers).toBe(0);
      expect(await sourceWindow('maximize')).toEqual({ minimized: false, maximized: true });
      await picker.bringToFront();
      await expect(picker.getByRole('button', { name: 'Share', exact: true })).toBeEnabled();
      await expect.poll(() => fingerprint(option.locator('.preview')), { timeout: 15000 }).not.toBeNull();
      expect(await sourceWindow('minimize')).toMatchObject({ minimized: true });
      await picker.bringToFront();
      await expect(option.locator('.preview')).toContainText('Minimized.');
      await expect.poll(previewHelpers).toBe(0);
      expect(await sourceWindow('maximize')).toMatchObject({ minimized: false });
      await expect(picker.getByRole('button', { name: 'Share', exact: true })).toBeEnabled();
      expect(await sourceWindow('inspect')).toMatchObject({ minimized: false });
      await search.fill('Dorham owned capture fixture');
      await expect.poll(() => fingerprint(option.locator('.preview')), { timeout: 15000 }).not.toBeNull();
      const other = picker.locator(`button:has([data-preview="window:${secondHandle}:${second?.pid}"])`);
      await expect.poll(() => fingerprint(other.locator('.preview')), { timeout: 10000 }).not.toBeNull();
      let lastFrame = await fingerprint(option.locator('.preview'));
      let changes = 0;
      await expect.poll(async () => {
        const pixels = await fingerprint(option.locator('.preview'));
        if (pixels !== null) {
          if (lastFrame !== null && pixels !== lastFrame) changes++;
          lastFrame = pixels;
        }
        return changes;
      }, { timeout: 12000, intervals: [120, 200, 300] }).toBeGreaterThanOrEqual(3);
      await expect.poll(previewHelpers).toBe(1);
      await picker.getByRole('tab', { name: 'Screens', exact: true }).click();
      await search.clear();
      const screen = picker.getByRole('option', { name: /^Screen / }).first();
      await expect.poll(() => screen.locator('.preview').evaluate(preview => preview.querySelector('img')?.naturalWidth || 0), { timeout: 12000 }).toBeGreaterThan(0);
      const screenBefore = await fingerprint(screen.locator('.preview'));
      await picker.evaluate("document.querySelector('main').style.backgroundColor = '#35785c'");
      await expect.poll(async () => {
        const current = await fingerprint(screen.locator('.preview'));
        return current !== null && current !== screenBefore;
      }, { timeout: 10000 }).toBe(true);
      await search.fill('No matching fixture source');
      await expect.poll(previewHelpers).toBe(0);
      await search.fill('Dorham owned capture fixture selected');
      await picker.getByRole('tab', { name: 'Applications', exact: true }).click();
      await expect(option.locator('.preview img')).toBeVisible();
      console.log(JSON.stringify({ previewResumedAfterExternalMaximize: true, previewStoppedAfterExternalMinimize: true, externalRestoreVerified: true, simultaneousApplicationPreviews: 2, applicationFrameChanges: changes, changingScreenPreview: true, stoppedWhenNoSourcesVisible: true }));
    }
    await option.click();
    await picker.getByRole('button', { name: 'Share', exact: true }).click();
    const captured = await capture;
    if (previews) await expect.poll(previewHelpers).toBe(0);
    expect(captured.selection).toMatchObject({
      sourceName: 'Dorham owned capture fixture selected', audioScope: 'none', surface: 'window',
    });
    expect(captured.tracks).toBe(0);
    const video = page.locator('#dorham-owned-decoded-track');
    if (minimized && !previews) {
      expect(await sourceWindow('inspect')).toMatchObject({ minimized: true });
      expect(await sourceWindow('maximize')).toMatchObject({ minimized: false });
    }
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => {
      if (!element.videoWidth || element.readyState < 2) return false;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(element, element.videoWidth / 2, element.videoHeight / 2, 1, 1, 0, 0, 1, 1);
      const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
      return red > 90 && blue > 120 && green < 75;
    }), { timeout: 12000 }).toBe(true);
    await video.evaluate(element => element.dispatchEvent(new Event('change-capture-quality')));
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) =>
      element.videoWidth > 0 && element.videoWidth <= 192 && element.videoHeight <= 108)).toBe(true);
    source.kill();
    await expect(video).toHaveAttribute('data-source-ended', 'true', { timeout: 8000 });
    console.log(JSON.stringify({ webviewCaptureBridge: true, decodedWebRTCVideo: true, selectedScope: 'window', deniedOutsideCall: true, sourceClosureStopsTrack: true }));
  } finally {
    if (source.exitCode === null) source.kill();
    if (second?.exitCode === null) second.kill();
    await page.evaluate(() => { window.desktop?.setInCall(false); }).catch(() => {});
  }
}
