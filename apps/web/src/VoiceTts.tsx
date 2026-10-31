import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import type { VoiceRoom } from '@dorham/contracts';
import type { VoiceTts } from '../../../packages/contracts/src/tts';
import { speechAudio } from './api';
import { readAudioChoices } from './AudioDevices';
export function useVoiceTts(socket: React.RefObject<Socket | null>, room: VoiceRoom | null, blocked: boolean, enabled: boolean, userId: string | undefined, notice: (text: string) => void) {
  const current = useRef({ room, blocked, enabled, notice }); current.current = { room, blocked, enabled, notice };
  const stop = useRef<() => void>(() => {});
  useEffect(() => { if (!room || blocked || !enabled) stop.current(); }, [room?.channelId, blocked, enabled]);
  useEffect(() => {
    if (!userId) return;
    let context: AudioContext | undefined, source: AudioBufferSourceNode | undefined, processing = false, disposed = false, generation = 0;
    const queue: VoiceTts[] = [], seen = new Set<string>();
    const allowed = (event: VoiceTts) => !disposed && current.current.enabled && !current.current.blocked && current.current.room?.channelId === event.channelId && event.expiresAt > Date.now();
    stop.current = () => { generation++; queue.length = 0; source?.stop(); source = undefined; };
    async function pump() {
      if (processing || !queue.length || context?.state !== 'running') return;
      processing = true; const event = queue.shift()!, epoch = generation;
      try {
        if (!allowed(event)) return;
        const audio = await speechAudio(event.id);
        if (!allowed(event) || epoch !== generation) return;
        const buffer = await context.decodeAudioData(audio);
        if (!allowed(event) || epoch !== generation) return;
        const gain = context.createGain(), choices = readAudioChoices(userId!);
        const routed = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
        if (routed.setSinkId) await routed.setSinkId(choices.output || '').catch(() => {});
        if (!allowed(event) || epoch !== generation) { gain.disconnect(); return; }
        gain.gain.value = Math.min(2, (choices.levels[event.userId] ?? 100) / 100);
        const playing = context.createBufferSource(); source = playing; playing.buffer = buffer; playing.connect(gain).connect(context.destination);
        await new Promise<void>(resolve => { playing.onended = () => { playing.disconnect(); gain.disconnect(); resolve(); }; playing.start(); });
        if (source === playing) source = undefined;
      } catch { /* Expired or no longer authorized audio is discarded. */ }
      finally { processing = false; if (!disposed) void pump(); }
    }
    const unlock = () => {
      try { context ||= new AudioContext(); if (context.state === 'suspended') void context.resume().then(pump).catch(() => {}); else void pump(); } catch { /* no playback device */ }
    };
    const receive = (event: VoiceTts) => {
      if (!event || !allowed(event) || seen.has(event.id)) return;
      if (seen.size > 128) seen.clear(); seen.add(event.id);
      if (queue.length < 4) queue.push(event);
      unlock();
      if (context?.state !== 'running') current.current.notice('Click anywhere to enable voice TTS playback.');
    };
    const notification = (event: { text: string }) => current.current.notice(event.text);
    const instance = socket.current;
    instance?.on('voice:tts', receive); instance?.on('voice:tts-notice', notification);
    window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock);
    return () => { disposed = true; stop.current(); instance?.off('voice:tts', receive); instance?.off('voice:tts-notice', notification); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); void context?.close(); };
  }, [userId]);
}
