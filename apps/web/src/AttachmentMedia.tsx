import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Capacitor } from '@capacitor/core';
import type { Attachment } from '@dorham/contracts';
import { assetUrl, downloadAttachment, openSavedAttachment, request } from './api';
import { enqueueAndroidDownload, pauseAndroidDownload, useAndroidDownloads } from './android-transfer-queue';
import { AndroidMediaViewer } from './AndroidMediaViewer';
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
  const [browserProgress, setBrowserProgress] = useState<number>();
  const jobs = useAndroidDownloads();
  const [viewerTime, setViewerTime] = useState(0);
  const download = useRef<AbortController>(undefined);
  const dataSaver = useSyncExternalStore(subscribeStorage, () => storageSettings().dataSaver);
  const kind = attachmentKind(file.name);
  const android = Capacitor.getPlatform() === 'android';
  const job = android ? jobs.find(job => job.id === file.id) : undefined;
  const progress = job?.state === 'downloading' || job?.state === 'waiting' ? job.progress : browserProgress;
  const saveStatus = job?.state === 'saved' ? job.gallery ? 'Saved to gallery' : 'File saved' : job?.state === 'paused' ? job.error || 'Download paused. Select Download to resume.' : '';
  const gallery = android && kind !== null;
  const canDownload = file.available && file.expiresAt > Date.now();
  const shouldLoad = visible || (android && expanded);
  const full = (kind === 'image' && expanded) || kind === 'video' || mediaRequested;
  useEffect(() => { const node = host.current; if (!node || !kind || !file.available) return; const observer = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)), { rootMargin: '150px' }); observer.observe(node); return () => observer.disconnect(); }, [file.id, file.available, kind]);
  useEffect(() => {
    if (!kind || !shouldLoad || !file.available || file.expiresAt <= Date.now()) { setSource(''); return; }
    const scope = storageScope(), abort = new AbortController();
    let objectUrl: string | undefined;
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
        throw new Error('Preview unavailable');
      }
      const blob = await response.blob();
      if (abort.signal.aborted || storageScope() !== scope) return;
      put(blob); void saveMedia(scope, id, blob, conversation, kind).catch(() => {});
    })().catch(() => { if (!abort.signal.aborted) setFailed(true); }); }, attempt ? 300 : 0);
    return () => { clearTimeout(timeout); abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); setSource(''); };
  }, [file.id, file.available, file.expiresAt, file.size, kind, shouldLoad, attempt, conversation, dataSaver, full, mediaRequested]);
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
  function startDownload(toGallery = false) {
    if (android) {
      if (job?.state === 'downloading' || job?.state === 'waiting') pauseAndroidDownload(file.id);
      else if (canDownload) {
        try { enqueueAndroidDownload(file.id, file.name, conversation, toGallery); }
        catch (cause) { error(cause); }
      }
      return;
    }
    if (download.current) { download.current.abort(); return; }
    if (!canDownload) return;
    const controller = new AbortController(); download.current = controller; setBrowserProgress(0);
    void downloadAttachment(file.id, file.name, conversation, setBrowserProgress, controller.signal).catch(cause => {
      if (controller.signal.aborted) return;
      error(cause);
    }).finally(() => { download.current = undefined; setBrowserProgress(undefined); });
  }
  useEffect(() => () => download.current?.abort(), [file.id]);
  function openVideo() {
    setViewerTime(video.current?.currentTime ?? 0);
    video.current?.pause();
    setMediaRequested(true);
    setExpanded(true);
  }
  function closeViewer(position: number) {
    if (video.current && Number.isFinite(video.current.duration)) video.current.currentTime = Math.min(position, video.current.duration);
    setExpanded(false);
    requestAnimationFrame(() => {
      const card = host.current;
      if (card && !card.contains(document.activeElement)) card.querySelector<HTMLButtonElement>('.android-media-save button')?.focus();
    });
  }
  const videoStarted = () => window.dispatchEvent(new CustomEvent('dorham-inline-video-play', { detail: file.id }));
  const galleryActions = <div className="android-media-save">
    {progress === undefined ? <>
      <button type="button" className="attachment-download" disabled={!canDownload} onClick={() => startDownload(true)}>{tr('Save to gallery')}</button>
      <button type="button" className="attachment-download" disabled={!canDownload} onClick={() => startDownload()}>{tr('Save as file')}</button>
      {job?.handle && <button type="button" className="attachment-download" onClick={() => { void openSavedAttachment(job.handle!).catch(error); }}>{tr('Open saved file')}</button>}
    </> : <button type="button" className="attachment-download" onClick={() => startDownload()}>{tr('Pause download')}</button>}
  </div>;
  const progressBar = progress !== undefined && <progress value={progress} max={1} aria-label={tr('Download progress')}/>;
  const description = <><strong dir="auto">{file.name}</strong><small>{formatFileSize(file.size)} · {file.available ? tr('Expires: {time}', { time: new Date(file.expiresAt).toLocaleString(currentLanguage()) }) : tr('Expired or unavailable')}</small></>;
  return <div className={`attachment-card ${kind ? 'media-attachment' : ''}${gallery ? ' android-gallery-attachment' : ''}`} ref={host}>
    {file.available && kind && <div className="attachment-preview">
      {source && !failed && (kind === 'image' ? <button className="attachment-image-button" aria-label={tr('Open image: {name}', { name: file.name })} onClick={() => setExpanded(true)}><img src={source} crossOrigin="anonymous" referrerPolicy="no-referrer" alt={file.name} loading="lazy" decoding="async" onError={unavailable}/></button> : <video ref={video} src={source} crossOrigin="anonymous" controls playsInline preload="metadata" aria-label={tr('Play video: {name}', { name: file.name })} onError={unavailable} onPlay={videoStarted}/>)}
      {!source && !failed && ((kind === 'video' || dataSaver) && !mediaRequested ? <button type="button" className="secondary" onClick={android && kind === 'video' ? openVideo : () => setMediaRequested(true)}>{tr(kind === 'video' ? android ? 'Open video' : 'Load video' : 'Load image')}</button> : <span className="preview-status">{tr('Loading preview…')}</span>)}
      {failed && <div className="preview-status">{tr('Preview unavailable. Download the file to view it.')}{!full && <button className="secondary" type="button" onClick={() => setMediaRequested(true)}>{tr('Load original')}</button>}</div>}
    </div>}
    <div className="attachment-caption"><span>{description}{progressBar}{gallery && saveStatus && <small role="status">{tr(saveStatus)}</small>}</span>
      {gallery ? <>{kind === 'video' && source && !failed && <button type="button" className="attachment-download" onClick={openVideo}>{tr('Full screen')}</button>}{galleryActions}</> :
        <button type="button" className="attachment-download" disabled={!canDownload} aria-label={progress === undefined ? tr('Download {name}', { name: file.name }) : tr('Pause download')} onClick={() => startDownload()}>{tr(progress === undefined ? 'Download' : 'Pause download')}</button>}
    </div>
    {android && expanded && kind && <AndroidMediaViewer name={file.name} kind={kind} source={source} failed={failed} initialTime={viewerTime} unavailable={unavailable}
      close={closeViewer} onPlay={videoStarted} actions={<>{galleryActions}{progressBar}{saveStatus && <p className="android-media-status" role="status">{tr(saveStatus)}</p>}</>}/>}
    {!android && kind === 'image' && <dialog ref={dialog} className="image-viewer" aria-label={tr('Image viewer')} onCancel={event => { event.preventDefault(); setExpanded(false); }} onClick={event => { if (event.target === event.currentTarget) setExpanded(false); }} onClose={() => setExpanded(false)}><header><strong dir="auto">{file.name}</strong><button aria-label={tr('Close image')} onClick={() => setExpanded(false)}>×</button></header>{expanded && source && <img src={source} crossOrigin="anonymous" referrerPolicy="no-referrer" alt={file.name} onError={unavailable}/>}<button className="secondary" onClick={() => startDownload()}>{tr(progress === undefined ? 'Download' : 'Pause download')}</button></dialog>}
  </div>;
}
