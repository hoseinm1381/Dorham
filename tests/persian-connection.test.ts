import { it, expect, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import ts from 'typescript';
import { io as client } from 'socket.io-client';
import type { Socket } from 'socket.io';
import { ConnectionLatencyMonitor } from '../apps/api/src/connection-latency';
import { normalizePeopleSearch } from '../packages/contracts/src/persian';
import { connectionLatenciesSchema } from '../packages/contracts/src/connection';
import fa from '../apps/web/src/locales/fa-IR.json';
import { harness } from './helpers';

it('matches Persian/Arabic keyboard variants, half-spaces and digits without changing displayed text', () => {
  expect(normalizePeopleSearch('علي كريمي ۱۲۳')).toBe(normalizePeopleSearch('علی کریمی ١٢٣'));
  expect(normalizePeopleSearch('علی‌رضا')).toBe(normalizePeopleSearch('علی رضا'));
  expect(normalizePeopleSearch('مُحَمَّـد')).toBe(normalizePeopleSearch('محمد'));
  expect(normalizePeopleSearch('Friend_81')).toBe('friend_81');
});

it('translates all literal interface keys and preserves interpolation placeholders', async () => {
  expect(Object.values(fa).filter(value => /میبی|گیبی|بی‌کار|راز راه‌اندازی/.test(value))).toEqual([]);
  const keys = new Set<string>();
  for (const file of (await readdir('apps/web/src')).filter(name => /\.tsx?$/.test(name))) {
    const source = ts.createSourceFile(file, await readFile(`apps/web/src/${file}`, 'utf8'), ts.ScriptTarget.Latest, true);
    const literals = (node: ts.Node) => {
      if (ts.isStringLiteral(node)) keys.add(node.text);
      if (ts.isConditionalExpression(node)) { literals(node.whenTrue); literals(node.whenFalse); }
    };
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['t', 'tr'].includes(node.expression.text) && node.arguments[0]) literals(node.arguments[0]);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect([...keys].filter(key => !(fa as Record<string, string>)[key])).toEqual([]);
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const [key, translated] of Object.entries(fa)) expect(placeholders(translated), key).toEqual(placeholders(key));
});

it('measures server-clock RTT, bounds replies and expires or removes connection samples', async () => {
  let now = 100000, mono = 0;
  const monitor = new ConnectionLatencyMonitor(() => now, () => mono);
  const make = (id: string, userId: string, reply = async () => { mono += 42; return { version: 1 }; }) => ({ id, data: { userId }, connected: true, timeout: vi.fn(() => ({ emitWithAck: vi.fn(reply) })) }) as unknown as Socket;
  const a = make('a', 'user-a'), b = make('b', 'user-a', async () => { mono += 12; return { version: 1 }; });
  await monitor.probe(a); await monitor.probe(b);
  expect(monitor.snapshot([a, b])).toEqual([{ userId: 'user-a', milliseconds: 12, measuredAt: now }]);
  const malformed = make('bad', 'user-b', async () => ({ version: 1, milliseconds: 1 }));
  await monitor.probe(malformed); expect(monitor.snapshot([malformed])[0].milliseconds).toBeNull();
  const timeout = make('timeout', 'user-c', async () => { throw Error('timeout'); });
  await monitor.probe(timeout); expect(monitor.snapshot([timeout])[0].milliseconds).toBeNull();
  now += 45001; expect(monitor.snapshot([a, b])[0].milliseconds).toBeNull();
  now += 1; await monitor.probe(a); monitor.remove('a'); expect(monitor.snapshot([a])[0].milliseconds).toBeNull();
  a.connected = false; expect(monitor.snapshot([a])).toEqual([]);
  expect(connectionLatenciesSchema.safeParse([{ userId: 'a', milliseconds: -1, measuredAt: 1 }]).success).toBe(false);
});

it('does not overlap probes or retain a reply from an already disconnected socket', async () => {
  let release!: (value: unknown) => void;
  const reply = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const socket = { id: 'one', data: { userId: 'a' }, connected: true, timeout: () => ({ emitWithAck: reply }) } as unknown as Socket;
  const monitor = new ConnectionLatencyMonitor(), pending = monitor.probe(socket);
  await monitor.probe(socket); expect(reply).toHaveBeenCalledTimes(1);
  socket.connected = false; monitor.remove(socket.id); release({ version: 1 }); await pending;
  socket.connected = true; expect(monitor.snapshot([socket])[0].milliseconds).toBeNull();
});

it('exposes actual socket RTT only through authenticated presence and removes disconnected users', async () => {
  const h = await harness();
  const sockets: ReturnType<typeof client>[] = [];
  try {
    const a = await h.register('ping_user_a'), b = await h.register('ping_user_b');
    expect((await h.app.inject('/api/v1/presence')).statusCode).toBe(401);
    for (const [user, delay] of [[a, 10], [b, 40]] as const) {
      const s = client(h.url, { transports: ['websocket'], auth: { token: user.token }, reconnection: false, autoConnect: false }); sockets.push(s);
      s.on('connection:probe', (body, reply) => { expect(body).toEqual({ version: 1 }); setTimeout(() => reply({ version: 1 }), delay); });
      await new Promise<void>((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject); s.connect(); });
    }
    await vi.waitFor(async () => {
      const presence = (await h.api(a, '/presence')).json();
      const measured = connectionLatenciesSchema.parse(presence.latencies);
      expect(measured).toHaveLength(2); expect(measured.find(s => s.userId === b.id)!.milliseconds).toBeGreaterThanOrEqual(35);
    });
    sockets[1].disconnect();
    await vi.waitFor(async () => { const presence = (await h.api(a, '/presence')).json(); expect(presence.online).not.toContain(b.id); expect(presence.latencies.some((s: any) => s.userId === b.id)).toBe(false); });
  } finally { sockets.forEach(s => s.disconnect()); await h.close(); }
});
