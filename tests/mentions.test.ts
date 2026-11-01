import { expect, it } from 'vitest';
import { mentionTokens, mentionQuery } from '../packages/contracts/src/mentions';
import { harness, event } from './helpers';

it('parses complete individual usernames, ignoring emails, URLs, code and partial names', () => {
  const text = 'سلام @Alice_1، (@bob) @bob! mail@alice_1 https://test/@bob `@bob` ```@bob``` @ab @abcdefghijklmnopqrstuvwxyz123456789 @bobفارسی';
  expect(mentionTokens(text).map(t => text.slice(t.start, t.end))).toEqual(['@Alice_1', '@bob', '@bob']);
  expect(mentionTokens('`unclosed @bob')).toEqual([]);
  expect(mentionQuery('سلام @علی', 9)).toEqual({ start: 5, end: 9, query: 'علی' });
  expect(mentionQuery('@alices tail', 3)).toEqual({ start: 0, end: 7, query: 'al' });
  expect(mentionQuery('@alice', 0)).toBeNull();
  for (const text of ['email@bob', 'https://test/@bob', '`@bob', 'text @bob next']) expect(mentionQuery(text, text.length)).toBeNull();
});

it('resolves and persists only eligible channel recipients and never rebroadcasts a send retry', async () => {
  const h = await harness();
  try {
    const a = await h.register('mention_author'), b = await h.register('mention_bob'), c = await h.register('mention_hidden'), outsider = await h.register('mention_outside');
    const server = (await h.api(a, '/servers', { name: 'Mentions' })).json(), invite = (await h.api(a, `/servers/${server.id}/invites`, { uses: 10 })).json();
    for (const u of [b, c]) await h.api(u, '/invites/join', { code: invite.code });
    await h.api(a, `/servers/${server.id}/members/${b.id}`, { role: 'moderator' }, 'PATCH');
    const chat = (await h.api(a, '/bootstrap')).json().channels.find((c: any) => c.kind === 'text');
    await h.api(a, `/channels/${chat.id}`, { role: 'member', permissions: { view: false } }, 'PATCH');
    const sb = await h.connect(b), sc = await h.connect(c), so = await h.connect(outsider), received: any[] = [], hidden: any[] = [], outside: any[] = [];
    sb.on('conversation:event', e => received.push(e)); sc.on('conversation:event', e => hidden.push(e)); so.on('conversation:event', e => outside.push(e));
    const body = { requestId: crypto.randomUUID(), conversationId: chat.conversationId, content: '@MENTION_BOB @mention_bob @mention_hidden @mention_outside @unknown' };
    const sent = (await h.api(a, '/messages', body)).json();
    expect(sent.payload.mentions).toEqual([{ userId: b.id, username: 'mention_bob', displayName: 'mention_bob' }]);
    await expect.poll(() => received.length).toBe(1);
    expect((await h.api(a, '/messages', body)).json()).toEqual(sent);
    // A subsequent socket round-trip provides a barrier after the retried send.
    await event(sb, 'typing', { conversationId: chat.conversationId, active: false });
    expect(received).toHaveLength(1); expect(hidden).toHaveLength(0); expect(outside).toHaveLength(0);
    const history = (await h.api(b, `/conversations/${chat.conversationId}/messages`)).json();
    expect(history.messages[0].mentions).toEqual(sent.payload.mentions);
    const edited = (await h.api(a, `/messages/${sent.payload.id}`, { content: 'No tag now' }, 'PATCH')).json();
    expect(edited.payload.mentions).toEqual([]); expect(edited.sequence).toBeGreaterThan(edited.payload.sequence);
    const taggedEdit = (await h.api(a, `/messages/${sent.payload.id}`, { content: '@mention_bob edited' }, 'PATCH')).json();
    expect(taggedEdit.payload.mentions).toHaveLength(1); expect(taggedEdit.sequence).toBeGreaterThan(taggedEdit.payload.sequence);
    const removed = (await h.api(a, `/messages/${sent.payload.id}`, { delete: true }, 'PATCH')).json();
    expect(removed.payload.mentions).toEqual([]); expect(await h.db.all('SELECT * FROM message_mentions')).toEqual([]);
  } finally { await h.close(); }
});

it('ignores blocked recipients, ordinary @text in DMs and injected recipient IDs', async () => {
  const h = await harness();
  try {
    const a = await h.register('tag_sender'), b = await h.register('tag_receiver');
    const server = (await h.api(a, '/servers', { name: 'Block lab' })).json(), invite = (await h.api(a, `/servers/${server.id}/invites`, {})).json();
    await h.api(b, '/invites/join', { code: invite.code });
    const chat = (await h.api(a, '/bootstrap')).json().channels.find((c: any) => c.kind === 'text');
    const dm = (await h.api(a, '/dms', { userId: b.id })).json();
    const plain = (await h.api(a, '/messages', { conversationId: dm.id, content: '@tag_receiver' })).json(); expect(plain.payload.mentions).toEqual([]);
    await h.db.run('INSERT INTO user_blocks(user_id,blocked_id) VALUES(?,?)', [b.id, a.id]);
    const blocked = (await h.api(a, '/messages', { conversationId: chat.conversationId, content: '@tag_receiver' })).json(); expect(blocked.payload.mentions).toEqual([]);
    await h.db.run('DELETE FROM user_blocks'); await h.db.run('INSERT INTO user_blocks(user_id,blocked_id) VALUES(?,?)', [a.id, b.id]);
    const reverse = (await h.api(a, '/messages', { conversationId: chat.conversationId, content: '@tag_receiver' })).json(); expect(reverse.payload.mentions).toEqual([]);
    await h.db.run('DELETE FROM user_blocks');
    const forged = (await h.api(a, '/messages', { conversationId: chat.conversationId, content: 'No tag', mentions: [{ userId: b.id }] })).json(); expect(forged.payload.mentions).toEqual([]);
    // Existing messages must not acquire recipients when a new member joins later.
    await h.api(a, '/messages', { conversationId: chat.conversationId, content: '@future_person' });
    const future = await h.register('future_person'); await h.api(future, '/invites/join', { code: invite.code });
    const history = (await h.api(future, `/conversations/${chat.conversationId}/messages`)).json(); expect(history.messages.at(-1).mentions).toEqual([]);
    expect(await h.db.all('PRAGMA foreign_key_check')).toEqual([]);
  } finally { await h.close(); }
});
