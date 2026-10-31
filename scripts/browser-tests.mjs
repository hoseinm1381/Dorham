import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const exec = promisify(execFile);
const capacity = process.argv.includes('--capacity');
const gamingCapacity = process.argv.includes('--gaming-capacity');
if (gamingCapacity && (process.env.DORHAM_GAMING_CAPACITY !== '1' || process.env.DORHAM_SFU_ISOLATED_TEST !== '1')) throw new Error('Gaming capacity requires explicit isolated SFU test flags.');
const budgetMiB = gamingCapacity ? 6144 : 4096, stopThresholdMiB = gamingCapacity ? 5500 : 3500, ownThresholdMiB = gamingCapacity ? 5200 : 2800;
const desktopReleaseIndex = process.argv.indexOf('--desktop-release');
const desktopRelease = desktopReleaseIndex === -1 ? '' : process.argv[desktopReleaseIndex + 1];
if (desktopReleaseIndex !== -1 && (!desktopRelease || desktopRelease.startsWith('--'))) throw Error('Pass Dorham.exe after --desktop-release.');
const desktopAudioIndex = process.argv.indexOf('--desktop-audio');
const desktopAudio = desktopAudioIndex === -1 ? '' : process.argv[desktopAudioIndex + 1];
if (desktopAudioIndex !== -1 && (!desktopAudio || desktopAudio.startsWith('--'))) throw Error('Pass the local test Dorham.exe after --desktop-audio.');
const desktopIndex = process.argv.indexOf('--desktop');
const desktop = desktopIndex === -1 ? '' : process.argv[desktopIndex + 1];
if (desktopIndex !== -1 && (!desktop || desktop.startsWith('--'))) throw new Error('Pass the installed Dorham.exe path after --desktop.');
const mediaUi = process.argv.includes('--media-ui');
const persian = process.argv.includes('--persian');
const releases = process.argv.includes('--releases');
const audioRefresh = process.argv.includes('--audio-refresh');
const audioControls = process.argv.includes('--audio-controls');
const clipboard = process.argv.includes('--clipboard');
const gaming = process.argv.includes('--gaming');
const gamingAudio = process.argv.includes('--gaming-audio');
const chess = process.argv.includes('--chess');
const arcade = process.argv.includes('--arcade');
const muteSounds = process.argv.includes('--mute-sounds');
const microphoneGain = process.argv.includes('--microphone-gain');
const microphoneSelftest = process.argv.includes('--microphone-selftest');
const screenSharing = process.argv.includes('--screen-sharing');
const communityUpdate = process.argv.includes('--community-update');
const voiceVolume = process.argv.includes('--voice-volume');
const memberInvites = process.argv.includes('--member-invites');
const windowsSfu = process.argv.includes('--windows-sfu');
const rtcLocal = process.argv.includes('--rtc-local');
const expansion = process.argv.includes('--expansion');
const hostedRelay = process.argv.includes('--hosted-relay');
const hostedSfu = process.argv.includes('--hosted-sfu');
const relay = process.argv.includes('--relay') || hostedRelay;
const grepIndex = process.argv.indexOf('--grep');
const filter = grepIndex === -1 ? [] : ['--grep', process.argv[grepIndex + 1]];
if (grepIndex !== -1 && !process.argv[grepIndex + 1]) { console.error('Pass a test name expression after --grep.'); process.exit(2); }
if (relay && capacity) { console.error('Choose either the two-client relay test or the capacity test.'); process.exit(2); }
if (hostedSfu && (relay || capacity)) { console.error('Choose the SFU scenario separately.'); process.exit(2); }
if (hostedSfu && !/^https:\/\/[^/]+\/?$/.test(process.env.DORHAM_SFU_BASE_URL || '')) { console.error('Set DORHAM_SFU_BASE_URL to the authorized pilot origin.'); process.exit(2); }
if (process.env.DORHAM_RELAY_ELECTRON_EXE && !hostedRelay && !hostedSfu) { console.error('The Windows media check requires --hosted-relay or --hosted-sfu.'); process.exit(2); }
if (hostedRelay && !/^https:\/\/[^/]+\/?$/.test(process.env.DORHAM_RELAY_BASE_URL || '')) { console.error('Set DORHAM_RELAY_BASE_URL to the authorized HTTPS application origin for hosted verification.'); process.exit(2); }
if (relay && !hostedRelay && (!process.env.TURN_URLS || !process.env.TURN_USERNAME || !process.env.TURN_PASSWORD || [process.env.TURN_USERNAME, process.env.TURN_PASSWORD].some(value => /^\[redacted\]$/i.test(value)) || process.env.CLOUDFLARE_TURN_KEY_ID || process.env.TURN_SECRET)) { console.error('Relay verification needs actual static TURN credentials, not redacted placeholders. Load its private environment file with node --env-file; never pass credentials on the command line.'); process.exit(2); }
if (capacity && process.env.DORHAM_LARGE_MEDIA_TEST !== '1') { console.error('Large media tests are disabled. The 4 GiB browser RAM budget applies to all browser runs.'); process.exit(2); }
if (process.platform !== 'win32') { console.error('This guarded launcher currently measures Windows process memory. Use an OS memory limit before running browser tests on another platform.'); process.exit(2); }
async function usage(pid = 0) { const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/browser-usage.ps1'), '-RootPid', String(pid)], { windowsHide: true }); return JSON.parse(stdout.trim()); }
const baseline = await usage();
if (baseline.totalMiB > (gamingCapacity ? 4200 : 2800)) { console.error(`Browser tests were not started: existing Chrome/Edge uses ${baseline.totalMiB} MiB. Keeping headroom below the user's 4 GiB limit.`); process.exit(2); }
const fixtureNonce = randomUUID(), fixtureManifest = path.resolve('.tools', `browser-fixture-${fixtureNonce}.json`);
process.env.DORHAM_FIXTURE_NONCE = fixtureNonce; process.env.DORHAM_FIXTURE_MANIFEST = fixtureManifest;
const child = spawn(process.execPath, desktopRelease ? ['node_modules/tsx/dist/cli.mjs', 'tests/desktop-release.ts', path.resolve(desktopRelease)] : desktopAudio ? ['node_modules/tsx/dist/cli.mjs', 'tests/desktop-audio-refresh.ts', path.resolve(desktopAudio)] : desktop ? ['node_modules/tsx/dist/cli.mjs', 'tests/desktop-smoke.ts', path.resolve(desktop)] : ['node_modules/@playwright/test/cli.js', 'test', releases ? 'tests/browser/releases.spec.ts' : audioRefresh ? 'tests/browser/audio-refresh.spec.ts' : communityUpdate ? 'tests/browser/community-update.spec.ts' : windowsSfu ? 'tests/browser/windows-sfu.spec.ts' : rtcLocal ? 'tests/browser/rtc-local.spec.ts' : gamingCapacity ? 'tests/browser/gaming-capacity.spec.ts' : screenSharing ? 'tests/browser/screen-sharing.spec.ts' : arcade ? 'tests/browser/arcade.spec.ts' : chess ? 'tests/browser/chess.spec.ts' : muteSounds ? 'tests/browser/mute-sounds.spec.ts' : microphoneSelftest ? 'tests/browser/microphone-selftest.spec.ts' : microphoneGain ? 'tests/browser/microphone-gain.spec.ts' : memberInvites ? 'tests/browser/member-invites.spec.ts' : voiceVolume ? 'tests/browser/voice-volume.spec.ts' : gamingAudio ? 'tests/browser/gaming-audio.spec.ts' : gaming ? 'tests/browser/gaming.spec.ts' : hostedSfu ? 'tests/browser/sfu.spec.ts' : relay ? 'tests/browser/relay.spec.ts' : capacity ? 'tests/browser/capacity.spec.ts' : clipboard ? 'tests/browser/clipboard.spec.ts' : audioControls ? 'tests/browser/audio-controls.spec.ts' : persian ? 'tests/browser/persian-ping.spec.ts' : mediaUi ? 'tests/browser/media-layout.spec.ts' : expansion ? 'tests/browser/expansion.spec.ts' : 'tests/browser/application.spec.ts', ...filter], { stdio: 'inherit', windowsHide: true, env: { ...process.env, DORHAM_SFU_BASE_URL: hostedSfu ? process.env.DORHAM_SFU_BASE_URL : '', DORHAM_RELAY_TEST: relay ? '1' : '0', DORHAM_RELAY_BASE_URL: hostedRelay ? process.env.DORHAM_RELAY_BASE_URL : '' } });
const known = new Set(); const samples = [baseline]; let polling = false, limited = false;
async function stopOwnBrowsers() {
  // End the entire test tree, including the fixture API, before its parent exits.
  // Otherwise a RAM-limited run can leave the local backend/port behind.
  try { await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* already exited; stop sampled browser descendants below */ }
  for (const pid of known) { try { process.kill(pid); } catch { /* exited */ } }
  try { child.kill(); } catch { /* exited */ }
}
const timer = setInterval(async () => {
  if (polling) return; polling = true;
  try {
    const value = await usage(child.pid); samples.push(value); value.ownedBrowserIds.forEach(pid => known.add(pid));
    // Stop well before 4 GiB; never close the user's unrelated browser windows.
    if (value.totalMiB > stopThresholdMiB || value.ownedMiB > ownThresholdMiB) { limited = true; console.error(`Browser test stopped before the ${budgetMiB} MiB budget was reached.`); await stopOwnBrowsers(); }
  } catch { limited = true; console.error('Browser memory monitoring failed; stopping this test.'); await stopOwnBrowsers(); }
  finally { polling = false; }
}, 750);
const code = await new Promise(resolve => child.once('exit', (code) => resolve(code ?? 1)));
clearInterval(timer); await mkdir('artifacts/evidence', { recursive: true });
await writeFile('artifacts/evidence/browser-memory.json', JSON.stringify({ measuredAt: new Date().toISOString(), budgetMiB, stopThresholdMiB, limited, peakTotalBrowserMiB: Math.max(...samples.map(s => s.totalMiB)), peakOwnedBrowserMiB: Math.max(...samples.map(s => s.ownedMiB)), samples }, null, 2));
if (limited) await stopOwnBrowsers();
let cleanupFailed = false;
try {
  const owned = JSON.parse(await readFile(fixtureManifest, 'utf8'));
  const target = path.resolve(owned.dataDir), temp = path.resolve(os.tmpdir());
  if (owned.nonce !== fixtureNonce || path.dirname(target) !== temp || !path.basename(target).startsWith('dorham-browser-')) throw new Error('Fixture ownership verification failed');
  // This directory was created for this nonce, never a shared/live data folder.
  if (process.env.DORHAM_SFU_ISOLATED_TEST === '1') {
    const { default: Database } = await import('better-sqlite3'); const { RoomServiceClient } = await import('livekit-server-sdk');
    const db = new Database(path.join(target, 'dorham.sqlite'), { readonly: true, fileMustExist: true });
    const rooms = db.prepare("SELECT id FROM channels WHERE kind='voice'").all(); db.close();
    const client = new RoomServiceClient(process.env.LIVEKIT_API_URL, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
    for (const room of rooms) if (/^[a-f0-9-]{36}$/.test(room.id)) await client.deleteRoom(room.id).catch(e => { if (e.code !== 'not_found' && !/not found|does not exist/i.test(String(e))) throw e; });
  }
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); await rm(fixtureManifest);
  console.log('Removed the manifest-owned local test database, accounts, servers and files.');
} catch (e) { if (e.code !== 'ENOENT') { cleanupFailed = true; console.error('Owned fixture cleanup failed:', e.message); } }
process.exit(limited ? 2 : cleanupFailed ? 1 : code);
