import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, event } from './helpers';
import type { GameKind } from '../packages/contracts/src/games';
import { definition } from '../packages/contracts/src/games';

async function fixture() {
  const h = await harness(), owner = await h.register('game_owner'), admin = await h.register('game_admin'), outsider = await h.register('game_outsider');
  const server = (await h.api(owner, '/servers', { name: 'Admin access regression' })).json();
  expect((await h.api(admin, '/admin/claim', { secret: 'test-bootstrap-secret' })).statusCode).toBe(200);
  expect(await h.db.one('SELECT user_id FROM members WHERE user_id=?', [admin.id])).toBeUndefined();
  const channel = (await h.api(owner, '/bootstrap')).json().channels.find((c: any) => c.serverId === server.id && c.kind === 'voice');
  const sockets = [await h.connect(owner), await h.connect(admin)];
  for (const socket of sockets) await event(socket, 'voice:join', { channelId: channel.id, eligible: true });
  return { h, owner, admin, outsider, server, channel, sockets };
}

it('lets an administrator without a membership watch, join and host every arcade game while preserving seat/privacy checks', async () => {
  const { h, owner, admin, outsider, channel, sockets } = await fixture();
  try {
    for (const kind of ['poker', 'domino', 'telephone', 'drawing', 'words', 'ludo', 'four'] as GameKind[]) {
      for (const [host, visitor, visitorSocket] of [[owner, admin, sockets[1]], [admin, owner, sockets[0]]] as const) {
        let response = await h.api(host, '/games', { channelId: channel.id, kind, settings: { maxPlayers: definition(kind).max } });
        expect(response.statusCode, response.body).toBe(200); let g = response.json();
        expect((await h.api(outsider, `/games/${g.id}`)).statusCode).toBe(403);
        response = await h.api(visitor, `/games/${g.id}`); expect(response.statusCode, response.body).toBe(200);
        const watched = await event(visitorSocket, 'game:watch', { id: g.id }); expect(watched.self).toBe(-1);
        response = await h.api(visitor, `/games/${g.id}`, { kind: 'join', revision: response.json().revision });
        expect(response.statusCode, response.body).toBe(200); g = response.json(); expect(g.players).toBe(2);
        if (kind === 'poker') {
          g = (await h.api(host, `/games/${g.id}`, { kind: 'start', revision: g.revision })).json();
          const view = (await h.api(visitor, `/games/${g.id}`)).json();
          expect(view.self).toBe(1); expect(view.state.holes[0]).toEqual([-1, -1]); expect(view.state.holes[1].every((c: number) => c >= 0)).toBe(true);
          expect((await h.api(visitor, `/games/${g.id}`, { kind: 'leave', revision: view.revision })).statusCode).toBe(200);
        } else expect((await h.api(host, `/games/${g.id}`, { kind: 'close', revision: g.revision })).statusCode).toBe(200);
      }
    }
    await event(sockets[1], 'voice:leave', { requestId: randomUUID() });
    const g = (await h.api(owner, '/games', { channelId: channel.id, kind: 'four', settings: { maxPlayers: 2 } })).json();
    expect((await h.api(admin, `/games/${g.id}`)).statusCode).toBe(403);
    await h.db.run('UPDATE users SET banned=1 WHERE id=?', [admin.id]);
    expect((await h.api(admin, `/games/${g.id}`)).statusCode).toBe(401);
  } finally { await h.close(); }
});

it('uses administrator server access for Chess creation, open seats, moves and change notifications', async () => {
  const { h, owner, admin, outsider, server, channel, sockets } = await fixture();
  try {
    const changes: any[] = []; sockets[1].on('chess:changed', g => changes.push(g));
    for (const [host, visitor] of [[owner, admin], [admin, owner]]) {
      let response = await h.api(host, '/chess', { serverId: server.id, channelId: channel.id, openSeat: true, mode: 'standard', minutes: 3, increment: 0 });
      expect(response.statusCode, response.body).toBe(200); let g = response.json();
      expect((await h.api(outsider, `/chess/${g.id}`)).statusCode).toBe(403);
      expect((await h.api(visitor, `/chess/${g.id}`)).statusCode).toBe(200);
      await expect.poll(() => changes.some(e => e.id === g.id)).toBe(true);
      response = await h.api(visitor, `/chess/${g.id}`, { kind: 'join', revision: g.revision });
      expect(response.statusCode, response.body).toBe(200); g = response.json();
      response = await h.api(host, `/chess/${g.id}`, { kind: 'action', revision: g.revision, action: { from: 52, to: 36 } });
      expect(response.statusCode, response.body).toBe(200); g = response.json();
      expect((await h.api(admin, `/chess?serverId=${server.id}`)).statusCode).toBe(200);
      expect((await h.api(visitor, `/chess/${g.id}`, { kind: 'resign', revision: g.revision })).statusCode).toBe(200);
    }
  } finally { await h.close(); }
});
