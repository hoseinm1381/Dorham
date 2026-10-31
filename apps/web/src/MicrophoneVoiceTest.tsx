import { useEffect, useRef, useState } from 'react';
import type { MediaTransport } from '@dorham/media';
import type { CheckState, MicrophoneCheck } from './microphone-check';
import { readAudioProcessingPreferences } from './AudioProcessingControls';
import { boostNoiseChanged, readBoostNoise, microphoneGainChanged, readMicrophoneGain } from './microphone-preferences';
import { readVoiceClarity, voiceClarityChanged } from './voice-clarity-preferences';
import { t } from './i18n';
export function MicrophoneVoiceTest({ input, output, transport, error }: { input: string; output: string; transport: MediaTransport | null; error: (e: unknown) => void }) {
  const check = useRef<MicrophoneCheck | null>(null), generation = useRef(0);
  const [state, setState] = useState<CheckState>('idle'), [level, setLevel] = useState(0), [clipped, setClipped] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; const changed = (e: Event) => check.current?.setGain((e as CustomEvent<number>).detail); const noise = () => { const value = readBoostNoise(); check.current?.setNoiseFilter(value.enabled, value.threshold); }; const clarity = (e: Event) => check.current?.setClarity((e as CustomEvent<boolean>).detail); window.addEventListener(boostNoiseChanged, noise); window.addEventListener(voiceClarityChanged, clarity); window.addEventListener(microphoneGainChanged, changed); return () => { alive.current = false; generation.current++; check.current?.destroy(); window.removeEventListener(microphoneGainChanged, changed); window.removeEventListener(boostNoiseChanged, noise); window.removeEventListener(voiceClarityChanged, clarity); }; }, []);
  useEffect(() => { generation.current++; check.current?.destroy(); }, [input, output]);
  async function record() {
    const epoch = ++generation.current; setState('requesting');
    try {
      const { MicrophoneCheck } = await import('./microphone-check'); if (!alive.current || epoch !== generation.current) return;
      check.current?.destroy(); check.current = new MicrophoneCheck(s => { if (alive.current) setState(s); }, (v, c) => { if (alive.current) { setLevel(v); setClipped(c); } }, error, () => transport?.beginAudioTest?.() || Promise.resolve(async () => {}));
      const noise = readBoostNoise(); check.current.setNoiseFilter(noise.enabled, noise.threshold); check.current.setClarity(readVoiceClarity()); check.current.setGain(readMicrophoneGain()); await check.current.record(input, transport?.getAudioProcessing?.().requested || readAudioProcessingPreferences());
    } catch (e) { if (alive.current) { setState('idle'); error(e); } }
  }
  const busy = state === 'requesting' || state === 'recording';
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return <p>{t('Microphone playback test is not supported in this browser.')}</p>;
  return <section className="microphone-voice-test"><h4>{t('Hear your microphone')}</h4><p>{t('Record up to 5 seconds, then play it back. Adjust microphone gain while listening to compare. The recording stays in memory and is erased when you close this panel.')}</p><p>{t('During recording and playback you are muted and deafened in voice chat. Your previous state is restored when the test stops.')}</p>
    <div className="audio-test-actions"><button type="button" className="secondary" onClick={() => { if (state === 'requesting') { generation.current++; check.current?.destroy(); setState('idle'); } else if (state === 'recording') check.current?.finish(); else void record(); }}>{t(state === 'requesting' ? 'Cancel' : state === 'recording' ? 'Stop recording' : 'Record voice test')}</button>
      {(state === 'ready' || state === 'playing') && <button type="button" className="secondary" onClick={() => { if (state === 'playing') check.current?.stopPlayback(); else void check.current?.play(output); }}>{t(state === 'playing' ? 'Stop playback' : 'Play voice test')}</button>}</div>
    {(busy || state === 'playing') && <meter aria-label={t('Voice test level')} min={0} max={1} value={level}/>}<p role="status">{t(state === 'requesting' ? 'Waiting for microphone permission…' : state === 'recording' ? 'Recording locally…' : state === 'ready' ? 'Recording ready. Press Play voice test.' : state === 'playing' ? 'Playing locally with your selected gain.' : 'Test audio is never uploaded.')}</p>
    {clipped && <p role="status">{t('The signal is clipping. Reduce microphone gain or your device input level.')}</p>}
  </section>;
}
