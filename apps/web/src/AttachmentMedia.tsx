import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Attachment } from '@dorham/contracts';
import { assetUrl, downloadAttachment, request } from './api';
import { t as tr, currentLanguage, formatFileSize } from './i18n';
import { readLocal, saveMedia, storageScope, storageSettings, subscribeStorage } from './offline-storage';
import './attachment-media.css';
export function attachmentKind(name: string): 'image' | 'video' | null {
  if (/\.(png|jpe?g|gif|webp)$/i.test(name)) return 'image';
  return /\.(mp4|webm)$/i.test(name) ? 'video' : null;
}
export function AttachmentCard({ file, conversation, error }: { file: Attachment; conversation: string; error: (e: unknown) => void }) {
  const host = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDialogElement>(null), video = useRef<HTMLVideoElement>(null), retry = useRef(0), lastFailure = useRef(0), returnFocus = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false), [source, setSource] = useState(''), [failed, setFailed] = useState(false), [expanded, setExpanded] = useState(false), [attempt, setAttempt] = useState(0);
  const [mediaRequested, setMediaRequested] = useState(false);
  const [progress, setProgress] = useState<number>();
  const download = useRef<AbortController>(undefined);
  const dataSaver = useSyncExternalStore(subscribeStorage, () => storageSettings().dataSaver);
  const kind = attachmentKind(file.name);
  useEffect(() => { const node = host.current; if (!node || !kind || !file.available) return; const observer = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)), { rootMargin: '150px' }); observer.observe(node); return () => observer.disconnect(); }, [file.id, file.available, kind]);
  useEffect(() => {
    if (!kind || !visible || !file.available || file.expiresAt <= Date.now()) { setSource(''); return; }
    const scope = storageScope(), abort = new AbortController();
    let objectUrl: string | undefined;
    const full = expanded || kind === 'video' || mediaRequested;
    const id = (full ? 'full:' : 'thumb:') + file.id;
    const put = (blob: Blob) => { if (!abort.signal.aborted && storageScope() === scope) { objectUrl = URL.createObjectURL(blob); setSource(objectUrl); } };
    setFailed(false);
    const timeout = setTimeout(() => { void (async () => {
      const saved = await readLocal<Blob>(scope, 'media', id);
      if (saved) { put(saved); return; }
      if (kind === 'video' && !mediaRequested || dataSaver && !full) return;
      abort.signal.throwIfAborted();
      const preview = await request(`/attachments/${file.id}/preview`, {}, 'POST', true, { signal: abort.signal });
      const url = new URL(assetUrl(preview.path)!, location.origin);
      if (!full) url.searchParams.set('thumbnail', '1');
      if (full && file.size > 8 * 1024 * 1024) { if (!abort.signal.aborted) setSource(url.href); return; }
      const response = await fetch(url, { signal: abort.signal, referrerPolicy: 'no-referrer' });
      if (!response.ok) {
        if (!full && response.status === 415 && !dataSaver) { url.searchParams.delete('thumbnail'); if (!abort.signal.aborted) setSource(url.href); return; }
        throw new Error('Preview unavailable');
      }
      const blob = await response.blob();
      if (abort.signal.aborted || storageScope() !== scope) return;
      put(blob); void saveMedia(scope, id, blob, conversation, kind).catch(() => {});
    })().catch(() => { if (!abort.signal.aborted) setFailed(true); }); }, attempt ? 300 : 0);
    return () => { clearTimeout(timeout); abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); setSource(''); };
  }, [file.id, file.available, file.expiresAt, file.size, kind, visible, attempt, conversation, dataSaver, expanded, mediaRequested]);
  useEffect(() => {
    const node = host.current, scroll = node?.closest('.message-scroll') as HTMLElement | null; if (!node || !scroll || !kind) return;
    let previousHeight = scroll.scrollHeight;
    const observer = new ResizeObserver(() => { const height = scroll.scrollHeight, delta = height - previousHeight; if (delta > 0 && height - delta - scroll.scrollTop - scroll.clientHeight < 64 && document.visibilityState === 'visible') scroll.scrollTop = height; previousHeight = height; });
    observer.observe(node); return () => observer.disconnect();
  }, [file.id, kind]);
  useEffect(() => {
    const stopOthers = (event: Event) => { if ((event as CustomEvent).detail !== file.id) video.current?.pause(); };
    const hidden = () => { if (document.visibilityState === 'hidden') video.current?.pause(); };
    window.addEventListener('dorham-inline-video-play', stopOthers); document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('dorham-inline-video-play', stopOthers); document.removeEventListener('visibilitychange', hidden); video.current?.pause(); };
  }, [file.id]);
  useEffect(() => {
    const node = dialog.current; if (!node) return;
    if (expanded && !node.open) { returnFocus.current = document.activeElement as HTMLElement; node.showModal(); }
    else if (!expanded && node.open) { node.close(); returnFocus.current?.focus(); }
    return () => { if (node.open) node.close(); };
  }, [expanded]);
  function unavailable() { if (Date.now() - lastFailure.current > 30000) retry.current = 0; lastFailure.current = Date.now(); if (retry.current++ < 1) { setSource(''); setAttempt(n => n + 1); } else setFailed(true); }
  function startDownload() {
    if (download.current) { download.current.abort(); return; }
    const controller = new AbortController(); download.current = controller; setProgress(0);
    void downloadAttachment(file.id, file.name, conversation, setProgress, controller.signal).catch(cause => { if (!controller.signal.aborted) error(cause); }).finally(() => { download.current = undefined; setProgress(undefined); });
  }
  useEffect(() => () => download.current?.abort(), [file.id]);
  const description = <><strong dir="auto">{file.name}</strong><small>{formatFileSize(file.size)} · {file.available ? tr('Expires: {time}', { time: new Date(file.expiresAt).toLocaleString(currentLanguage()) }) : tr('Expired or unavailable')}</small></>;
  return <div className={`attachment-card ${kind ? 'media-attachment' : ''}`} ref={host}>
    {file.available && kind && <div className="attachment-preview">
      {source && !failed && (kind === 'image' ? <button className="attachment-image-button" aria-label={tr('Open image: {name}', { name: file.name })} onClick={() => setExpanded(true)}><img src={source} crossOrigin="anonymous" referrerPolicy="no-referrer" alt={file.name} loading="lazy" decoding="async" onError={unavailable}/></button> : <video ref={video} src={source} crossOrigin="anonymous" controls playsInline preload="metadata" aria-label={tr('Play video: {name}', { name: file.name })} onError={unavailable} onPlay={() => window.dispatchEvent(new CustomEvent('dorham-inline-video-play', { detail: file.id }))}/>)}
      {!source && !failed && ((kind === 'video' || dataSaver) && !mediaRequested ? <button type="button" className="secondary" onClick={() => setMediaRequested(true)}>{tr(kind === 'video' ? 'Load video' : 'Load image')}</button> : <span className="preview-status">{tr('Loading preview…')}</span>)}
      {failed && <span className="preview-status">{tr('Preview unavailable. Download the file to view it.')}</span>}
    </div>}
    <div className="attachment-caption"><span>{description}{progress !== undefined && <progress value={progress} max={1} aria-label={tr('Download progress')}/>}</span><button type="button" className="attachment-download" disabled={!file.available || file.expiresAt <= Date.now()} aria-label={progress === undefined ? tr('Download {name}', { name: file.name }) : tr('Pause download')} onClick={startDownload}>{tr(progress === undefined ? 'Download' : 'Pause download')}</button></div>
    {kind === 'image' && <dialog ref={dialog} className="image-viewer" aria-label={tr('Image viewer')} onCancel={event => { event.preventDefault(); setExpanded(false); }} onClick={event => { if (event.target === event.currentTarget) setExpanded(false); }} onClose={() => setExpanded(false)}><header><strong dir="auto">{file.name}</strong><button aria-label={tr('Close image')} onClick={() => setExpanded(false)}>×</button></header>{expanded && source && <img src={source} crossOrigin="anonymous" referrerPolicy="no-referrer" alt={file.name} onError={unavailable}/>}<button className="secondary" onClick={startDownload}>{tr(progress === undefined ? 'Download' : 'Pause download')}</button></dialog>}
  </div>;
}
