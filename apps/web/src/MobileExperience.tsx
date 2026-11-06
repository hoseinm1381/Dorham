import { RankBadge } from './Features';
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Users, Mic, MicOff, Headphones, HeadphoneOff, PhoneOff, MonitorUp, Menu, Home, X } from 'lucide-react';
import type { PublicUser, VoiceMember } from '@dorham/contracts';
import { Avatar } from './UserAvatar';
import { SpeakingButton } from './LiveStatus';
import { t, formatNumber } from './i18n';
import './mobile.css';
const landscapeQuery = '(orientation: landscape) and (min-width: 500px) and (max-height: 600px)';
const getLayout = () => matchMedia(landscapeQuery).matches ? 'landscape' : matchMedia('(max-width:600px)').matches ? 'compact' : 'wide';
function watchLayout(notify: () => void) {
  const queries = [matchMedia(landscapeQuery), matchMedia('(max-width:600px)')];
  for (const query of queries) query.addEventListener('change', notify);
  return () => { for (const query of queries) query.removeEventListener('change', notify); };
}
export const useMobileLayout = () => useSyncExternalStore(watchLayout, getLayout, () => 'wide');

export function MobileSheet({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), closeRef = useRef(close); closeRef.current = close;
  useEffect(() => { const node = dialog.current!, focus = document.activeElement as HTMLElement | null; node.showModal(); return () => { node.close(); if (focus?.isConnected) focus.focus(); }; }, []);
  return <dialog ref={dialog} className="mobile-sheet" aria-label={title} onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) close(); }}><section><header><h2>{title}</h2><button aria-label={t('Close dialog')} onClick={close}><X/></button></header>{children}</section></dialog>;
}

export function ParticipantList({ members, actions }: { members: (Pick<VoiceMember, 'user' | 'muted' | 'deafened' | 'serverMuted'> & Partial<VoiceMember>)[]; actions: (user: PublicUser, event: React.MouseEvent<HTMLElement>) => void }) {
  return <div className="mobile-participants">{members.length ? members.map(member => <SpeakingButton key={member.user.id} userId={member.user.id} onClick={e => actions(member.user, e)}><Avatar user={member.user} small/><span><bdi>{member.user.displayName}<RankBadge user={member.user}/></bdi><small>{t(member.serverMuted ? 'Server muted' : member.deafened || member.serverDeafened ? 'Deafened' : member.muted ? 'Muted' : 'In voice')}</small></span>{member.muted || member.serverMuted ? <MicOff size={17}/> : member.deafened || member.serverDeafened ? <HeadphoneOff size={17}/> : null}<span className="participant-more" aria-hidden="true">⋯</span></SpeakingButton>) : <p>{t('No one is in this voice channel yet.')}</p>}</div>;
}

export function MobileCallBar({ name, count, muted, deafened, listenOnly, sharing, busy, status, participants, mute, deafen, share, soundboard, leave }: { name: string; count: number; muted: boolean; deafened: boolean; listenOnly: boolean; sharing: boolean; busy: boolean; status: string; participants: () => void; mute: () => void; deafen: () => void; share: () => void; soundboard?: ReactNode; leave: () => void }) {
  return <section className="mobile-call-bar" aria-label={t('Call controls')}><button className="mobile-call-location" onClick={participants}><strong><bdi>{name}</bdi> · {formatNumber(count)}</strong><small>{t(listenOnly ? 'Listening only' : status || 'Voice connected')}</small></button><div><button aria-label={t(muted ? 'Unmute microphone' : 'Mute microphone')} aria-pressed={muted} disabled={listenOnly} onClick={mute}>{muted ? <MicOff/> : <Mic/>}</button><button aria-label={t(deafened ? 'Undeafen' : 'Deafen')} aria-pressed={deafened} onClick={deafen}>{deafened ? <HeadphoneOff/> : <Headphones/>}</button><button aria-label={t(sharing ? 'Stop sharing' : 'Share screen')} aria-pressed={sharing} disabled={busy} onClick={share}><MonitorUp/></button>{soundboard}<button className="danger" aria-label={t('Disconnect voice')} onClick={leave}><PhoneOff/></button></div></section>;
}

export function MobileNavigation({ home, channels, members }: { home: () => void; channels: () => void; members: () => void }) {
  return <nav className="mobile-navigation" aria-label={t('Main navigation')}><button onClick={home}><Home size={20}/>{t('Home')}</button><button onClick={channels}><Menu size={20}/>{t('Channels')}</button><button onClick={members}><Users size={20}/>{t('Members')}</button></nav>;
}
