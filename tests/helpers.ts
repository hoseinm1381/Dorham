import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';
export async function harness(overrides: Parameters<typeof config>[0] = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dorham-test-'));
  const h = await createApp(config({ dataDir, databaseUrl: '', port: 3001, maxUsers: 100, roomShares: 0, globalShares: 0, bootstrapSecret: 'test-bootstrap-secret', stunUrls: [], ...overrides }), { logger: false, rateLimit: false });
  await h.app.listen({ port: 0, host: '127.0.0.1' }); const url = `http://127.0.0.1:${(h.app.server.address() as any).port}`;
  const sockets: Socket[] = [];
  async function register(n: string) {
    const response = await h.app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { 'x-dorham-native': '1' }, payload: { username: n, displayName: n, password: 'correct-horse-123', requestId: randomUUID() } });
    if (response.statusCode !== 201) throw new Error(response.body); const data = response.json(); return { ...data, id: data.user.id, token: data.accessToken };
  }
  async function api(user: { token: string }, route: string, body?: any, method = body ? 'POST' : 'GET') {
    if (method === 'PATCH' && /^\/channels\/[^/]+$/.test(route) && body?.role && body?.permissions && body.expectedRevision === undefined) {
      const document = await h.app.inject({ method: 'GET', url: `/api/v1${route}/overrides?role=${body.role}`, headers: { authorization: `Bearer ${user.token}` } });
      if (document.statusCode === 200) body = { ...body, expectedRevision: document.json().revision };
    }
    return h.app.inject({ method: method as any, url: `/api/v1${route}`, headers: { authorization: `Bearer ${user.token}` }, payload: body ? { requestId: randomUUID(), ...body } : undefined });
  }
  async function connect(user: { token: string }): Promise<Socket> {
    const socket = io(url, { transports: ['websocket'], auth: { token: user.token }, reconnection: false }); sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); }); return socket;
  }
  return { ...h, url, dataDir, register, api, connect, close: async () => { sockets.forEach(s => s.disconnect()); await new Promise(r => setTimeout(r, 30)); await h.app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}
export function event<T = any>(socket: Socket, name: string, body: any = {}): Promise<T> { if (name === 'share:start') body = { protocolVersion: 2, ...body }; return new Promise((resolve, reject) => socket.timeout(5000).emit(name, body, (err: any, response: any) => { if (err) reject(err); else if (!response.ok) reject(new Error(response.error.code)); else resolve(response.data); })); }
