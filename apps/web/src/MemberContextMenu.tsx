import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Channel, PublicUser, Server, ServerMember, VoicePresence, VoiceRoom } from '@dorham/contracts';
import { canMoveMember, type MemberModerationInfo } from '../../../packages/contracts/src/moderation';
import { request } from './api';
import { t, formatNumber } from './i18n';
import './member-moderation.css';

type Target = { user: PublicUser; serverId: string; x: number; y: number; trigger: HTMLElement };
type LocalAudio = { level: number; restore: number; change: (level: number) => void };
type Options = { me?: PublicUser; serverId: string | null; servers: Server[]; channels: Channel[]; members: ServerMember[]; presence: VoicePresence[]; room: VoiceRoom | null; volumes: Record<string, number>; setVolume: (id: string, level: number) => void; profile: (user: PublicUser) => void; error: (error: unknown) => void; changed: () => Promise<void> };
export function useMemberModeration(o: Options) {
 const [target, setTarget] = useState<Target | null>(null), [drag, setDrag] = useState<{ userId: string; channelId: string; serverId: string } | null>(null), [over, setOver] = useState('');
 const audible = useRef<Record<string, number>>({});
 useEffect(() => { audible.current = {}; }, [o.me?.id]);
 useEffect(() => { setTarget(null); setDrag(null); setOver(''); }, [o.serverId, o.me?.id]);
 function source(user: PublicUser) { return o.room?.members.some(m => m.user.id === user.id) ? o.room.channelId : o.presence.find(v => v.members.some(m => m.user.id === user.id))?.channelId; }
 function allowed(user: PublicUser, channelId?: string) {
  const ch = o.channels.find(c => c.id === channelId), server = o.servers.find(s => s.id === ch?.serverId), member = o.members.find(m => m.user.id === user.id), actor = o.members.find(m => m.user.id === o.me?.id);
  return Boolean(ch?.permissions.moderate && server?.id === o.serverId && member && user.id !== o.me?.id && canMoveMember(actor?.authority || server!.role, member.authority || member.role));
 }
 function bind(user: PublicUser, channelId = source(user)) {
  return {
   onContextMenu: (e: MouseEvent<HTMLElement>) => {
    const serverId = o.channels.find(c => c.id === channelId)?.serverId || o.serverId;
    if (!serverId) return;
    e.preventDefault(); e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect();
    setTarget({ user, serverId, x: e.clientX || rect.left + 10, y: e.clientY || rect.bottom, trigger: e.currentTarget });
   },
   draggable: allowed(user, channelId),
   onDragStart: (e: DragEvent<HTMLElement>) => {
    if (!channelId || !allowed(user, channelId) || (e.target as HTMLElement).closest('input,select,textarea')) { e.preventDefault(); return; }
    const serverId = o.channels.find(c => c.id === channelId)!.serverId; const value = { userId: user.id, channelId, serverId };
    e.dataTransfer.setData('application/x-dorham-voice', JSON.stringify(value)); e.dataTransfer.effectAllowed = 'move'; setDrag(value); setTarget(null);
   },
   onDragEnd: () => { setDrag(null); setOver(''); }
  };
 }
 function drop(channel: Channel) {
  const enabled = Boolean(drag && channel.kind === 'voice' && channel.serverId === drag.serverId && channel.id !== drag.channelId && channel.permissions.moderate);
  return { 'data-voice-drop': enabled ? over === channel.id ? 'active' : 'ready' : undefined,
   onDragOver: (e: DragEvent<HTMLElement>) => { if (enabled) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(channel.id); } },
   onDragLeave: (e: DragEvent<HTMLElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(''); },
   onDrop: (e: DragEvent<HTMLElement>) => { if (!enabled || !drag) return; e.preventDefault(); const from = drag; setDrag(null); setOver(''); void request(`/voice/${from.channelId}/move`, { userId: from.userId, channelId: channel.id }).then(o.changed).catch(o.error); }
  };
 }
 const audioId = target?.user.id;
 const audio: LocalAudio | undefined = audioId && audioId !== o.me?.id && o.room?.members.some(m => m.user.id === audioId) ? {
  level: o.volumes[audioId] ?? 100, restore: audible.current[audioId] || 100,
  change: value => {
   const level = Math.max(0, Math.min(200, value)), previous = o.volumes[audioId] ?? 100;
   if (level > 0) audible.current[audioId] = level; else if (previous > 0) audible.current[audioId] = previous;
   o.setVolume(audioId, level);
  }
 } : undefined;
 return { bind, drop, menu: target && <MemberContextMenu key={`${target.serverId}:${target.user.id}`} target={target} channels={o.channels} audio={audio} close={() => setTarget(null)} profile={o.profile} changed={o.changed}/> };
}

function MemberContextMenu({ target, channels, audio, close, profile, changed }: { target: Target; channels: Channel[]; audio?: LocalAudio; close: () => void; profile: (user: PublicUser) => void; changed: () => Promise<void> }) {
 const ref = useRef<HTMLDivElement>(null), [info, setInfo] = useState<MemberModerationInfo | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [moving, setMoving] = useState(false), [confirm, setConfirm] = useState<'kick' | 'ban' | 'timeout' | null>(null), [seconds, setSeconds] = useState(600), [reason, setReason] = useState('');
 const [position, setPosition] = useState({ left: target.x, top: target.y });
 useEffect(() => { let active = true; void request<MemberModerationInfo>(`/servers/${target.serverId}/members/${target.user.id}/moderation`).then(value => { if (active) setInfo(value); }).catch(() => { if (active) setError('Member controls are unavailable.'); }); return () => { active = false; }; }, []);
 useLayoutEffect(() => { const rect = ref.current?.getBoundingClientRect(); if (rect) setPosition({ left: Math.max(8, Math.min(target.x, innerWidth - rect.width - 8)), top: Math.max(8, Math.min(target.y, innerHeight - rect.height - 8)) }); }, [info, moving, confirm, target.x, target.y]);
 useEffect(() => {
  const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
  const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); target.trigger.focus(); } };
  document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape); window.addEventListener('resize', close);
  ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
  return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('resize', close); };
 }, []);
 useEffect(() => { ref.current?.querySelector<HTMLElement>(confirm ? 'select,input,button' : '[role^=menuitem]')?.focus(); }, [confirm]);
 async function action(route: string, body: unknown) { setBusy(true); setError(''); try { await request(route, body); await changed(); close(); } catch (e) { setError(e instanceof Error ? e.message : 'Action failed. Try again.'); setBusy(false); } }
 const memberRoute = `/servers/${target.serverId}/members/${target.user.id}/moderate`;
 const voiceAction = (actionName: string) => { if (info?.voice) void action(`/voice/${info.voice.channelId}/moderate`, { userId: target.user.id, action: actionName }); };
 const destinations = channels.filter(c => c.serverId === target.serverId && c.kind === 'voice' && c.id !== info?.voice?.channelId && c.permissions.moderate);
 return createPortal(<div ref={ref} className="member-context-menu" role={confirm ? 'dialog' : 'menu'} aria-label={t(confirm ? 'Confirm moderation action' : 'Member actions')} style={position} onContextMenu={e => e.preventDefault()} onKeyDown={e => {
  if (confirm || (e.target as HTMLElement).closest('input,select,textarea') || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role^=menuitem]:not(:disabled)') || []); if (!buttons.length) return; e.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
 }}><strong className="context-person"><bdi>{target.user.displayName}</bdi></strong>
  {confirm ? <form onSubmit={e => { e.preventDefault(); void action(memberRoute, { action: confirm, ...(confirm === 'timeout' ? { seconds } : {}), reason }); }}>
   <h3>{t(confirm === 'ban' ? 'Ban from server' : confirm === 'kick' ? 'Kick from server' : 'Time out member')}</h3>
   <p>{t(confirm === 'ban' ? 'They cannot rejoin this server until unbanned.' : confirm === 'kick' ? 'They will leave this server and voice. An invite lets them rejoin.' : 'Temporarily blocks messages, reactions and voice in this server.')}</p>
   {confirm === 'timeout' && <label>{t('Timeout duration')}<select aria-label={t('Timeout duration')} value={seconds} disabled={busy} onChange={e => setSeconds(Number(e.target.value))}>{[[60,'1 minute'],[600,'10 minutes'],[3600,'1 hour'],[86400,'1 day'],[604800,'1 week']].map(([value,label]) => <option key={value} value={value}>{t(String(label))}</option>)}</select></label>}
   <label>{t('Reason (optional)')}<input maxLength={320} value={reason} disabled={busy} onChange={e => setReason(e.target.value)}/></label>
   <div className="context-confirm-buttons"><button type="button" disabled={busy} onClick={() => setConfirm(null)}>{t('Cancel')}</button><button className="danger" type="submit" disabled={busy}>{t(confirm === 'ban' ? 'Confirm ban' : confirm === 'kick' ? 'Confirm kick' : 'Apply timeout')}</button></div>
  </form> : <>
   <button role="menuitem" disabled={busy} onClick={() => { close(); profile(target.user); }}>{t('View profile')}</button>
   {audio && <div className="member-local-audio" role="group" aria-label={t('Personal voice volume')}>
    <label><span>{t('Voice volume for {name}', { name: target.user.displayName })}<output>{formatNumber(audio.level)}%</output></span><input type="range" min={0} max={200} step={1} value={audio.level} aria-label={t('Voice volume for {name}', { name: target.user.displayName })} title={t('0% mutes this person; 100% is original volume; 200% doubles the audio signal.')} onChange={e => audio.change(Number(e.target.value))}/></label>
    <small>{t('Only changes what you hear.')}</small>
    <button type="button" role="menuitemcheckbox" aria-checked={audio.level === 0} onClick={() => audio.change(audio.level === 0 ? audio.restore : 0)}>{t(audio.level === 0 ? 'Unmute for me' : 'Mute for me')}</button>
   </div>}
   {!info && !error && <p role="status">{t('Please wait…')}</p>}
   {info?.voice && <>
    {info.actions.move && destinations.length > 0 && <><button role="menuitem" disabled={busy} aria-expanded={moving} onClick={() => setMoving(!moving)}>{t('Move to voice channel')} <span aria-hidden="true">▸</span></button>{moving && <div className="context-destinations">{destinations.map(c => <button role="menuitem" key={c.id} disabled={busy} onClick={() => { void action(`/voice/${info.voice!.channelId}/move`, { userId: target.user.id, channelId: c.id }); }}>{c.name}</button>)}</div>}</>}
    {info.actions.voice && <><button role="menuitem" disabled={busy} onClick={() => voiceAction(info.voice!.serverMuted ? 'unmute' : 'mute')}>{t(info.voice.serverMuted ? 'Allow microphone' : 'Server mute')}</button><button role="menuitem" disabled={busy} onClick={() => voiceAction(info.voice!.serverDeafened ? 'undeafen' : 'deafen')}>{t(info.voice.serverDeafened ? 'Allow listening' : 'Server deafen')}</button><button role="menuitem" disabled={busy} onClick={() => voiceAction(info.voice!.sharingAllowed ? 'denyShare' : 'allowShare')}>{t(info.voice.sharingAllowed ? 'Disallow screen sharing' : 'Allow screen sharing')}</button><button role="menuitem" disabled={busy} onClick={() => voiceAction('stopShare')}>{t('Stop screen share')}</button><button className="danger" role="menuitem" disabled={busy} onClick={() => voiceAction('kick')}>{t('Disconnect from voice')}</button></>}
   </>}
   {info?.actions.timeout && (info.timeoutUntil > Date.now() ? <button role="menuitem" disabled={busy} onClick={() => { void action(memberRoute, { action: 'untimeout' }); }}>{t('Remove timeout')}</button> : <button role="menuitem" disabled={busy} onClick={() => setConfirm('timeout')}>{t('Time out member')}</button>)}
   {info?.actions.kick && <button className="danger" role="menuitem" disabled={busy} onClick={() => setConfirm('kick')}>{t('Kick from server')}</button>}
   {info?.actions.ban && <button className="danger" role="menuitem" disabled={busy} onClick={() => setConfirm('ban')}>{t('Ban from server')}</button>}
  </>}
  {error && <p role="alert">{t(error)}</p>}
 </div>, document.body);
}

export function ServerBanList({ serverId, error }: { serverId: string; error: (error: unknown) => void }) {
 const [open, setOpen] = useState(false), [bans, setBans] = useState<{ userId: string; displayName: string; reason: string; canUnban: boolean }[]>([]), [busy, setBusy] = useState(false);
 async function load() { setBusy(true); try { setBans((await request<{bans: typeof bans}>(`/servers/${serverId}/bans`)).bans); } catch (e) { error(e); } finally { setBusy(false); } }
 return <details className="server-ban-list" open={open} onToggle={e => { const value = e.currentTarget.open; setOpen(value); if (value) void load(); }}><summary>{t('Server bans')}</summary>{open && <>{bans.length === 0 && !busy && <p>{t('No banned members.')}</p>}{bans.map(b => <div key={b.userId}><span><bdi>{b.displayName}</bdi><small dir="auto">{b.reason}</small></span>{b.canUnban && <button className="secondary" disabled={busy} onClick={() => { setBusy(true); void request(`/servers/${serverId}/members/${b.userId}/moderate`, { action: 'unban' }).then(load).catch(e => { error(e); setBusy(false); }); }}>{t('Unban')}</button>}</div>)}</>}</details>;
}
