import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const temp = await mkdtemp(path.join(os.tmpdir(), 'dorham-browser-tts-loading-'));
if (process.env.DORHAM_FIXTURE_MANIFEST) await writeFile(process.env.DORHAM_FIXTURE_MANIFEST, JSON.stringify({ nonce: process.env.DORHAM_FIXTURE_NONCE, dataDir: temp, pid: process.pid }));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'));
const app = await electron.launch({ executablePath: path.resolve(process.argv[2]), args: ['--user-data-dir=' + path.join(temp, 'profile')], env });
try {
  const page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.hide()));
  await page.waitForURL('dorham://app/**');
  const manifest = JSON.parse(await readFile('assets/tts-loading/manifest.json', 'utf8'));
  const assets = (await readdir('apps/web/dist/assets')).filter(name => /^tts-loading-(en|fa)-.*\.wav$/.test(name)); expect(assets).toHaveLength(2);
  const result = await page.evaluate(async (files: string[]) => {
    const context = new AudioContext(), clips = [];
    try {
      for (const file of files) {
        const response = await fetch(`./assets/${file}?v=1.0.7`), data = await response.arrayBuffer();
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data))).map(n => n.toString(16).padStart(2, '0')).join('');
        const bytes = data.byteLength, audio = await context.decodeAudioData(data);
        clips.push({ file, status: response.status, bytes, sha256, seconds: audio.duration, rms: Math.sqrt(audio.getChannelData(0).reduce((sum,n) => sum+n*n,0)/audio.length) });
      }
      return { secureOrigin: window.isSecureContext, origin: location.origin, clips };
    } finally { await context.close(); }
  }, assets);
  expect(result.secureOrigin).toBe(true); expect(result.origin).toBe('dorham://app');
  for (const clip of result.clips) {
    const source = manifest.clips.find((entry: any) => clip.file.startsWith(`tts-loading-${entry.language}-`));
    expect(clip.status).toBe(200); expect(clip.bytes).toBe(source.bytes); expect(clip.sha256).toBe(source.sha256); expect(clip.seconds).toBeCloseTo(source.seconds, 2); expect(clip.rms).toBeGreaterThan(0.005);
  }
  await writeFile('artifacts/evidence/v107-loading-windows-assets.json', JSON.stringify({ ...result, packagedApplication: true, installedUpgradeRetested: false, decodedOnlyNoPhysicalSpeakerClaim: true, isolatedProfile: true }, null, 2));
  console.log('Packaged Windows secure-origin English/Farsi recording fetch and PCM decode passed.');
} finally { await app.close(); await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
