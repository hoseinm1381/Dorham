import { expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';

export async function proveAudioScopes(page: Page, fixture: string) {
  const sources = ['selected', 'unrelated'].map(label => spawn(path.resolve(fixture), [label, 'tones'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
  }));
  try {
    await Promise.all(sources.map(source => once(source.stdout, 'data', { signal: AbortSignal.timeout(10000) })));
    await page.evaluate(async () => {
      const ipc = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args: object) => Promise<void> } }).__TAURI_INTERNALS__;
      await ipc.invoke('desktop_command', { request: { method: 'setInCall', value: true } });
    });
    for (const scope of ['application', 'system'] as const) {
      const opening = page.context().waitForEvent('page', { timeout: 12000 });
      const captured = page.evaluate(async () => {
        const bridge = window.desktop!;
        const context = new AudioContext();
        const oscillator = new OscillatorNode(context, { frequency: 1100 });
        const gain = new GainNode(context, { gain: 0.055 });
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
        await context.resume();
        const share = await bridge.captureNativeVideo!({ width: 400, height: 220, fps: 15 }, true);
        const powers = [0, 0, 0], frequencies = [400, 700, 1100];
        let frames = 0, audio: { id: string; audioScope: string } | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let remove: (() => void) | undefined;
        try {
          const scope = await new Promise<string>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('No scoped PCM from the owned fixtures')), 10000);
            remove = bridge.onCaptureAudio!(packet => {
              if (packet.error) { reject(new Error(packet.error)); return; }
              if (!packet.pcm) return;
              bridge.acknowledgeCaptureAudio!(packet.id);
              const pcm = new Float32Array(packet.pcm.buffer, packet.pcm.byteOffset, packet.pcm.byteLength / 4);
              if (frames++ < 5) return;
              for (const [bin, frequency] of frequencies.entries()) {
                let real = 0, imaginary = 0;
                for (let index = 0; index < pcm.length; index += 2) {
                  const angle = Math.PI * frequency * index / 48000;
                  real += pcm[index] * Math.cos(angle);
                  imaginary += pcm[index] * Math.sin(angle);
                }
                powers[bin] += Math.hypot(real, imaginary) * 4 / pcm.length;
              }
              if (frames === 45 && audio) resolve(audio.audioScope);
            });
            void bridge.startCaptureAudio!().then(value => { audio = value; }, reject);
          });
          return { scope, levels: powers.map(power => power / 40), playback: context.state };
        } finally {
          clearTimeout(timer);
          remove?.();
          if (audio) bridge.stopCaptureAudio?.(audio.id);
          oscillator.stop();
          await context.close();
          share.stop();
        }
      });
      void captured.catch(() => {});
      const picker = await opening;
      await picker.getByRole('option', { name: 'Dorham owned capture fixture selected', exact: true }).click();
      await picker.locator('#scope').selectOption(scope);
      await picker.getByRole('button', { name: 'Share', exact: true }).click();
      const measured = await captured;
      expect(measured.scope).toBe(scope);
      expect(measured.playback).toBe('running');
      const [selected, other, dorham] = measured.levels;
      expect(selected).toBeGreaterThan(0.002);
      expect(dorham).toBeLessThan(selected / 15);
      if (scope === 'application') expect(other).toBeLessThan(selected / 15);
      else expect(other).toBeGreaterThan(0.002);
      console.log(JSON.stringify({ nativePcmScope: scope, selectedTone: selected, unrelatedTone: other, dorhamTone: dorham }));
    }
  } finally {
    for (const source of sources) if (source.exitCode === null) source.kill();
    await page.evaluate(() => { window.desktop?.setInCall(false); }).catch(() => {});
  }
}
