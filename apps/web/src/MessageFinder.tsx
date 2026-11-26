import { useEffect, useRef, useState } from 'react';
import { Pin, Search } from 'lucide-react';
import type { Message } from '@dorham/contracts';
import { request } from './api';
import { formatMessageTime, formatNumber, t } from './i18n';

type Cursor = { before: number; beforeId: string };
type Results = { messages: Message[]; cursor?: Cursor | null };

export function MessageFinder({ conversation, server, channels, canPin, initial, open }: {
  conversation: string; server?: string | null; channels: Map<string, string>;
  canPin: boolean; initial: 'search' | 'pins'; open: (message: Message) => void;
}) {
  const [tab, setTab] = useState(initial), [query, setQuery] = useState(''), [serverWide, setServerWide] = useState(false);
  const [results, setResults] = useState<Message[]>([]), [cursor, setCursor] = useState<Cursor>();
  const [pins, setPins] = useState<Message[]>([]), [searched, setSearched] = useState(false);
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [retention, setRetention] = useState<{ days: number; messageLimit: number }>();
  const criteria = useRef({ query: '', serverWide: false });
  const inflight = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    void request<{ days: number; messageLimit: number }>('/messages/retention', undefined, 'GET', true, { signal: abort.signal }).then(setRetention).catch(() => {});
    return () => { abort.abort(); inflight.current?.abort(); };
  }, []);
  useEffect(() => {
    if (tab === 'search') { input.current?.focus(); return; }
    const abort = new AbortController();
    setNotice('');
    void request<Results>(`/conversations/${encodeURIComponent(conversation)}/pins`, undefined, 'GET', true, { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) setPins(value.messages); })
      .catch(cause => { if (!abort.signal.aborted) setNotice(cause.message); });
    return () => abort.abort();
  }, [tab, conversation]);

  async function search(next?: Cursor) {
    if (!next) criteria.current = { query: query.trim(), serverWide };
    const chosen = criteria.current;
    const params = new URLSearchParams({ q: chosen.query });
    if (chosen.serverWide && server) params.set('server', server);
    else params.set('conversation', conversation);
    if (next) { params.set('before', String(next.before)); params.set('beforeId', next.beforeId); }
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    setBusy(true); setNotice('');
    try {
      const result = await request<Results>(`/messages/search?${params}`, undefined, 'GET', true, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setResults(old => next ? [...old, ...result.messages] : result.messages);
      setCursor(result.cursor ?? undefined); setSearched(true);
    } catch (cause) {
      if (!controller.signal.aborted) setNotice(cause instanceof Error ? cause.message : 'Search failed. Try again.');
    } finally { if (inflight.current === controller) setBusy(false); }
  }
  async function unpin(message: Message) {
    setNotice('');
    try {
      await request(`/conversations/${encodeURIComponent(conversation)}/pins/${encodeURIComponent(message.id)}`, { pinned: false }, 'PATCH');
      setPins(old => old.filter(pin => pin.id !== message.id));
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Could not remove the pin.'); }
  }
  return <section className="message-finder">
    <div className="message-finder-modes">
      <button type="button" className="secondary" aria-pressed={tab === 'search'} onClick={() => setTab('search')}><Search size={16}/>{t('Search messages')}</button>
      <button type="button" className="secondary" aria-pressed={tab === 'pins'} onClick={() => setTab('pins')}><Pin size={16}/>{t('Pinned messages')}</button>
    </div>
    {tab === 'search' && <form onSubmit={event => { event.preventDefault(); void search(); }}>
      <label>{t('Search messages')}<input ref={input} value={query} minLength={2} maxLength={120} required onChange={event => setQuery(event.target.value)} type="search"/></label>
      {server && <label className="check-row"><input type="checkbox" checked={serverWide} onChange={event => setServerWide(event.target.checked)}/>{t('Search this server')}</label>}
      <button className="primary" disabled={busy}>{t(busy ? 'Searching…' : 'Search')}</button>
    </form>}
    {notice && <p role="alert">{t(notice)}</p>}
    {tab === 'search' && searched && !results.length && !busy && <p role="status">{t(cursor ? 'No matches in this part of the history.' : 'No messages found.')}</p>}
    {tab === 'pins' && !pins.length && !notice && <p>{t('No pinned messages yet.')}</p>}
    <ul>{(tab === 'pins' ? pins : results).map(message => <li key={message.id}>
      <button type="button" className="message-finder-result" onClick={() => open(message)}>
        <strong dir="auto">{message.author.displayName}</strong> <small>{channels.get(message.conversationId)} · {formatMessageTime(message.createdAt)}</small>
        <span dir="auto">{message.content.slice(0, 240) || t('Attachment')}</span>
      </button>
      {tab === 'pins' && canPin && <button type="button" className="secondary" onClick={() => { void unpin(message); }}>{t('Unpin')}</button>}
    </li>)}</ul>
    {tab === 'search' && cursor && <button type="button" className="secondary" disabled={busy} onClick={() => { void search(cursor); }}>{t('Search older messages')}</button>}
    {retention && <p>{t('Messages are kept for up to {days} days. The server can also remove older messages when it reaches {count} stored messages.', { days: formatNumber(retention.days), count: formatNumber(retention.messageLimit) })}</p>}
  </section>;
}
