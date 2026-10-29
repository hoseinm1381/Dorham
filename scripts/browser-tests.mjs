import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const exec = promisify(execFile);
const capacity = process.argv.includes('--capacity');
const desktopIndex = process.argv.indexOf('--desktop');
const desktop = desktopIndex === -1 ? '' : process.argv[desktopIndex + 1];
if (desktopIndex !== -1 && (!desktop || desktop.startsWith('--'))) throw new Error('Pass the installed Dorham.exe path after --desktop.');
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
async function usage(pid = 0) { const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/browser-usage.ps1'), '-RootPid', String(pid)], { windowsHide: true }); return JSON.parse(stdout.trim()); }
const baseline = await usage();
if (baseline.totalMiB > 2800) { console.error(`Browser tests were not started: existing Chrome/Edge uses ${baseline.totalMiB} MiB. Keeping headroom below the user's 4 GiB limit.`); process.exit(2); }
const child = spawn(process.execPath, desktop ? ['node_modules/tsx/dist/cli.mjs', 'tests/desktop-smoke.ts', path.resolve(desktop)] : ['node_modules/@playwright/test/cli.js', 'test', hostedSfu ? 'tests/browser/sfu.spec.ts' : relay ? 'tests/browser/relay.spec.ts' : capacity ? 'tests/browser/capacity.spec.ts' : expansion ? 'tests/browser/expansion.spec.ts' : 'tests/browser/application.spec.ts', ...filter], { stdio: 'inherit', windowsHide: true, env: { ...process.env, DORHAM_SFU_BASE_URL: hostedSfu ? process.env.DORHAM_SFU_BASE_URL : '', DORHAM_RELAY_TEST: relay ? '1' : '0', DORHAM_RELAY_BASE_URL: hostedRelay ? process.env.DORHAM_RELAY_BASE_URL : '' } });
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
    if (value.totalMiB > 3500 || value.ownedMiB > 2800) { limited = true; console.error('Browser test stopped before the 4 GiB budget was reached.'); await stopOwnBrowsers(); }
  } catch { limited = true; console.error('Browser memory monitoring failed; stopping this test.'); await stopOwnBrowsers(); }
  finally { polling = false; }
}, 750);
const code = await new Promise(resolve => child.once('exit', (code) => resolve(code ?? 1)));
clearInterval(timer); await mkdir('artifacts/evidence', { recursive: true });
await writeFile('artifacts/evidence/browser-memory.json', JSON.stringify({ measuredAt: new Date().toISOString(), budgetMiB: 4096, stopThresholdMiB: 3500, limited, peakTotalBrowserMiB: Math.max(...samples.map(s => s.totalMiB)), peakOwnedBrowserMiB: Math.max(...samples.map(s => s.ownedMiB)), samples }, null, 2));
if (limited) await stopOwnBrowsers(); process.exit(limited ? 2 : code);
