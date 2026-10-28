import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
const directory = process.argv[2]; if (!directory) throw new Error('Pass an independently installed deployment-bundle directory.');
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const data = await mkdtemp(path.join(os.tmpdir(), 'dorham-production-data-')), origin = 'https://production-smoke.invalid';
const child = spawn(process.execPath, ['deployment/start.mjs'], { cwd: directory, env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', SERVER_PORT: String(port), PUBLIC_URL: origin, ALLOWED_ORIGINS: origin, DATA_DIR: data, DATABASE_URL: '', COOKIE_SECURE: 'true' }, windowsHide: true });
let logs = ''; child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-12000); }); child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
const base = `http://127.0.0.1:${port}`; let socket;
try {
  let ready = false;
  for (let i = 0; i < 90; i++) { try { ready = (await fetch(`${base}/ready`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* startup */ } if (ready || child.exitCode !== null) break; await new Promise(resolve => setTimeout(resolve, 500)); }
  assert.ok(ready, logs); assert.ok((await fetch(base)).ok);
  const response = await fetch(`${base}/api/v1/auth/register`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Dorham-Native': '1' }, body: JSON.stringify({ username: 'production_check', displayName: 'Production check', password: 'production-test-password', requestId: randomUUID() }) });
  assert.equal(response.status, 201); const credentials = await response.json();
  const snapshot = await fetch(`${base}/api/v1/bootstrap`, { headers: { Origin: origin, Authorization: `Bearer ${credentials.accessToken}` } }); assert.equal(snapshot.status, 200); assert.equal((await snapshot.json()).me.username, 'production_check');
  socket = io(base, { auth: { token: credentials.accessToken }, extraHeaders: { Origin: origin }, transports: ['websocket'], reconnection: false, timeout: 5000 });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  await mkdir('artifacts/evidence', { recursive: true });
  await writeFile('artifacts/evidence/production-smoke.json', JSON.stringify({ testedAt: new Date().toISOString(), independentDirectory: directory, node: process.version, mode: 'production', readiness: true, staticAssets: true, registration: true, authorizedSnapshot: true, websocket: socket.io.engine.transport.name, linuxAndPublicIngress: 'untested' }, null, 2));
  console.log('Independent production bundle passed startup, native database/password modules, registration, authorized snapshot and local WebSocket connection.');
} finally { socket?.disconnect(); child.kill(); await mkdir('artifacts/logs', { recursive: true }); await writeFile('artifacts/logs/production-smoke.log', logs); }
