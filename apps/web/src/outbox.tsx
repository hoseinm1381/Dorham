import { useEffect, useRef, useState } from 'react';
import type { ConversationEvent } from '@dorham/contracts';
import { request } from './api';
import { readLocal, storageScope, updateOutbox } from './offline-storage';
import { t } from './i18n';
import { confirmMessageDelivery } from './message-delivery';
import type { SpeechTarget } from './drafts';

export type OutgoingMessage = { conversationId: string; requestId: string; content: string; tts?: boolean; speech?: SpeechTarget; replyTo: string | null; attachmentIds: string[]; createdAt: number; state?: 'failed'; error?: string };
const day = 24 * 60 * 60 * 1000;
const retryStatus = new Set([408, 425, 429, 500, 502, 503, 504]);

export function useOutbox(scope: string, ready: boolean, accepted: (event: ConversationEvent) => void) {
  const [rows, setRows] = useState<OutgoingMessage[]>([]);
  const [sending, setSending] = useState<string>();
  const [wake, setWake] = useState(0);
  const reference = useRef<OutgoingMessage[]>([]);
  const loaded = useRef<{ scope: string; done: Promise<void> }>(undefined);
  const running = useRef(false);
  const delay = useRef(1000);
  const commitTail = useRef(Promise.resolve());
  const broadcasts = useRef<BroadcastChannel>(undefined);
  const active = useRef({ scope, ready, accepted }); active.current = { scope, ready, accepted };

  useEffect(() => {
    let current = true;
    setRows([]); setSending(undefined); reference.current = []; delay.current = 1000;
    const load = () => readLocal<OutgoingMessage[]>(scope, 'outbox', 'messages').then(saved => {
      if (!current) return;
      reference.current = Array.isArray(saved) ? saved : [];
      setRows(reference.current); setWake(value => value + 1);
    });
    loaded.current = { scope, done: load() };
    const pipe = scope && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('dorham-outbox:' + scope) : undefined;
    broadcasts.current = pipe;
    if (pipe) pipe.onmessage = () => { void load(); };
    return () => { current = false; pipe?.close(); };
  }, [scope]);

  function change(update: (current: OutgoingMessage[]) => OutgoingMessage[]) {
    const owner = active.current.scope;
    const work = commitTail.current.then(async () => {
      if (loaded.current?.scope === owner) await loaded.current.done;
      if (!owner || storageScope() !== owner || owner !== active.current.scope) return;
      const next = await updateOutbox(owner, update);
      if (owner !== active.current.scope) return;
      reference.current = next; setRows(next);
      broadcasts.current?.postMessage('changed');
    });
    commitTail.current = work.catch(() => {});
    return work;
  }

  useEffect(() => {
    if (!scope || !ready || running.current) return;
    const item = rows.find(row => !row.state);
    if (!item) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onOnline = () => { delay.current = 1000; setWake(value => value + 1); };
    window.addEventListener('online', onOnline);
    if (navigator.onLine !== false) {
      const deliver = async () => {
        if (!active.current.ready || active.current.scope !== scope || storageScope() !== scope || !reference.current.some(row => row.requestId === item.requestId)) return;
        if (Date.now() - item.createdAt >= day) {
          await change(current => current.map(row => row.requestId === item.requestId ? { ...row, state: 'failed', error: 'This message expired. Check the conversation before sending it again.' } : row));
          return;
        }
        running.current = true; setSending(item.requestId);
        let retry = false;
        try {
          const { createdAt: _createdAt, state: _state, error: _error, ...body } = item;
          const [, account] = JSON.parse(scope) as [string, string];
          const response = await request<unknown>(`/messages?sender=${encodeURIComponent(account)}`, body);
          const delivery = confirmMessageDelivery(response, item.conversationId, account, item.requestId);
          if (storageScope() !== scope || active.current.scope !== scope) return;
          active.current.accepted(delivery);
          await change(current => current.filter(row => row.requestId !== item.requestId));
        } catch (cause: any) {
          if (storageScope() !== scope || active.current.scope !== scope) return;
          retry = !cause?.status || retryStatus.has(cause.status);
          if (!retry) await change(current => current.map(row => row.requestId === item.requestId ? { ...row, state: 'failed', error: cause.message } : row));
        } finally {
          running.current = false; setSending(undefined);
          delay.current = retry ? Math.min(delay.current * 2, 30000) : 1000;
          setWake(value => value + 1);
        }
      };
      timer = setTimeout(() => void deliver().catch(() => {}), delay.current === 1000 ? 0 : delay.current + Math.random() * 400);
    }
    return () => { clearTimeout(timer); window.removeEventListener('online', onOnline); };
  }, [scope, ready, rows, wake]);

  return {
    rows, sending,
    add: (message: OutgoingMessage) => change(current => {
      if (current.length >= 100) throw new Error('The message queue is full. Wait for a connection before adding more messages.');
      return [...current, message];
    }),
    remove: (id: string) => change(current => current.filter(row => row.requestId !== id)),
    retry: (id: string) => change(current => current.map(row => row.requestId === id ? { ...row, state: undefined, error: undefined } : row)),
  };
}

export function QueuedMessages({ rows, sending, cancel, retry }: { rows: OutgoingMessage[]; sending?: string; cancel: (id: string) => void; retry: (id: string) => void }) {
  return rows.length > 0 && <div aria-label={t('Outgoing messages')} className="composer-wrap">{rows.map(row => <div className="pending-send" key={row.requestId}>
    <span role="status">{t(row.state ? 'Message delivery failed' : row.requestId === sending ? 'Sending…' : 'Queued')}{row.content && <> · <bdi>{row.content}</bdi></>}</span>
    {row.error && <small>{t(row.error)}</small>}
    {row.state === 'failed' && Date.now() - row.createdAt < day && <button type="button" onClick={() => retry(row.requestId)}>{t('Retry message')}</button>}
    {row.requestId !== sending && <button type="button" onClick={() => cancel(row.requestId)}>{t(row.state ? 'Dismiss' : 'Cancel send')}</button>}
  </div>)}</div>;
}
