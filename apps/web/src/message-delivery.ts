import type { ConversationEvent, Message } from '@dorham/contracts';

export function confirmMessageDelivery(value: unknown, conversationId: string, authorId: string, requestId: string): ConversationEvent {
  const event = value as (ConversationEvent & { requestId?: string }) | null;
  const message = event?.payload as Message | undefined;
  if (event?.kind !== 'message' || event.conversationId !== conversationId ||
      (event.requestId !== undefined && event.requestId !== requestId) ||
      !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
      !message || message.conversationId !== conversationId || message.sequence !== event.sequence ||
      typeof message.id !== 'string' || !message.id || message.author?.id !== authorId ||
      typeof message.content !== 'string' || !Number.isFinite(message.createdAt) ||
      message.deleted !== false || !Array.isArray(message.reactions)) {
    throw new Error('The server did not confirm message delivery. Dorham will retry.');
  }
  return event;
}
