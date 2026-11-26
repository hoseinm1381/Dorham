import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { Pause, Play, Volume2, VolumeX, X, ZoomIn, ZoomOut } from 'lucide-react';
import { t } from './i18n';

type Point = { x: number; y: number };
type View = Point & { scale: number };
type Props = {
  name: string;
  kind: 'image' | 'video';
  source: string;
  failed: boolean;
  initialTime: number;
  actions: ReactNode;
  close: (position: number) => void;
  unavailable: () => void;
  onPlay: () => void;
};

const fit: View = { x: 0, y: 0, scale: 1 };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const center = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function timeLabel(seconds: number) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function AndroidMediaViewer({ name, kind, source, failed, initialTime, actions, close, unavailable, onPlay }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const tapStart = useRef<Point | null>(null);
  const lastTap = useRef<(Point & { time: number }) | null>(null);
  const activeView = useRef(fit);
  const [view, setView] = useState(fit);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const node = dialog.current;
    const previouslyFocused = document.activeElement;
    node?.showModal();
    const pauseWhenHidden = () => { if (document.hidden) video.current?.pause(); };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => {
      document.removeEventListener('visibilitychange', pauseWhenHidden);
      node?.close();
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  function updateView(next: View) {
    const surface = stage.current;
    const media = image.current || video.current;
    const xLimit = Math.max(0, ((media?.offsetWidth ?? 0) * next.scale - (surface?.clientWidth ?? 0)) / 2);
    const yLimit = Math.max(0, ((media?.offsetHeight ?? 0) * next.scale - (surface?.clientHeight ?? 0)) / 2);
    const nextView = next.scale === 1 ? fit : {
      scale: next.scale,
      x: Math.max(-xLimit, Math.min(xLimit, next.x)),
      y: Math.max(-yLimit, Math.min(yLimit, next.y)),
    };
    activeView.current = nextView;
    setView(nextView);
  }

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(() => updateView(activeView.current));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  function zoom(scale: number, before: Point, after: Point = before) {
    const current = activeView.current;
    const bounded = Math.max(1, Math.min(5, scale));
    const ratio = bounded / current.scale;
    updateView({ scale: bounded, x: after.x - (before.x - current.x) * ratio, y: after.y - (before.y - current.y) * ratio });
  }

  function localPoint(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!source || failed || event.button !== 0 || pointers.current.size >= 2) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);
    tapStart.current = pointers.current.size === 1 ? point : null;
    if (!tapStart.current) lastTap.current = null;
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    if (tapStart.current && distance(tapStart.current, point) > 12) tapStart.current = null;
    const other = [...pointers.current].find(([id]) => id !== event.pointerId)?.[1];
    if (other) {
      zoom(activeView.current.scale * distance(point, other) / Math.max(1, distance(previous, other)), center(previous, other), center(point, other));
    } else if (activeView.current.scale > 1) {
      zoom(activeView.current.scale, previous, point);
    }
  }

  function endPointer(event: PointerEvent<HTMLDivElement>, tapped: boolean) {
    if (!pointers.current.delete(event.pointerId)) return;
    const point = localPoint(event);
    if (tapped && tapStart.current && distance(tapStart.current, point) <= 12) {
      const previous = lastTap.current;
      if (previous && event.timeStamp - previous.time < 350 && distance(previous, point) < 30) {
        zoom(activeView.current.scale > 1 ? 1 : 2.5, point);
        lastTap.current = null;
      } else lastTap.current = { ...point, time: event.timeStamp };
    } else lastTap.current = null;
    tapStart.current = null;
  }

  const dismiss = () => close(video.current?.currentTime ?? initialTime);
  const transform = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` };
  return <dialog ref={dialog} className="android-media-viewer" aria-label={t(kind === 'image' ? 'Image viewer' : 'Video viewer')}
    onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header>
      <button type="button" aria-label={t('Close viewer')} onClick={dismiss}><X size={22}/></button>
      <strong dir="auto">{name}</strong>
      <button type="button" aria-label={t('Zoom out')} disabled={view.scale <= 1} onClick={() => zoom(view.scale / 1.5, fit)}><ZoomOut size={20}/></button>
      <button type="button" aria-label={t('Zoom in')} disabled={!source || failed || view.scale >= 5} onClick={() => zoom(view.scale * 1.5, fit)}><ZoomIn size={20}/></button>
    </header>
    <div ref={stage} className="android-media-stage" onPointerDown={pointerDown} onPointerMove={pointerMove}
      onPointerUp={event => endPointer(event, true)} onPointerCancel={event => endPointer(event, false)}
      onLostPointerCapture={event => endPointer(event, false)}>
      {!source || failed ? <p role="status">{t(failed ? 'Preview unavailable. Download the file to view it.' : 'Loading preview…')}</p> : kind === 'image' ?
        <img ref={image} src={source} alt={name} draggable={false} crossOrigin="anonymous" referrerPolicy="no-referrer" style={transform} onError={unavailable}/> :
        <video ref={video} src={source} aria-label={name} playsInline preload="metadata" crossOrigin="anonymous" style={transform}
          muted={muted} onError={unavailable} onPlay={() => { setPlaying(true); onPlay(); }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
          onDurationChange={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
          onTimeUpdate={event => setPosition(event.currentTarget.currentTime)} onLoadedMetadata={event => {
            const media = event.currentTarget;
            const length = Number.isFinite(media.duration) ? media.duration : 0;
            setDuration(length);
            if (initialTime > 0 && initialTime < length) media.currentTime = initialTime;
          }}/>}
    </div>
    <footer>
      {kind === 'video' && source && !failed && <div className="android-media-playback">
        <button type="button" aria-label={t(playing ? 'Pause' : 'Play')} onClick={() => {
          const media = video.current;
          if (media?.paused) void media.play().catch(() => {}); else media?.pause();
        }}>{playing ? <Pause size={21}/> : <Play size={21}/>}</button>
        <span dir="ltr">{timeLabel(position)}</span>
        <input type="range" aria-label={t('Video position')} min={0} max={duration || 1} step={0.01} value={Math.min(position, duration)} disabled={!duration}
          onChange={event => { if (video.current) video.current.currentTime = Number(event.currentTarget.value); }}/>
        <span dir="ltr">{timeLabel(duration)}</span>
        <button type="button" aria-label={t(muted ? 'Unmute' : 'Mute')} onClick={() => setMuted(value => !value)}>{muted ? <VolumeX size={21}/> : <Volume2 size={21}/>}</button>
      </div>}
      {actions}
    </footer>
  </dialog>;
}
