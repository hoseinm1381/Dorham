import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const exec = promisify(execFile);
const capacity = process.argv.includes('--capacity');
if (capacity && process.env.DORHAM_LARGE_MEDIA_TEST !== '1') { console.error('Large media tests are disabled. The 4 GiB browser RAM budget applies to all browser runs.'); process.exit(2); }
if (process.platform !== 'win32') { console.error('This guarded launcher currently measures Windows process memory. Use an OS memory limit before running browser tests on another platform.'); process.exit(2); }
async function usage(pid = 0) { const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/browser-usage.ps1'), '-RootPid', String(pid)], { windowsHide: true }); return JSON.parse(stdout.trim()); }
const baseline = await usage();
if (baseline.totalMiB > 2800) { console.error(`Browser tests were not started: existing Chrome/Edge uses ${baseline.totalMiB} MiB. Keeping headroom below the user's 4 GiB limit.`); process.exit(2); }
const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', capacity ? 'tests/browser/capacity.spec.ts' : 'tests/browser/application.spec.ts'], { stdio: 'inherit', windowsHide: true });
const known = new Set(); const samples = [baseline]; let polling = false, limited = false;
async function stopOwnBrowsers() {
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
