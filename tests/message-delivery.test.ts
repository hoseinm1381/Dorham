import { expect, it } from 'vitest';
import { confirmMessageDelivery } from '../apps/web/src/message-delivery';

const message = {
  id: 'message', conversationId: 'chat', sequence: 3, author: { id: 'person' },
  content: 'hello', createdAt: 123, deleted: false, reactions: []
};
const delivery = { kind: 'message', conversationId: 'chat', sequence: 3, payload: message };

it('confirms only matching send receipts and accepts receipts from older servers', () => {
  expect(confirmMessageDelivery(delivery, 'chat', 'person', 'operation')).toBe(delivery);
  const current = { ...delivery, requestId: 'operation' };
  expect(confirmMessageDelivery(current, 'chat', 'person', 'operation')).toBe(current);
  for (const unexpected of [{ ok: true }, { error: {} }, null, { ...current, requestId: 'different' },
    { ...current, conversationId: 'elsewhere' }, { ...current, payload: { ...message, author: { id: 'other' } } }]) {
    expect(() => confirmMessageDelivery(unexpected, 'chat', 'person', 'operation')).toThrow();
  }
});
