import { expect, it } from 'vitest';
import { harness } from './helpers';
import ids from '../packages/contracts/src/emoji-ids.json';
import { reactionValue } from '../packages/contracts/src/emoji-reactions';
it('accepts every registered reaction, retains legacy counts, removes reactions and rejects unknown/unauthorized keys', async () => {
  const h = await harness();
  try {
    const a = await h.register('reaction_a'), b = await h.register('reaction_b'), outsider = await h.register('reaction_out');
    const dm = (await h.api(a, '/dms', { userId: b.id })).json().id;
    const message = (await h.api(a, '/messages', { conversationId: dm, content: 'React here' })).json().payload.id;
    await h.api(b, `/messages/${message}`, { emoji: '👍' }, 'PATCH');
    for (const id of ids) expect((await h.api(b, `/messages/${message}`, { emoji: reactionValue(id) }, 'PATCH')).statusCode, id).toBe(200);
    let saved = (await h.api(a, `/conversations/${dm}/messages`)).json().messages[0]; expect(saved.reactions).toHaveLength(64);
    expect(saved.reactions.find((r: any) => r.emoji === '👍').userIds).toEqual([b.id]);
    expect((await h.api(b, `/messages/${message}`, { emoji: ':dorham-tea-time:', removeReaction: true }, 'PATCH')).statusCode).toBe(200);
    saved = (await h.api(a, `/conversations/${dm}/messages`)).json().messages[0]; expect(saved.reactions).toHaveLength(63);
    expect((await h.api(b, `/messages/${message}`, { emoji: ':../../outside:' }, 'PATCH')).statusCode).toBe(400);
    expect((await h.api(outsider, `/messages/${message}`, { emoji: ':dorham-tea-time:' }, 'PATCH')).statusCode).toBe(403);
  } finally { await h.close(); }
});
