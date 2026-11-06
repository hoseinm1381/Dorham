import { Capacitor, registerPlugin } from '@capacitor/core';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { VoiceRoom } from '@dorham/contracts';
import type { Socket } from 'socket.io-client';
import { ack } from '../../../packages/media/src/signaling';
import { assetUrl, request, serverUrl } from './api';
import { readAudioChoices } from './AudioDevices';
import { useFeatures } from './Features';
import { t } from './i18n';

const android = Capacitor.getPlatform() === 'android';
const playback = registerPlugin<{
  playSoundboard(value: { wav: string; epoch: string; channelId: string; volume: number }): Promise<void>;
  stopSoundboard(): Promise<void>;
}>('DorhamMedia');
type SoundEvent = { url: string; epoch: string; channelId: string; expiresAt: number; senderId?: string };
const assetPath = /^\/catalog\/[a-f0-9-]{36}\/[a-f0-9]{64}$/;

function readMutedSenders(key: string | undefined): ReadonlySet<string> {
  try {
    const value: unknown = key ? JSON.parse(localStorage.getItem(key) || '[]') : [];
    if (Array.isArray(value)) return new Set(value.filter((id): id is string => typeof id === 'string'));
  } catch { /* Use an empty list if the saved preference is unavailable. */ }
  return new Set();
}

export function useSoundboard(socket: RefObject<Socket | null>, room: VoiceRoom | null, uid: string | undefined, blocked: boolean) {
  const [volume, setVolume] = useState(() => {
    try { return Math.max(0, Math.min(100, Number(localStorage.getItem('dorham.soundboard.volume') ?? 45) || 0)); }
    catch { return 45; }
  });
  const muteKey = uid && `dorham.soundboard.muted:${serverUrl() || location.origin}:${uid}`;
  const savedSenders = useMemo(() => readMutedSenders(muteKey), [muteKey]);
  const [preference, setPreference] = useState<{ key: string; senders: ReadonlySet<string> }>();
  const mutedSenders = preference?.key === muteKey && preference ? preference.senders : savedSenders;
  const current = useRef({ room, blocked, volume, mutedSenders });
  current.current = { room, blocked, volume, mutedSenders };
  const stop = useRef(() => {});
  const activeSender = useRef<string | undefined>(undefined);
  const epoch = room?.members.find(member => member.user.id === uid)?.epoch;
  useEffect(() => { stop.current(); }, [epoch, blocked, volume === 0]);
  useEffect(() => {
    if (!uid) return;
    const instance = socket.current;
    let pending: AbortController | undefined, player: HTMLAudioElement | undefined;
    stop.current = () => {
      activeSender.current = undefined;
      pending?.abort();
      pending = undefined;
      if (player) { player.pause(); player.removeAttribute('src'); player.load(); player = undefined; }
      if (android) void playback.stopSoundboard().catch(() => {});
    };
    const allowed = (event: SoundEvent) => {
      const state = current.current;
      return !state.blocked && state.volume > 0 && instance?.connected && event.expiresAt > Date.now()
        && (!event.senderId || !state.mutedSenders.has(event.senderId))
        && state.room?.channelId === event.channelId && state.room.members.some(member => member.user.id === uid && member.epoch === event.epoch);
    };
    async function receive(event: SoundEvent) {
      if (!event || !allowed(event) || !assetPath.test(event.url)) return;
      stop.current();
      activeSender.current = event.senderId;
      const controller = new AbortController();
      pending = controller;
      const url = assetUrl(event.url)!;
      try {
        if (android) {
          const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
          if (!response.ok || !allowed(event) || controller.signal.aborted) return;
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length > 65536 || !allowed(event) || controller.signal.aborted) return;
          let raw = '';
          for (let offset = 0; offset < bytes.length; offset += 8192) raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
          await playback.playSoundboard({ wav: btoa(raw), channelId: event.channelId, epoch: event.epoch, volume: current.current.volume / 100 });
        } else {
          const audio = new Audio() as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
          player = audio;
          await audio.setSinkId?.(readAudioChoices(uid!).output || '').catch(() => {});
          if (!allowed(event) || controller.signal.aborted) return;
          audio.volume = current.current.volume / 100;
          audio.src = url;
          audio.onended = () => { if (player === audio) stop.current(); };
          await audio.play();
          if (controller.signal.aborted || !allowed(event)) audio.pause();
        }
      } catch { /* A late, blocked or unavailable clip expires silently. */ }
      finally { if (pending === controller) pending = undefined; }
    }
    instance?.on('soundboard:play', receive);
    instance?.on('disconnect', stop.current);
    return () => {
      instance?.off('soundboard:play', receive);
      instance?.off('disconnect', stop.current);
      stop.current();
    };
  }, [socket, uid]);
  function change(value: number) {
    setVolume(value);
    try { localStorage.setItem('dorham.soundboard.volume', String(value)); } catch { /* Session preference still works. */ }
  }
  function toggleSender(senderId: string) {
    if (!muteKey || senderId === uid) return;
    const senders = new Set(current.current.mutedSenders);
    if (senders.has(senderId)) senders.delete(senderId);
    else senders.add(senderId);
    current.current.mutedSenders = senders;
    if (activeSender.current === senderId && senders.has(senderId)) stop.current();
    setPreference({ key: muteKey, senders });
    try { localStorage.setItem(muteKey, JSON.stringify([...senders])); } catch { /* Session preference still works. */ }
  }
  return { volume, change, mutedSenders, toggleSender };
}

export function showSoundboard(catalog: ReturnType<typeof useFeatures>['catalog'], serverId: string | undefined, moderate: boolean, plus: boolean) {
  return moderate || plus || catalog.some(item => item.kind === 'sound' && item.active && item.usable && (!item.serverId || item.serverId === serverId));
}

export function Soundboard({ socket, channelId, serverId, moderate, canSpeak, volume, change, error }: {
  socket: RefObject<Socket | null>; channelId: string; serverId?: string; moderate: boolean; canSpeak: boolean;
  volume: number; change: (value: number) => void; error: (err: unknown) => void;
}) {
  const { catalog, grants } = useFeatures();
  const [roomEnabled, setRoomEnabled] = useState(true);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const instance = socket.current;
    const update = (value: { channelId: string; enabled: boolean }) => {
      if (value.channelId === channelId) setRoomEnabled(value.enabled);
    };
    instance?.on('soundboard:changed', update);
    void request<{ enabled: boolean }>(`/features/soundboard/${channelId}`, undefined, 'GET', true, { signal: controller.signal }).then(value => setRoomEnabled(value.enabled)).catch(() => {});
    return () => { controller.abort(); instance?.off('soundboard:changed', update); };
  }, [socket, channelId]);
  const clips = catalog.filter(item => item.kind === 'sound' && item.active && item.usable && (!item.serverId || item.serverId === serverId));
  const groups = new Map<string, typeof clips>();
  for (const clip of clips.sort((a, b) => (a.freeSlot ?? 99) - (b.freeSlot ?? 99))) {
    const name = clip.pack || 'Other sounds';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(clip);
  }
  return <div className="soundboard-panel">
    <div className="soundboard-actions">
      {Array.from(groups, ([pack, items]) => <section className="soundboard-pack" key={pack}><strong>{t(pack)}</strong><div className="soundboard-actions">{items.map(clip => <button className="secondary" key={clip.id} disabled={!roomEnabled || !canSpeak || pending} onClick={() => {
        if (!socket.current?.connected) return;
        setPending(true);
        void ack(socket.current, 'soundboard:play', { id: clip.id }).catch(error).finally(() => setPending(false));
      }}>{t(clip.label)}</button>)}</div></section>) }
      {!clips.length && <small>{t('No sounds have been published yet.')}</small>}
    </div>
    <div className="soundboard-actions"><label>{t('Soundboard volume')} <input type="range" min="0" max="100" value={volume} onChange={e => change(Number(e.target.value))}/></label>
      <button className="secondary" onClick={() => change(volume ? 0 : 45)}>{t(volume ? 'Mute soundboard' : 'Unmute soundboard')}</button>
      {moderate && <button className="secondary" onClick={() => void request(`/features/soundboard/${channelId}`, { enabled: !roomEnabled }, 'PUT').catch(error)}>{t(roomEnabled ? 'Disable in this room' : 'Enable in this room')}</button>}
    </div>
    {grants.soundboardPlus !== undefined && <form className="soundboard-actions" onSubmit={e => {
      e.preventDefault();
      const form = e.currentTarget;
      setPending(true);
      setNotice('');
      void request('/features/sounds', new FormData(form)).then(() => { form.reset(); setNotice(t('Sound submitted for administrator approval.')); }).catch(error).finally(() => setPending(false));
    }}><input name="label" aria-label={t('Sound name')} required maxLength={60}/><input name="file" type="file" accept=".wav" required aria-label={t('WAV sound')}/>
      <button className="secondary" disabled={pending}>{t('Submit sound')}</button><small>{t('Mono 16-bit PCM WAV, up to 3 seconds and 64 KiB.')}</small>
    </form>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
