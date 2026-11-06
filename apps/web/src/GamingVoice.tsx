import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { MonitorUp, Radio, X, MessageCircle, Maximize, Minimize } from 'lucide-react';
import type { Share, VoiceRoom } from '@dorham/contracts';
import type { MediaTransport, RemoteScreen } from '@dorham/media';
import { NativeScreenSurface } from './NativeScreenSurface';
import { ParticipantList } from './MobileExperience';
import type { PublicUser } from '@dorham/contracts';
import { t, formatNumber } from './i18n';
import './gaming.css';

function ConnectingStream({ cancel }: { cancel: () => void }) {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setDelayed(true), 15000); return () => clearTimeout(timer); }, []);
  return <div className="stream-connecting"><p className="screen-status" role="status">{t(delayed ? 'No video received yet. Check the media connection or reopen this stream.' : 'Connecting to screen…')}</p><button onClick={cancel}>{t('Cancel')}</button></div>;
}

function StreamView({ screen, name, close, children }: { screen?: RemoteScreen; name: string; close: () => void; children?: ReactNode }) {
  const android = Capacitor.getPlatform() === 'android';
  const container = useRef<HTMLDivElement>(null), [fullscreen, setFullscreen] = useState(false);
  const video = useRef<HTMLVideoElement>(null), [received, setReceived] = useState(false), [delayed, setDelayed] = useState(false);
  const stream = screen?.stream, attach = screen?.attach;
  useEffect(() => {
    const element = video.current;
    if (!element || !stream) return;
    setReceived(false);
    setDelayed(false);
    const detach = attach?.(element);
    if (!attach) element.srcObject = stream;
    const timeout = setTimeout(() => setDelayed(true), 15000);
    return () => { clearTimeout(timeout); detach?.(); element.srcObject = null; };
  }, [stream, attach]);
  useEffect(() => {
    if (android) return;
    const changed = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, [android]);
  useEffect(() => {
    if (!android || !fullscreen) return;
    const back = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      setFullscreen(false);
    };
    window.addEventListener('dorham-back', back, true);
    return () => window.removeEventListener('dorham-back', back, true);
  }, [android, fullscreen]);
  const toggleFullscreen = () => {
    if (android) { setFullscreen(value => !value); return; }
    const task = fullscreen ? document.exitFullscreen() : container.current?.requestFullscreen();
    void task?.catch(() => {});
  };
  return <div ref={container} className={`stream-view ${android && fullscreen ? 'android-stream-expanded' : ''}`}>
    {screen ? <div className="screen">
      {screen.native ? <NativeScreenSurface screen={screen}/> : <video ref={video} onDoubleClick={toggleFullscreen} autoPlay playsInline muted onLoadedData={() => setReceived(true)} onEmptied={() => setReceived(false)}/>}
      {!screen.native && !received && <p className="screen-status" role="status">{t(delayed ? 'No video received yet. Check the media connection or reopen this stream.' : 'Connecting to screen…')}</p>}
      <div className="screen-controls">
        <bdi>{name}</bdi>
        <span><button aria-label={t(fullscreen ? 'Exit fullscreen stream' : 'Fullscreen stream')} onClick={toggleFullscreen}>{fullscreen ? <Minimize size={17}/> : <Maximize size={17}/>}</button><button aria-label={t('Stop watching stream')} onClick={close}><X size={17}/></button></span>
      </div>
    </div> : <ConnectingStream cancel={close}/>}
    {children}
  </div>;
}
type Props = {
  room: VoiceRoom; userId: string; name: string; transport: MediaTransport | null; navigation: string | null;
  screens: Record<string, RemoteScreen>; localScreen: RemoteScreen | null; previewOwn: boolean; toggleOwn: () => void;
  error: (e: unknown) => void; viewer: (active: boolean) => void;
  chatOpen: boolean; toggleChat: () => void; participants?: () => void; memberActions?: (user: PublicUser, event: React.MouseEvent<HTMLElement>) => void;
};
export function GamingVoice(p: Props) {
  const [multi, setMulti] = useState(false), [selected, setSelected] = useState<string[]>([]), [streamLevels, setStreamLevels] = useState<Record<string, number>>({}), [streamMuted, setStreamMuted] = useState<Record<string, boolean>>({}), [previewClosed, setPreviewClosed] = useState(false);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const own = p.room.shares.find(s => s.userId === p.userId), previewSelected = p.previewOwn && !previewClosed, showOwn = previewSelected && Boolean(own && p.localScreen);
  const active = selected.length > 0 || showOwn;
  async function stopWatching(id: string) { const share = p.room.shares.find(s => s.id === id); setSelected(old => old.filter(x => x !== id)); if (share) await p.transport?.subscribe(share, false); }
  async function closeViewer() { const ids = [...selectedRef.current]; setSelected([]); setPreviewClosed(true); for (const id of ids) { const share = p.room.shares.find(s => s.id === id); if (share) await p.transport?.subscribe(share, false); } }
  const closeRef = useRef(closeViewer); closeRef.current = closeViewer;
  useEffect(() => { void closeRef.current().catch(p.error); }, [p.navigation]);
  useEffect(() => { setPreviewClosed(false); }, [p.localScreen?.leaseId]);
  useEffect(() => { p.viewer(active); }, [active]);
  useEffect(() => { setSelected(old => old.filter(id => p.room.shares.some(s => s.id === id))); }, [p.room.shares]);
  useEffect(() => () => { p.viewer(false); }, []);
  async function watch(share: Share) {
    if (selectedRef.current.includes(share.id)) { await stopWatching(share.id); return; }
    if (!multi || selectedRef.current.length >= 3) for (const id of [...selectedRef.current]) await stopWatching(id);
    setSelected(old => [...old.filter(id => id !== share.id), share.id]);
    try { await p.transport?.subscribe(share, true); }
    catch (e) { setSelected(old => old.filter(id => id !== share.id)); throw e; }
  }
  function person(id: string) { return p.room.members.find(m => m.user.id === id)?.user.displayName || t('Member'); }
  return <section className={`voice-stage gaming-voice ${p.room.shares.length ? 'has-shares' : ''} ${active ? 'viewer-open' : ''}`} aria-label={t('Voice channel')}>
    <header className="gaming-voice-header"><span><Radio size={16}/><strong><bdi>{p.name}</bdi></strong><small>{t('{count}/16 in voice', { count: formatNumber(p.room.members.length) })}</small></span><span>
      {active && <><label className="check-row"><input type="checkbox" checked={multi} onChange={e => { const enabled = e.target.checked; setMulti(enabled); if (!enabled) for (const id of selected.slice(1)) void stopWatching(id).catch(p.error); }}/>{t('Multi-view')}</label><button className="viewer-chat-toggle" aria-expanded={p.chatOpen} onClick={p.toggleChat}><MessageCircle size={15}/>{t(p.chatOpen ? 'Hide chat' : 'Show chat')}</button><button aria-label={t('Close stream viewer')} onClick={() => { void closeViewer().catch(p.error); }}><X size={17}/></button></>}
    </span></header>
    {p.participants && <div className="mobile-voice-people"><button onClick={p.participants}>{t('Show participants')} · {formatNumber(p.room.members.length)}</button><ParticipantList members={p.room.members} actions={p.memberActions || (() => {})}/></div>}
    <div className="share-list">{p.room.shares.map(share => <div key={share.id}><MonitorUp size={17}/><span><bdi>{person(share.userId)}</bdi><small className="live-badge">LIVE</small></span>{share.userId === p.userId ? <><span className="share-tier">{t(share.tier === 'fallback' ? '15fps · waiting for a 30fps slot' : '30fps available')}</span><label className="own-preview-toggle"><input type="checkbox" checked={previewSelected} onChange={() => { if (p.previewOwn && previewClosed) setPreviewClosed(false); else { setPreviewClosed(false); p.toggleOwn(); } }}/>{t('Preview my screen')}</label></> : <button className="watch-stream" aria-label={t(selected.includes(share.id) ? 'Close stream' : 'Watch stream')} onClick={() => { void watch(share).catch(p.error); }}>{t(selected.includes(share.id) ? 'Close stream' : 'Watch stream')}</button>}</div>)}</div>
    {own && p.localScreen?.sourceName && <p className="stream-no-audio" role="status"><bdi>{p.localScreen.sourceName}</bdi> · {t(p.localScreen.audioScope === 'application' ? 'Selected application sound' : p.localScreen.audioScope === 'system' ? p.localScreen.native ? 'Phone sound, excluding Dorham' : 'Computer sound, excluding Dorham' : 'Video only')}</p>}
    {active && <div className={`screens ${multi ? 'multi-streams' : 'single-stream'}`}>
      {showOwn && p.localScreen && <StreamView key="local" screen={p.localScreen} name={t('Your screen preview')} close={() => setPreviewClosed(true)}/>}
      {selected.map(id => {
        const screen = p.screens[id], share = p.room.shares.find(s => s.id === id);
        const level = streamLevels[id] ?? 100, muted = Boolean(streamMuted[id]);
        return <StreamView key={id} screen={screen} name={share ? person(share.userId) : t('Member')} close={() => { void stopWatching(id).catch(p.error); }}>
          {share?.includeAudio ? <div className="stream-volume">
            <label htmlFor={`stream-volume-${id}`}>{t('Stream sound')}</label>
            <input id={`stream-volume-${id}`} aria-label={t('Stream sound volume')} type="range" min={0} max={200} value={level} onChange={e => {
              const value = Number(e.target.value);
              setStreamLevels(old => ({ ...old, [id]: value }));
              p.transport?.setStreamVolume?.(id, muted ? 0 : value / 100);
            }}/>
            <span>{formatNumber(level)}%</span>
            <button type="button" aria-pressed={muted} onClick={() => {
              setStreamMuted(old => ({ ...old, [id]: !muted }));
              p.transport?.setStreamVolume?.(id, muted ? level / 100 : 0);
            }}>{t(muted ? 'Unmute stream sound' : 'Mute stream sound')}</button>
          </div> : <p className="stream-no-audio" role="status">{t('No sound is being shared. Ask the sharer to restart with Share sound and enable audio in the screen picker.')}</p>}
        </StreamView>;
      })}
    </div>}
  </section>;
}
