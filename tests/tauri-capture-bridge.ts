import { expect, type Page } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function proveCaptureBridge(page: Page, fixture: string) {
  const source = spawn(path.resolve(fixture), ['selected'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const previews = process.env.DORHAM_TEST_PICKER_PREVIEWS === '1';
  const sourceWindow = async (action: 'minimize' | 'inspect') => {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('tests/fixtures/tauri-picker-source.ps1'), String(source.pid), action], { windowsHide: true });
    return JSON.parse(stdout) as { minimized: boolean };
  };
  try {
    await once(source.stdout, 'data', { signal: AbortSignal.timeout(10000) });
    if (previews) expect(await sourceWindow('minimize')).toEqual({ minimized: true });
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
    const option = picker.getByRole('option', { name: 'Dorham owned capture fixture selected', exact: true });
    if (previews) {
      const search = picker.getByRole('searchbox', { name: 'Search sources' });
      await search.fill('Dorham owned capture fixture selected');
      await expect(option.locator('.preview')).toHaveText('Window minimized');
      await option.click();
      await picker.getByRole('button', { name: 'Restore window', exact: true }).click();
      await expect(picker.getByRole('button', { name: 'Share', exact: true })).toBeEnabled();
      expect(await sourceWindow('inspect')).toEqual({ minimized: false });
      await expect.poll(() => option.locator('.preview').evaluate(preview => {
        const image = preview.querySelector('img');
        if (!image?.naturalWidth) return false;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, image.naturalWidth / 2, image.naturalHeight / 2, 1, 1, 0, 0, 1, 1);
        const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
        return red > 90 && green < 75 && blue > 120;
      }), { timeout: 15000 }).toBe(true);
      await picker.getByRole('tab', { name: 'Screens', exact: true }).click();
      await search.clear();
      const screen = picker.getByRole('option', { name: /^Screen / }).first();
      await expect.poll(() => screen.locator('.preview').evaluate(preview => preview.querySelector('img')?.naturalWidth || 0), { timeout: 12000 }).toBeGreaterThan(0);
      await search.fill('Dorham owned capture fixture selected');
      await picker.getByRole('tab', { name: 'Applications', exact: true }).click();
      await expect(option.locator('.preview img')).toBeVisible();
      console.log(JSON.stringify({ minimizedApplicationRestored: true, applicationPreviewPixels: true, screenPreviewDecoded: true }));
    }
    await option.click();
    await picker.getByRole('button', { name: 'Share', exact: true }).click();
    const captured = await capture;
    expect(captured.selection).toMatchObject({
      sourceName: 'Dorham owned capture fixture selected', audioScope: 'none', surface: 'window',
    });
    expect(captured.tracks).toBe(0);
    const video = page.locator('#dorham-owned-decoded-track');
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => {
      if (!element.videoWidth || element.readyState < 2) return false;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(element, element.videoWidth / 2, element.videoHeight / 2, 1, 1, 0, 0, 1, 1);
      const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
      return red > 90 && blue > 120 && green < 75;
    }), { timeout: 12000 }).toBe(true);
    source.kill();
    await expect(video).toHaveAttribute('data-source-ended', 'true', { timeout: 8000 });
    console.log(JSON.stringify({ webviewCaptureBridge: true, decodedWebRTCVideo: true, selectedScope: 'window', deniedOutsideCall: true, sourceClosureStopsTrack: true }));
  } finally {
    if (source.exitCode === null) source.kill();
    await page.evaluate(() => { window.desktop?.setInCall(false); }).catch(() => {});
  }
}
