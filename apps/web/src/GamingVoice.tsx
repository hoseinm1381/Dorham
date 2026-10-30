import { useEffect, useRef, useState } from 'react';
import { MonitorUp, Radio, X, MessageCircle, Maximize, Volume2 } from 'lucide-react';
import type { PublicUser, Share, VoiceRoom } from '@dorham/contracts';
import type { MediaTransport, RemoteScreen } from '@dorham/media';
import { t, formatNumber } from './i18n';
import './gaming.css';

function ConnectingStream({ cancel }: { cancel: () => void }) {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setDelayed(true), 15000); return () => clearTimeout(timer); }, []);
  return <div className="stream-connecting"><p className="screen-status" role="status">{t(delayed ? 'No video received yet. Check the media connection or reopen this stream.' : 'Connecting to screen…')}</p><button onClick={cancel}>{t('Cancel')}</button></div>;
}

function StreamScreen({ screen, name, close }: { screen: RemoteScreen; name: string; close: () => void }) {
  const video = useRef<HTMLVideoElement>(null), [received, setReceived] = useState(false), [delayed, setDelayed] = useState(false);
  useEffect(() => { setReceived(false); setDelayed(false); const element = video.current; const detach = element && screen.attach ? screen.attach(element) : undefined; if (element && !screen.attach) element.srcObject = screen.stream; const timeout = setTimeout(() => setDelayed(true), 15000); return () => { clearTimeout(timeout); detach?.(); if (element) element.srcObject = null; }; }, [screen.stream, screen.attach]);
  return <div className="screen"><video ref={video} autoPlay playsInline muted onLoadedData={() => setReceived(true)} onEmptied={() => setReceived(false)}/>{!received && <p className="screen-status" role="status">{t(delayed ? 'No video received yet. Check the media connection or reopen this stream.' : 'Connecting to screen…')}</p>}<div><bdi>{name}</bdi><span><button aria-label={t('Fullscreen stream')} onClick={() => { void video.current?.requestFullscreen().catch(() => {}); }}><Maximize size={17}/></button><button aria-label={t('Stop watching stream')} onClick={close}><X size={17}/></button></span></div></div>;
}
type Props = {
  room: VoiceRoom; userId: string; name: string; transport: MediaTransport | null; navigation: string | null;
  screens: Record<string, RemoteScreen>; localScreen: RemoteScreen | null; previewOwn: boolean; toggleOwn: () => void;
  speaking: Record<string, boolean>; volumes: Record<string, number>; setVolume: (id: string, value: number) => void;
  profile: (user: PublicUser) => void; error: (e: unknown) => void; viewer: (active: boolean) => void;
  chatOpen: boolean; toggleChat: () => void; moderation?: (userId: string, action: 'mute' | 'unmute' | 'kick' | 'stopShare') => void;
};
export function GamingVoice(p: Props) {
  const [expanded, setExpanded] = useState(false), [multi, setMulti] = useState(false), [selected, setSelected] = useState<string[]>([]), [streamLevels, setStreamLevels] = useState<Record<string, number>>({}), [streamMuted, setStreamMuted] = useState<Record<string, boolean>>({}), [previewClosed, setPreviewClosed] = useState(false);
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
  return <section className={`voice-stage gaming-voice ${active ? 'viewer-open' : ''} ${expanded ? '' : 'voice-collapsed'}`} aria-label={t('Voice channel')}>
    <header className="gaming-voice-header"><span><Radio size={16}/><strong><bdi>{p.name}</bdi></strong><small>{t('{count}/16 in voice', { count: formatNumber(p.room.members.length) })}</small></span><span>
      <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'Minimize voice' : 'Voice controls')}</button>
      {active && <><label className="check-row"><input type="checkbox" checked={multi} onChange={e => { const enabled = e.target.checked; setMulti(enabled); if (!enabled) for (const id of selected.slice(1)) void stopWatching(id).catch(p.error); }}/>{t('Multi-view')}</label><button className="viewer-chat-toggle" aria-expanded={p.chatOpen} onClick={p.toggleChat}><MessageCircle size={15}/>{t(p.chatOpen ? 'Hide chat' : 'Show chat')}</button><button aria-label={t('Close stream viewer')} onClick={() => { void closeViewer().catch(p.error); }}><X size={17}/></button></>}
    </span></header>
    {expanded && <div className="voice-cards">{p.room.members.map(m => <div key={m.user.id} className={`voice-card ${p.speaking[m.user.id] ? 'speaking' : ''}`}><button onClick={() => p.profile(m.user)}><span className="avatar small">{m.user.displayName.slice(0, 2)}</span><strong><bdi>{m.user.displayName}</bdi></strong></button><span>{t(m.serverMuted ? 'Muted by moderator' : m.deafened ? 'Deafened' : m.muted ? 'Microphone muted' : p.speaking[m.user.id] ? 'Speaking' : 'Listening')}</span>{m.user.id !== p.userId && <label className="volume-slider" title={t("0% mutes this person; 100% is original volume; 200% doubles the audio signal.")}><Volume2 size={14}/><input type="range" aria-label={t('Voice volume for {name}', { name: m.user.displayName })} min={0} max={200} value={p.volumes[m.user.id] ?? 100} onChange={e => p.setVolume(m.user.id, Number(e.target.value))}/><small>{formatNumber(p.volumes[m.user.id] ?? 100)}%</small></label>}{p.moderation && m.user.id !== p.userId && <div className="moderation-actions"><button onClick={() => p.moderation?.(m.user.id, m.serverMuted ? 'unmute' : 'mute')}>{t(m.serverMuted ? 'Unmute' : 'Mute')}</button><button onClick={() => p.moderation?.(m.user.id, 'kick')}>{t('Disconnect')}</button></div>}</div>)}</div>}
    <div className="share-list">{p.room.shares.map(share => <div key={share.id}><MonitorUp size={17}/><span><bdi>{person(share.userId)}</bdi><small className="live-badge">LIVE</small></span>{share.userId === p.userId ? <><span className="share-tier">{t(share.tier === 'fallback' ? '15fps · waiting for a 30fps slot' : '30fps available')}</span><label className="own-preview-toggle"><input type="checkbox" checked={previewSelected} onChange={() => { if (p.previewOwn && previewClosed) setPreviewClosed(false); else { setPreviewClosed(false); p.toggleOwn(); } }}/>{t('Preview my screen')}</label></> : <button className="watch-stream" aria-label={t(selected.includes(share.id) ? 'Close stream' : 'Watch stream')} onClick={() => { void watch(share).catch(p.error); }}>{t(selected.includes(share.id) ? 'Close stream' : 'Watch stream')}</button>}</div>)}</div>
    {active && <div className={`screens ${multi ? 'multi-streams' : 'single-stream'}`}>
      {showOwn && p.localScreen && <StreamScreen screen={p.localScreen} name={t('Your screen preview')} close={() => setPreviewClosed(true)}/>}
      {selected.map(id => <div className="stream-view" key={id}>{p.screens[id] ? <StreamScreen screen={p.screens[id]} name={person(p.screens[id].userId)} close={() => { void stopWatching(id).catch(p.error); }}/> : <ConnectingStream cancel={() => { void stopWatching(id).catch(p.error); }}/>}{p.room.shares.find(s => s.id === id)?.includeAudio && <label className="stream-volume">{t('Stream sound')}<input aria-label={t('Stream sound volume')} type="range" min={0} max={200} value={streamLevels[id] ?? 100} onChange={e => { const value = Number(e.target.value); setStreamLevels(old => ({ ...old, [id]: value })); p.transport?.setStreamVolume?.(id, streamMuted[id] ? 0 : value / 100); }}/><span>{formatNumber(streamLevels[id] ?? 100)}%</span><button type="button" aria-pressed={Boolean(streamMuted[id])} onClick={() => { const muted = !streamMuted[id]; setStreamMuted(old => ({ ...old, [id]: muted })); p.transport?.setStreamVolume?.(id, muted ? 0 : (streamLevels[id] ?? 100) / 100); }}>{t(streamMuted[id] ? 'Unmute stream sound' : 'Mute stream sound')}</button></label>}</div>)}
    </div>}
  </section>;
}
