/* global AbortController */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  const child = spawn(path.resolve(file), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
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
  const capture = start(captureFile, ['window', handle, String(selected.pid), String(process.pid), '400', '220', '15']);
  let pending = Buffer.alloc(0);
  const sourceColors = new Set();
  const observed = new Promise((resolve, reject) => {
    capture.once('error', reject);
    capture.stdout.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const width = pending.readUInt32LE();
        const height = pending.readUInt32LE(4);
        const length = width * height * 4;
        if (!(width > 0 && width <= 400 && height > 0 && height <= 220)) return reject(new Error('Invalid frame dimensions'));
        if (pending.length < 8 + length) return;
        const offset = 8 + 4 * (Math.floor(height / 2) * width + Math.floor(width / 2));
        const [blue, green, red] = pending.subarray(offset, offset + 3);
        if (green === 24 && ((red === 189 && blue === 147) || (red === 116 && blue === 210))) sourceColors.add(red);
        if (green > 230 && red < 30 && blue < 30) return reject(new Error('Captured unrelated window color'));
        pending = pending.subarray(8 + length);
        if (sourceColors.size === 2) resolve();
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
  console.log(JSON.stringify({ distinctSourceFrames: sourceColors.size, unrelatedColorDetected: false, closedSourceStopped: true, staleSourceRejected: true }));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
}
