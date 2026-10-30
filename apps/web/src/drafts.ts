import type { Attachment, Message } from '@dorham/contracts';
export type PendingSend = { requestId: string; content: string; replyTo: string | null; attachmentIds: string[]; createdAt: number; status: 'sending' | 'failed'; error?: string; editMessageId?: string };
export type Draft = { text: string; reply: Message | null; editing: Message | null; files: Attachment[]; pending: PendingSend | null; updatedAt: number };
const storageKey = 'dorham-drafts-v1', maximumBytes = 1048576, maximumAge = 7 * 86400000;
const empty = (): Draft => ({ text: '', reply: null, editing: null, files: [], pending: null, updatedAt: Date.now() });
function target(id: string | undefined, conversationId: string): Message | null {
  return id ? { id, conversationId, sequence: 0, author: { id: '', username: '', displayName: '', bio: '', avatar: null, status: 'offline' }, content: '', replyTo: null, createdAt: 0, editedAt: null, deleted: false, reactions: [] } : null;
}
export class DraftStore {
  private data = new Map<string, Draft>();
  constructor(private storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
    try { const serialized = storage?.getItem(storageKey) || '[]'; if (new TextEncoder().encode(serialized).length > maximumBytes) { storage?.removeItem(storageKey); return; } const raw = JSON.parse(serialized);
      if (Array.isArray(raw)) for (const [key, value] of raw.slice(-200)) {
        if (typeof key !== 'string' || !value || typeof value.text !== 'string' || value.text.length > 4000 || !Number.isFinite(value.updatedAt) || value.updatedAt > Date.now() + 60000 || Date.now() - value.updatedAt > maximumAge) continue;
        const conversation = key.split('\n').at(-1)!;
        const files = Array.isArray(value.files) ? value.files.filter((f: Attachment) => f && typeof f.id === 'string' && typeof f.name === 'string' && Number(f.expiresAt) > Date.now()).slice(0, 4) : [];
        const p = value.pending;
        const pending: PendingSend | null = p && typeof p.requestId === 'string' && p.requestId.length <= 100 && typeof p.content === 'string' && p.content.length <= 4000 && Number.isFinite(p.createdAt) && p.createdAt <= Date.now() + 60000 && (p.replyTo === null || typeof p.replyTo === 'string') && Array.isArray(p.attachmentIds) && p.attachmentIds.length <= 4 && p.attachmentIds.every((id: unknown) => typeof id === 'string' && id.length <= 100) ? { requestId: p.requestId, content: p.content, createdAt: p.createdAt, replyTo: p.replyTo, attachmentIds: p.attachmentIds, editMessageId: typeof p.editMessageId === 'string' ? p.editMessageId : undefined, status: 'failed', error: 'Delivery was interrupted. Retry explicitly.' } : null;
        this.data.set(key, { text: value.text, files, reply: target(value.replyId, conversation), editing: target(value.editingId, conversation), pending, updatedAt: value.updatedAt });
      }
    } catch { /* Storage is optional; malformed records are never sent. */ }
  }
  key(account: string, origin: string, conversation: string) { return [account, origin, conversation].join('\n'); }
  get(key: string): Draft { const existing = this.data.get(key); if (existing && Date.now() - existing.updatedAt <= maximumAge) return existing; return empty(); }
  set(key: string, value: Draft) { this.data.set(key, { ...value, updatedAt: Date.now() }); }
  retain(account: string, origin: string, allowed: Set<string>) {
    const prefix = `${account}\n${origin}\n`; for (const key of this.data.keys()) if (key.startsWith(prefix) && !allowed.has(key.slice(prefix.length))) this.data.delete(key);
    this.flush();
  }
  clear(account: string, origin: string) { const prefix = `${account}\n${origin}\n`; for (const key of this.data.keys()) if (key.startsWith(prefix)) this.data.delete(key); this.flush(); }
  flush() {
    try {
      const records = [...this.data].filter(([, v]) => Date.now() - v.updatedAt <= maximumAge && (v.text || v.files.length || v.reply || v.editing || v.pending)).sort((a, b) => a[1].updatedAt - b[1].updatedAt).slice(-200)
        .map(([key, v]) => [key, { text: v.text, replyId: v.reply?.id, editingId: v.editing?.id, files: v.files, pending: v.pending, updatedAt: v.updatedAt }]);
      let serialized = JSON.stringify(records);
      while (records.length && new TextEncoder().encode(serialized).length > maximumBytes) { const removed = records.shift()!; this.data.delete(removed[0] as string); serialized = JSON.stringify(records); }
      if (records.length) this.storage?.setItem(storageKey, serialized); else this.storage?.removeItem(storageKey);
    } catch { /* A private/low-space browser keeps drafts in memory. */ }
  }
}
