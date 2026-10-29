import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '@dorham/contracts';
import { assetUrl, downloadAttachment, request } from './api';
import { t as tr, currentLanguage, formatFileSize } from './i18n';
import './attachment-media.css';
export function attachmentKind(name: string): 'image' | 'video' | null {
  if (/\.(png|jpe?g|gif|webp)$/i.test(name)) return 'image';
  return /\.(mp4|webm)$/i.test(name) ? 'video' : null;
}
export function AttachmentCard({ file, error }: { file: Attachment; error: (e: unknown) => void }) {
  const host = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDialogElement>(null), video = useRef<HTMLVideoElement>(null), retry = useRef(0), lastFailure = useRef(0), returnFocus = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false), [source, setSource] = useState(''), [failed, setFailed] = useState(false), [expanded, setExpanded] = useState(false), [attempt, setAttempt] = useState(0);
  const kind = attachmentKind(file.name);
  useEffect(() => { const node = host.current; if (!node || !kind || !file.available) return; const observer = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)), { rootMargin: '150px' }); observer.observe(node); return () => observer.disconnect(); }, [file.id, file.available, kind]);
  useEffect(() => {
    if (!kind || !visible || !file.available) { setSource(''); setExpanded(false); return; }
    let canceled = false; setFailed(false);
    const timeout = setTimeout(() => { void request(`/attachments/${file.id}/preview`, {}).then(value => { if (!canceled) setSource(assetUrl(value.path)!); }).catch(() => { if (!canceled) setFailed(true); }); }, attempt ? 300 : 0);
    return () => { canceled = true; clearTimeout(timeout); setSource(''); };
  }, [file.id, file.available, kind, visible, attempt]);
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
  const description = <><strong dir="auto">{file.name}</strong><small>{formatFileSize(file.size)} · {file.available ? tr('Expires: {time}', { time: new Date(file.expiresAt).toLocaleString(currentLanguage()) }) : tr('Expired or unavailable')}</small></>;
  return <div className={`attachment-card ${kind ? 'media-attachment' : ''}`} ref={host}>
    {file.available && kind && <div className="attachment-preview">
      {source && !failed && (kind === 'image' ? <button className="attachment-image-button" aria-label={tr('Open image: {name}', { name: file.name })} onClick={() => setExpanded(true)}><img src={source} crossOrigin="anonymous" referrerPolicy="no-referrer" alt={file.name} loading="lazy" decoding="async" onError={unavailable}/></button> : <video ref={video} src={source} crossOrigin="anonymous" controls playsInline preload="metadata" aria-label={tr('Play video: {name}', { name: file.name })} onError={unavailable} onPlay={() => window.dispatchEvent(new CustomEvent('dorham-inline-video-play', { detail: file.id }))}/>)}
      {!source && !failed && <span className="preview-status">{tr('Loading preview…')}</span>}
      {failed && <span className="preview-status">{tr('Preview unavailable. Download the file to view it.')}</span>}
    </div>}
    <div className="attachment-caption"><span>{description}</span><button type="button" className="attachment-download" disabled={!file.available} aria-label={tr('Download {name}', { name: file.name })} onClick={() => { void downloadAttachment(file.id, file.name).catch(error); }}>{tr('Download')}</button></div>
    {kind === 'image' && <dialog ref={dialog} className="image-viewer" aria-label={tr('Image viewer')} onCancel={event => { event.preventDefault(); setExpanded(false); }} onClick={event => { if (event.target === event.currentTarget) setExpanded(false); }} onClose={() => setExpanded(false)}><header><strong dir="auto">{file.name}</strong><button aria-label={tr('Close image')} onClick={() => setExpanded(false)}>×</button></header>{expanded && source && <img src={source} crossOrigin="anonymous" referrerPolicy="no-referrer" alt={file.name} onError={unavailable}/>}<button className="secondary" onClick={() => { void downloadAttachment(file.id, file.name).catch(error); }}>{tr('Download')}</button></dialog>}
  </div>;
}
