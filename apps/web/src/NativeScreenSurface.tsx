import { useEffect, useId, useRef, useState } from 'react';
import { registerPlugin } from '@capacitor/core';
import type { RemoteScreen } from '@dorham/media';
import { t } from './i18n';
const media = registerPlugin<any>('DorhamMedia');

export function NativeScreenSurface({ screen }: { screen: RemoteScreen }) {
  const id = useId(), surface = useRef<HTMLDivElement>(null), [ready, setReady] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false, frame = 0, previous = '', handle: { remove(): Promise<void> } | undefined;
    const viewport = window.visualViewport;
    setReady(false); setFailed(false);
    void media.addListener('videoView', (event: { id: string; ready: boolean }) => { if (!disposed && event.id === id) setReady(event.ready); }).then((value: typeof handle) => { if (disposed) void value?.remove(); else handle = value; }).catch(() => setFailed(true));
    const measure = () => {
      frame = 0; const element = surface.current, rect = element?.getBoundingClientRect(); if (!rect || !element || disposed) return;
      const viewportLeft = viewport?.offsetLeft ?? 0, viewportTop = viewport?.offsetTop ?? 0;
      let left = Math.max(viewportLeft, rect.left), top = Math.max(viewportTop, rect.top);
      let right = Math.min(viewportLeft + (viewport?.width ?? innerWidth), rect.right), bottom = Math.min(viewportTop + (viewport?.height ?? innerHeight), rect.bottom);
      const expanded = document.querySelector('.android-stream-expanded');
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display !== 'contents' && (style.overflowX !== 'visible' || style.overflowY !== 'visible')) {
          const box = parent.getBoundingClientRect();
          if (style.overflowX !== 'visible') { left = Math.max(left, box.left); right = Math.min(right, box.right); }
          if (style.overflowY !== 'visible') { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
        }
        if (parent === expanded) break;
      }
      const scrim = document.querySelector('.mobile-scrim');
      const covered = document.querySelector('dialog[open],.member-context-menu') || scrim?.getClientRects().length || (expanded && !expanded.contains(element));
      const value = { id, userId: screen.userId, leaseId: screen.leaseId, local: screen.native?.local === true, x: rect.left - viewportLeft, y: rect.top - viewportTop, width: rect.width, height: rect.height, clipX: left - viewportLeft, clipY: top - viewportTop, clipWidth: Math.max(0, right - left), clipHeight: Math.max(0, bottom - top), visible: !document.hidden && !covered && right > left && bottom > top };
      const next = JSON.stringify(value); if (next === previous) return; previous = next;
      void media.setVideoView(value).catch(() => { if (!disposed) setFailed(true); });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const resumed = () => { previous = ''; schedule(); };
    const resize = new ResizeObserver(schedule); if (surface.current) resize.observe(surface.current);
    const mutation = new MutationObserver(schedule); mutation.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open','class'] });
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule); document.addEventListener('scroll', schedule, true); document.addEventListener('visibilitychange', schedule); window.addEventListener('dorham-app-state', resumed);
    schedule();
    return () => { disposed = true; cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); viewport?.removeEventListener('resize', schedule); viewport?.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); document.removeEventListener('scroll', schedule, true); document.removeEventListener('visibilitychange', schedule); window.removeEventListener('dorham-app-state', resumed); void handle?.remove(); void media.removeVideoView({ id }).catch(() => {}); };
  }, [id, screen.leaseId, screen.userId, screen.native?.local]);
  return <div className="native-video-surface"><div className="native-video-status" data-ready={ready && !failed} role="status">{t(failed ? 'Video could not be displayed. Reopen this stream.' : ready ? 'Video connected' : 'Connecting to screen…')}</div><div ref={surface} className="native-video-frame" aria-label={t(screen.native?.local ? 'Your screen preview' : 'Shared screen')}/></div>;
}
