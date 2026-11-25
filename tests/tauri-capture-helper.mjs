/* global AbortController */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

// Uses a real Windows Graphics Capture session, restricted to an owned HWND.
// The helper output is consumed in memory. No desktop images are saved.
const [fixtureFile, captureFile] = process.argv.slice(2);
if (!fixtureFile || !captureFile) throw new Error('Pass the fixture and capture helper executables');
const children = [];
function start(file, args) {
  const child = spawn(path.resolve(file), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  children.push(child);
  return child;
}
async function windowHandle(child) {
  const reader = createInterface(child.stdout);
  try {
    const [line] = await once(reader, 'line', { signal: AbortSignal.timeout(10000) });
    assert.match(line, /^\d+$/);
    return line;
  } finally {
    reader.close();
  }
}
try {
  const selected = start(fixtureFile, ['selected']);
  const unrelated = start(fixtureFile, ['unrelated']);
  const [handle] = await Promise.all([windowHandle(selected), windowHandle(unrelated)]);
  const minimized = process.argv.includes('--minimized');
  const windowAction = action => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File',
    path.resolve('tests/fixtures/tauri-picker-source.ps1'), String(selected.pid), handle, action], {windowsHide:true}));
  if (minimized) assert.equal(windowAction('minimize').minimized, true);
  const capture = start(captureFile, ['window', handle, String(selected.pid), String(process.pid), '400', '220', '15']);
  let pending = Buffer.alloc(0);
  const sourceColors = new Set();
  let resized = false, qualitySent = false, minimizedFrame = false;
  const observed = new Promise((resolve, reject) => {
    capture.once('error', reject);
    capture.stdout.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const tagged = pending.readUInt32LE(), nv12 = Boolean(tagged >>> 31);
        const width = tagged & 0x7fffffff;
        const height = pending.readUInt32LE(4);
        const length = width * height * (nv12 ? 1.5 : 4);
        if (!(width > 0 && width <= 400 && height > 0 && height <= 220)) return reject(new Error('Invalid frame dimensions'));
        if (pending.length < 8 + length) return;
        if (minimized && !minimizedFrame) {
          assert.equal(windowAction('inspect').minimized, true);
          const picture = pending.subarray(8, 8 + (nv12 ? width * height : length));
          assert.ok(picture.some((byte, i) => (nv12 || i % 4 !== 3) && byte > 32), 'Expected content or minimized-window status');
          minimizedFrame = true;
          assert.equal(windowAction('maximize').minimized, false);
        }
        const offset = 8 + 4 * (Math.floor(height / 2) * width + Math.floor(width / 2));
        let [blue, green, red] = pending.subarray(offset, offset + 3);
        if (nv12) {
          const x = width >> 1, y = height >> 1;
          const luma = (pending[8 + y * width + x] - 16) * 255 / 219;
          const uv = 8 + width * height + (y >> 1) * width + (x & ~1);
          const u = pending[uv] - 128, v = pending[uv + 1] - 128;
          red = luma + 1.793 * v; blue = luma + 2.112 * u; green = luma - .213 * u - .533 * v;
        }
        for (const [r,b] of [[189,147],[116,210]]) {
          if (Math.abs(red-r)<5 && Math.abs(blue-b)<5 && Math.abs(green-24)<5) {
            sourceColors.add(r);
            if (qualitySent && width <= 192 && height <= 108) resized = true;
          }
        }
        if (green > 230 && red < 30 && blue < 30) return reject(new Error('Captured unrelated window color'));
        pending = pending.subarray(8 + length);
        if (sourceColors.size === 2 && !qualitySent) {
          qualitySent = true;
          const settings = Buffer.alloc(12);
          [192,108,10].forEach((value,i) => settings.writeUInt32LE(value,4*i));
          capture.stdin.write(settings);
        }
        if (resized) resolve();
      }
    });
  });
  const deadline = new AbortController();
  try {
    await Promise.race([observed, once(capture, 'exit', { signal: deadline.signal }).then(([code]) => {
      throw new Error(`Capture exited before decoding the fixture: ${code}`);
    }), delay(12000, undefined, { signal: deadline.signal }).then(() => {
      throw new Error('Timed out waiting for two distinct fixture frames');
    })]);
  } finally {
    deadline.abort();
  }
  const stopped = once(capture, 'exit', { signal: AbortSignal.timeout(4000) });
  selected.kill();
  assert.equal((await stopped)[0], 0, 'Capture should stop when the source disappears');
  const stale = start(captureFile, ['window', handle, String(selected.pid), String(process.pid), '400', '220', '15']);
  let staleBytes = 0;
  stale.stdout.on('data', chunk => { staleBytes += chunk.length; });
  assert.equal((await once(stale, 'close', { signal: AbortSignal.timeout(4000) }))[0], 3);
  assert.equal(staleBytes, 0, 'A stale HWND must produce no frames');
  console.log(JSON.stringify({ minimizedFrame, resized, distinctSourceFrames: sourceColors.size, unrelatedColorDetected: false, closedSourceStopped: true, staleSourceRejected: true }));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
}
