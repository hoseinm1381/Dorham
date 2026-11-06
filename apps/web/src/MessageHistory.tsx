import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Message } from '@dorham/contracts';
import { historyIndex, historyOffsets } from './history-layout';

// Variable-height window, with a fixed overscan. The message bodies/images keep
// their natural sizes; only measured spacer heights are virtualized.
const HistoryItem = memo(function HistoryItem({ message, index, renderMessage }: { message: Message; index: number; renderMessage: (message: Message, index: number) => ReactNode }) {
  return <div data-history-id={message.id} data-sequence={message.sequence} data-deleted={message.deleted || undefined}>{renderMessage(message, index)}</div>;
});
export function MessageHistory({ messages, scroll, renderMessage, visible, jump = 0 }: { messages: Message[]; scroll: RefObject<HTMLDivElement | null>; renderMessage: (message: Message, index: number) => ReactNode; visible: (sequence: number) => void; jump?: number }) {
  const host = useRef<HTMLDivElement>(null), heights = useRef(new Map<string, number>()), anchor = useRef<{ id: string; offset: number } | null>(null);
  const followingLatest = useRef(true);
  const [window, setWindow] = useState({ start: 0, end: 30 }), [revision, resized] = useState(0);
  const offsets = useMemo(() => historyOffsets(messages.map(m => m.id), heights.current), [messages, revision]);
  const indexes = useMemo(() => new Map(messages.map((message, i) => [message.id, i])), [messages]);
  const schedule = useRef<() => void>(() => {}), observer = useRef<ResizeObserver | null>(null), observed = useRef(new Set<Element>()), lastJump = useRef(jump);
  const hostTop = useRef(0), knownScroll = useRef(0), previousMessages = useRef(messages);
  const callback = useRef(visible); callback.current = visible;
  const layout = useRef({ messages, offsets }); layout.current = { messages, offsets };
  // The scrolling ancestor's ref is attached after its children's layout
  // effects on first mount. Install observers after the full DOM commit.
  useEffect(() => {
    const root = scroll.current, node = host.current; if (!root || !node) return;
    const measure = () => {
      const { messages: items, offsets: positions } = layout.current;
      const rootBox = root.getBoundingClientRect();
      const top = node.getBoundingClientRect().top - rootBox.top + root.scrollTop;
      hostTop.current = top; knownScroll.current = root.scrollTop;
      const local = root.scrollTop - top, bottom = local + root.clientHeight;
      followingLatest.current = root.scrollHeight - root.scrollTop - root.clientHeight < 80;
      const first = historyIndex(positions, local);
      const last = Math.min(items.length, historyIndex(positions, bottom) + 1);
      if (items[first]) anchor.current = { id: items[first].id, offset: positions[first] - local };
      const next = { start: Math.max(0, first - 8), end: Math.min(items.length, last + 8) };
      setWindow(old => old.start === next.start && old.end === next.end ? old : next);
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        let highest = 0;
        for (const wrapper of node.querySelectorAll<HTMLElement>('[data-history-id]')) { const box = wrapper.getBoundingClientRect(); if (box.top < rootBox.bottom && box.bottom > rootBox.top && !wrapper.dataset.deleted) highest = Math.max(highest, Number(wrapper.dataset.sequence)); }
        if (highest) callback.current(highest);
      }
    };
    let scheduled = 0;
    const update = () => { if (!scheduled) scheduled = requestAnimationFrame(() => { scheduled = 0; measure(); }); };
    schedule.current = update;
    root.addEventListener('scroll', update, { passive: true }); globalThis.window.addEventListener('focus', update); globalThis.window.addEventListener('focusin', update); document.addEventListener('visibilitychange', update);
    const resize = new ResizeObserver(update); resize.observe(root);
    observer.current = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) { const id = (entry.target as HTMLElement).dataset.historyId!; const next = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height; if (next > 0 && Math.abs((heights.current.get(id) || 100) - next) > 1) { heights.current.set(id, next); changed = true; } }
      if (changed) resized(n => n + 1);
    });
    observed.current.clear();
    node.querySelectorAll('[data-history-id]').forEach(child => { observer.current!.observe(child, { box: 'border-box' }); observed.current.add(child); });
    if (followingLatest.current) root.scrollTop = root.scrollHeight;
    update();
    return () => { root.removeEventListener('scroll', update); globalThis.window.removeEventListener('focus', update); globalThis.window.removeEventListener('focusin', update); document.removeEventListener('visibilitychange', update); resize.disconnect(); observer.current?.disconnect(); observer.current = null; observed.current.clear(); schedule.current = () => {}; cancelAnimationFrame(scheduled); };
  }, [scroll]);
  useLayoutEffect(() => {
    const root = scroll.current, node = host.current; if (!root || !node) return;
    if (lastJump.current !== jump) { followingLatest.current = true; lastJump.current = jump; }
    if (followingLatest.current) root.scrollTop = root.scrollHeight;
    else if (anchor.current) {
      const index = indexes.get(anchor.current.id);
      if (index !== undefined) {
        // Row measurements do not move the host. Re-reading its geometry here
        // forces a synchronous layout after every newly mounted scroll window.
        // A changed history can add/remove the load-earlier header, so refresh
        // the origin for that case; normal scroll/height revisions use the cache.
        if (previousMessages.current !== messages) hostTop.current = node.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
        const target = hostTop.current + offsets[index] - anchor.current.offset;
        if (Math.abs(target - knownScroll.current) > 1) { root.scrollTop = target; knownScroll.current = target; }
      }
    }
    previousMessages.current = messages;
    schedule.current();
  }, [offsets, indexes, jump, scroll, messages]);
  useLayoutEffect(() => {
    const children = new Set(host.current?.querySelectorAll('[data-history-id]') || []);
    for (const child of observed.current) if (!children.has(child)) { observer.current?.unobserve(child); observed.current.delete(child); }
    for (const child of children) if (!observed.current.has(child)) { observer.current?.observe(child, { box: 'border-box' }); observed.current.add(child); }
    schedule.current();
  }, [messages, window.start, window.end]);
  useEffect(() => { const ids = new Set(messages.map(m => m.id)); for (const id of heights.current.keys()) if (!ids.has(id)) heights.current.delete(id); }, [messages]);
  const start = Math.min(window.start, messages.length), end = Math.max(start, Math.min(window.end, messages.length));
  return <div ref={host} className="message-history" style={{ overflowAnchor: 'none' }}><div aria-hidden="true" style={{ height: offsets[start] }}/>{messages.slice(start, end).map((message, i) => <HistoryItem key={message.id} message={message} index={start + i} renderMessage={renderMessage}/>)}<div aria-hidden="true" style={{ height: offsets.at(-1)! - offsets[end] }}/></div>;
}
