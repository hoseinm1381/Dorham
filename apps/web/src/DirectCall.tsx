import { useRef, useState } from 'react';
import type { LocalAudioTrack, Room } from 'livekit-client';
import type { Socket } from 'socket.io-client';
import { ack } from '../../../packages/media/src/signaling';
import { readAudioChoices } from './AudioDevices';
import { readVoiceInput } from './VoiceInput';
import { playCue } from './notifications';
import { t } from './i18n';

type Call = { id: string; conversationId: string; phase: 'incoming' | 'outgoing' | 'active' | 'ended'; peerName: string };

export function useDirectCall(error: (value: unknown) => void) {
  const [call, setCall] = useState<Call | null>(null);
  const [ready, setReady] = useState(false), [listenOnly, setListenOnly] = useState(false), [audioBlocked, setAudioBlocked] = useState(false);
  const current = useRef<Call | null>(null), room = useRef<Room | null>(null), microphone = useRef<LocalAudioTrack | null>(null);
  const muted = useRef(false), audioElements = useRef(new Set<HTMLMediaElement>());
  const onError = useRef(error);
  onError.current = error;

  function clear() {
    current.current = null;
    setCall(null);
    setReady(false);
    setListenOnly(false);
    setAudioBlocked(false);
    microphone.current?.stop();
    microphone.current = null;
    const previous = room.current;
    room.current = null;
    void previous?.disconnect().catch(() => {});
    for (const audio of audioElements.current) audio.remove();
    audioElements.current.clear();
  }

  async function finish(socket: Socket, id: string) {
    if (current.current?.id === id) clear();
    if (socket.connected) await ack(socket, 'dm:call', { action: 'end', id });
  }

  async function join(socket: Socket, userId: string, next: Call) {
    const { Room, RoomEvent, Track, createLocalAudioTrack } = await import('livekit-client');
    if (current.current?.id !== next.id) return;
    const credentials = await ack<{ url: string; token: string }>(socket, 'dm:call', { action: 'credentials', id: next.id });
    if (current.current?.id !== next.id) return;
    const choices = readAudioChoices(userId);
    const connection = new Room({ audioOutput: { deviceId: choices.output || 'default' } });
    room.current = connection;
    connection.on(RoomEvent.TrackSubscribed, track => {
      if (room.current !== connection || track.kind !== Track.Kind.Audio) return;
      const audio = track.attach();
      audioElements.current.add(audio);
      document.body.append(audio);
    });
    connection.on(RoomEvent.TrackUnsubscribed, track => {
      for (const audio of track.detach()) { audio.remove(); audioElements.current.delete(audio); }
    });
    connection.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (room.current === connection) setAudioBlocked(!connection.canPlaybackAudio);
    });
    connection.on(RoomEvent.Disconnected, () => {
      if (room.current === connection) void finish(socket, next.id).catch(onError.current);
    });
    await connection.connect(credentials.url, credentials.token);
    if (room.current !== connection) { await connection.disconnect(); return; }
    setReady(true);
    let track: LocalAudioTrack | undefined;
    try {
      track = await createLocalAudioTrack({ deviceId: choices.input || 'default', echoCancellation: true, noiseSuppression: true });
      if (room.current !== connection) { track.stop(); return; }
      microphone.current = track;
      if (muted.current) await track.mute();
      if (room.current === connection) await connection.localParticipant.publishTrack(track, { source: Track.Source.Microphone });
    } catch (e) {
      track?.stop();
      if (room.current === connection) {
        microphone.current = null;
        setListenOnly(true);
        onError.current(e);
      }
    }
  }

  function attach(socket: Socket, userId: string) {
    const state = (next: Call) => {
      if (next.phase === 'ended') {
        if (current.current?.id === next.id) clear();
        return;
      }
      if (next.phase === 'active') {
        if (current.current?.id !== next.id || current.current.phase === 'active') return;
        muted.current = readVoiceInput().mode !== 'open';
        current.current = next;
        setCall(next);
        void join(socket, userId, next).catch(e => {
          if (current.current?.id !== next.id) return;
          void finish(socket, next.id).catch(onError.current);
          onError.current(e);
        });
        return;
      }
      if (current.current) return;
      current.current = next;
      setCall(next);
      if (next.phase === 'incoming') playCue('message');
    };
    socket.on('dm:call-state', state);
    socket.on('disconnect', clear);
    return () => { socket.off('dm:call-state', state); socket.off('disconnect', clear); clear(); };
  }

  return {
    call, ready, listenOnly, audioBlocked, attach,
    isActive: () => current.current?.phase === 'active',
    setMuted: async (value: boolean) => {
      muted.current = value;
      const track = microphone.current;
      if (track) await (value ? track.mute() : track.unmute());
    },
    start: (socket: Socket, conversationId: string) => ack(socket, 'dm:call', { action: 'start', conversationId }),
    accept: (socket: Socket, id: string) => ack(socket, 'dm:call', { action: 'accept', id }),
    finish,
    enableAudio: () => room.current?.startAudio().catch(onError.current),
  };
}

export function DirectCallBanner({ direct, socket, muted, toggle, run }: {
  direct: ReturnType<typeof useDirectCall>; socket: Socket | null; muted: boolean; toggle: () => void;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { call, ready, listenOnly, audioBlocked } = direct;
  if (!call || !socket) return null;
  const text = call.phase === 'incoming' ? 'Incoming call from {name}' : call.phase === 'outgoing' ? 'Calling {name}…' : ready ? 'In a call with {name}' : 'Connecting to {name}…';
  return <div className="invite-voice-landing" role="status">
    <span>{t(text, { name: call.peerName })}</span>
    {call.phase === 'incoming' && <button type="button" className="primary" onClick={() => void run(() => direct.accept(socket, call.id))}>{t('Answer')}</button>}
    {call.phase === 'active' && <button type="button" className="secondary" disabled={listenOnly} onClick={toggle}>{t(muted ? 'Unmute microphone' : 'Mute microphone')}</button>}
    {audioBlocked && <button type="button" className="secondary" onClick={direct.enableAudio}>{t('Enable call audio')}</button>}
    <button type="button" className="danger-button" onClick={() => void run(() => direct.finish(socket, call.id))}>{t(call.phase === 'incoming' ? 'Decline' : call.phase === 'outgoing' ? 'Cancel call' : 'End call')}</button>
  </div>;
}
