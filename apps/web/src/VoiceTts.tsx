import { Capacitor, registerPlugin } from '@capacitor/core';
import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import type { VoiceRoom } from '@dorham/contracts';
import type { VoiceTts, VoiceTtsProgress } from '../../../packages/contracts/src/tts';
import { acceptTtsProgress, clearTtsProgress } from './TtsProgress';
import { speechAudio } from './api';
import { readAudioChoices } from './AudioDevices';
import { currentLanguage, t } from './i18n';
import loadingEnglish from '../../../assets/tts-loading/tts-loading-en.wav?url';
import loadingPersian from '../../../assets/tts-loading/tts-loading-fa.wav?url';
declare const __APP_VERSION__: string;
const nativeSpeech = registerPlugin<any>('DorhamMedia');
const androidSpeech = Capacitor.getPlatform() === 'android';
type Playback = VoiceTts & { loadingLanguage?: 'en' | 'fa' };
export function useVoiceTts(socket: React.RefObject<Socket | null>, room: VoiceRoom | null, blocked: boolean, enabled: boolean, userId: string | undefined, notice: (text: string) => void) {
  const current = useRef({ room, blocked, enabled, notice }); current.current = { room, blocked, enabled, notice };
  const stop = useRef<() => void>(() => {});
  useEffect(() => { if (!room || blocked || !enabled) stop.current(); }, [room?.channelId, blocked, enabled]);
  useEffect(() => {
    if (!userId) return;
    let context: AudioContext | undefined, source: AudioBufferSourceNode | undefined, processing = false, disposed = false, generation = 0;
    const queue: Playback[] = [], seen = new Set<string>();
    const allowed = (event: VoiceTts) => !disposed && current.current.enabled && !current.current.blocked && current.current.room?.channelId === event.channelId && event.expiresAt > Date.now();
    stop.current = () => { if (androidSpeech) void nativeSpeech.stopSpeech().catch(() => {}); generation++; queue.length = 0; source?.stop(); source = undefined; clearTtsProgress(); };
    async function pump() {
      if (processing || !queue.length || (!androidSpeech && context?.state !== 'running')) return;
      processing = true; const event = queue.shift()!, epoch = generation;
      try {
        if (!allowed(event)) return;
        let audio: ArrayBuffer;
        if (event.loadingLanguage) {
          const asset = event.loadingLanguage === 'fa' ? loadingPersian : loadingEnglish;
          const response = await fetch(`${asset}?v=${__APP_VERSION__}`, { signal: AbortSignal.timeout(10000) });
          if (!response.ok) throw Error('Loading announcement is unavailable.');
          audio = await response.arrayBuffer();
        } else audio = await speechAudio(event.id);
        if (!allowed(event) || epoch !== generation) return;
        if (androidSpeech) {
          const bytes = new Uint8Array(audio); let binary = ''; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
          if (!allowed(event) || epoch !== generation) return;
          await nativeSpeech.playSpeech({ wav: btoa(binary), channelId: event.channelId, epoch: current.current.room?.members.find(member => member.user.id === userId)?.epoch, volume: Math.min(1, (readAudioChoices(userId!).levels[event.userId] ?? 100) / 100) }); return;
        }
        const buffer = await context!.decodeAudioData(audio);
        if (!allowed(event) || epoch !== generation) return;
        const gain = context!.createGain(), choices = readAudioChoices(userId!);
        const routed = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
        if (routed.setSinkId) await routed.setSinkId(choices.output || '').catch(() => {});
        if (!allowed(event) || epoch !== generation) { gain.disconnect(); return; }
        gain.gain.value = Math.min(2, (choices.levels[event.userId] ?? 100) / 100);
        const playing = context!.createBufferSource(); source = playing; playing.buffer = buffer; playing.connect(gain).connect(context!.destination);
        await new Promise<void>(resolve => { playing.onended = () => { playing.disconnect(); gain.disconnect(); resolve(); }; playing.start(); });
        if (source === playing) source = undefined;
      } catch { /* Expired or no longer authorized audio is discarded. */ }
      finally { processing = false; if (!disposed) void pump(); }
    }
    const unlock = () => {
      if (androidSpeech) { void pump(); return; }
      try { context ||= new AudioContext(); if (context.state === 'suspended') void context.resume().then(pump).catch(() => {}); else void pump(); } catch { /* no playback device */ }
    };
    const enqueue = (event: VoiceTts, loading = false) => {
      const key = `${loading ? 'loading' : 'speech'}:${event?.id}`;
      if (!event || !allowed(event) || seen.has(key)) return;
      if (seen.size > 128) seen.clear(); seen.add(key);
      if (queue.length < 12) queue.push(loading ? { ...event, loadingLanguage: currentLanguage() === 'fa-IR' ? 'fa' : 'en' } : event);
      if (loading) current.current.notice(t('TTS is loading…'));
      unlock();
      if (!androidSpeech && context?.state !== 'running') current.current.notice('Click anywhere to enable voice TTS playback.');
    };
    const receive = (event: VoiceTts) => { if (event) clearTtsProgress(event.messageId || event.id); enqueue(event); }, loading = (event: VoiceTts) => enqueue(event, true);
    const progress = (event: VoiceTtsProgress) => { if (event && allowed(event)) acceptTtsProgress(event); };
    const notification = (event: { text: string }) => current.current.notice(t(event.text));
    const instance = socket.current;
    instance?.on('voice:tts', receive); instance?.on('voice:tts-loading', loading); instance?.on('voice:tts-notice', notification); instance?.on('voice:tts-progress', progress);
    window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock);
    return () => { disposed = true; stop.current(); instance?.off('voice:tts', receive); instance?.off('voice:tts-loading', loading); instance?.off('voice:tts-notice', notification); instance?.off('voice:tts-progress', progress); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); void context?.close(); };
  }, [userId]);
}
