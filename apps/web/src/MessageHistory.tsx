import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Message } from '@dorham/contracts';

// Variable-height window, with a fixed overscan. The message bodies/images keep
// their natural sizes; only measured spacer heights are virtualized.
export function MessageHistory({ messages, scroll, renderMessage, visible }: { messages: Message[]; scroll: RefObject<HTMLDivElement | null>; renderMessage: (message: Message, index: number) => ReactNode; visible: (sequence: number) => void }) {
  const host = useRef<HTMLDivElement>(null), heights = useRef(new Map<string, number>()), anchor = useRef<{ id: string; offset: number } | null>(null);
  const followingLatest = useRef(true);
  const [window, setWindow] = useState({ start: 0, end: 30 }), [revision, resized] = useState(0);
  const offsets = [0]; for (const m of messages) offsets.push(offsets.at(-1)! + (heights.current.get(m.id) || 100));
  const callback = useRef(visible); callback.current = visible;
  const layout = useRef({ messages, offsets }); layout.current = { messages, offsets };
  useLayoutEffect(() => {
    const root = scroll.current, node = host.current; if (!root || !node) return;
    if (followingLatest.current) root.scrollTop = root.scrollHeight;
    else if (anchor.current) {
      const index = messages.findIndex(m => m.id === anchor.current!.id);
      if (index >= 0) { const top = node.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop; root.scrollTop = top + offsets[index] - anchor.current.offset; }
    }
    const measure = () => {
      const { messages: items, offsets: positions } = layout.current;
      const top = node.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
      const local = root.scrollTop - top, bottom = local + root.clientHeight;
      followingLatest.current = root.scrollHeight - root.scrollTop - root.clientHeight < 80;
      let first = 0; while (first < items.length - 1 && positions[first + 1] <= local) first++;
      let last = first; while (last < items.length && positions[last] < bottom) last++;
      if (items[first]) anchor.current = { id: items[first].id, offset: positions[first] - local };
      const next = { start: Math.max(0, first - 8), end: Math.min(items.length, last + 8) };
      setWindow(old => old.start === next.start && old.end === next.end ? old : next);
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        const rootBox = root.getBoundingClientRect(); let highest = 0;
        for (const wrapper of node.querySelectorAll<HTMLElement>('[data-history-id]')) { const box = wrapper.getBoundingClientRect(); if (box.top < rootBox.bottom && box.bottom > rootBox.top && !wrapper.dataset.deleted) highest = Math.max(highest, Number(wrapper.dataset.sequence)); }
        if (highest) callback.current(highest);
      }
    };
    measure(); let scheduled = 0;
    const update = () => { if (!scheduled) scheduled = requestAnimationFrame(() => { scheduled = 0; measure(); }); };
    root.addEventListener('scroll', update, { passive: true }); globalThis.window.addEventListener('focus', update); globalThis.window.addEventListener('focusin', update); document.addEventListener('visibilitychange', update);
    const resize = new ResizeObserver(update); resize.observe(root);
    return () => { root.removeEventListener('scroll', update); globalThis.window.removeEventListener('focus', update); globalThis.window.removeEventListener('focusin', update); document.removeEventListener('visibilitychange', update); resize.disconnect(); cancelAnimationFrame(scheduled); };
  }, [messages, revision]);
  useLayoutEffect(() => {
    const node = host.current; if (!node) return;
    const observer = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) { const id = (entry.target as HTMLElement).dataset.historyId!; const next = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height; if (next > 0 && Math.abs((heights.current.get(id) || 100) - next) > 1) { heights.current.set(id, next); changed = true; } }
      if (changed) resized(n => n + 1);
    });
    node.querySelectorAll('[data-history-id]').forEach(child => observer.observe(child));
    return () => observer.disconnect();
  }, [messages, window.start, window.end]);
  useEffect(() => { const ids = new Set(messages.map(m => m.id)); for (const id of heights.current.keys()) if (!ids.has(id)) heights.current.delete(id); }, [messages]);
  const start = Math.min(window.start, messages.length), end = Math.max(start, Math.min(window.end, messages.length));
  return <div ref={host} className="message-history"><div aria-hidden="true" style={{ height: offsets[start] }}/>{messages.slice(start, end).map((m, i) => <div key={m.id} data-history-id={m.id} data-sequence={m.sequence} data-deleted={m.deleted || undefined}>{renderMessage(m, start + i)}</div>)}<div aria-hidden="true" style={{ height: offsets.at(-1)! - offsets[end] }}/></div>;
}
