import { useEffect, useRef, useState, type RefObject } from 'react';
import type { MediaTransport } from '@dorham/media';
import { readAudioProcessingPreferences } from './AudioProcessingControls';
import { serverUrl } from './api';
import { t } from './i18n';
function storageKey(account: string) { return `dorham-audio:${serverUrl() || location.origin}:${account}`; }
export function readAudioChoices(account: string): { input: string; output: string; levels: Record<string, number> } {
  try { const value = JSON.parse(localStorage.getItem(storageKey(account)) || '{}'); return { input: typeof value.input === 'string' ? value.input : '', output: typeof value.output === 'string' ? value.output : '', levels: Object.fromEntries(Object.entries(value.levels || {}).filter(([, v]) => Number.isFinite(v) && Number(v) >= 0 && Number(v) <= 200).slice(-100)) as Record<string, number> }; }
  catch { return { input: '', output: '', levels: {} }; }
}
export function saveVoiceLevel(account: string, user: string, volume: number) { const value = readAudioChoices(account); value.levels[user] = volume; try { localStorage.setItem(storageKey(account), JSON.stringify(value)); } catch { /* session fallback */ } }
export function useAudioRouting(transport: RefObject<MediaTransport | null>, active: boolean, account: string | undefined, error: (e: unknown) => void) {
  const onError = useRef(error); onError.current = error;
  useEffect(() => {
    if (!active || !account || !navigator.mediaDevices) return;
    const media = transport.current; let stopped = false, serial = Promise.resolve(), appliedInput: string | undefined, appliedOutput: string | undefined;
    const refresh = () => { serial = serial.then(async () => {
      const devices = await navigator.mediaDevices.enumerateDevices(); if (stopped || transport.current !== media) return;
      const wanted = readAudioChoices(account), input = devices.some(d => d.kind === 'audioinput' && d.deviceId === wanted.input) ? wanted.input : '';
      const output = devices.some(d => d.kind === 'audiooutput' && d.deviceId === wanted.output) ? wanted.output : '';
      if (input !== appliedInput && (input || appliedInput !== undefined)) { await media?.setDevice(input); if (stopped) return; }
      appliedInput = input;
      if (output !== appliedOutput && media?.getCapabilities().outputSelection && media.setOutputDevice) { await media.setOutputDevice(output); if (stopped) return; }
      appliedOutput = output;
    }).catch(e => { if (!stopped) onError.current(e); }); };
    refresh(); navigator.mediaDevices.addEventListener('devicechange', refresh); window.addEventListener('dorham-audio-devices', refresh);
    return () => { stopped = true; navigator.mediaDevices.removeEventListener('devicechange', refresh); window.removeEventListener('dorham-audio-devices', refresh); };
  }, [active, account]);
}
export function AudioDeviceSettings({ account, transport, error }: { account: string; transport: MediaTransport | null; error: (e: unknown) => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]), [choices, setChoices] = useState(() => readAudioChoices(account));
  const [testing, setTesting] = useState(false), [level, setLevel] = useState(0), [notice, setNotice] = useState('');
  const cleanup = useRef<() => void>(() => {}), generation = useRef(0);
  useEffect(() => { const refresh = () => { void navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(error); }; refresh(); navigator.mediaDevices?.addEventListener('devicechange', refresh); return () => { generation.current++; cleanup.current(); navigator.mediaDevices?.removeEventListener('devicechange', refresh); }; }, []);
  function choose(kind: 'input' | 'output', value: string) { const next = { ...readAudioChoices(account), [kind]: value }; setChoices(next); try { localStorage.setItem(storageKey(account), JSON.stringify(next)); } catch { /* memory UI still reflects choice */ } window.dispatchEvent(new Event('dorham-audio-devices')); }
  async function microphoneTest() {
    if (testing) { generation.current++; cleanup.current(); setTesting(false); setLevel(0); return; }
    const epoch = ++generation.current; setTesting(true); let stream: MediaStream | null = null, owned = false, context: AudioContext | undefined;
    try {
      stream = transport?.getLocalAudioStream?.() || null;
      if (!stream) { stream = await navigator.mediaDevices.getUserMedia({ audio: { ...readAudioProcessingPreferences(), ...(choices.input ? { deviceId: { exact: choices.input } } : {}) } }); owned = true; }
      if (generation.current !== epoch) { if (owned) stream.getTracks().forEach(track => track.stop()); return; }
      context = new AudioContext(); await context.resume(); if (generation.current !== epoch) { if (owned) stream.getTracks().forEach(track => track.stop()); void context.close(); return; } const analyser = context.createAnalyser(); analyser.fftSize = 256;
      const source = context.createMediaStreamSource(stream); source.connect(analyser); const buffer = new Float32Array(256);
      const timer = setInterval(() => { if (document.hidden) return; analyser.getFloatTimeDomainData(buffer); const rms = Math.sqrt(buffer.reduce((sum, x) => sum + x * x, 0) / buffer.length); setLevel(Math.min(1, rms * 8)); }, 100);
      cleanup.current = () => { clearInterval(timer); source.disconnect(); analyser.disconnect(); if (owned) stream?.getTracks().forEach(track => track.stop()); void context?.close(); };
    } catch (e) { if (owned) stream?.getTracks().forEach(track => track.stop()); void context?.close(); setTesting(false); error(e); }
  }
  async function speakerTest() {
    const context = new AudioContext();
    try { if (choices.output && typeof (context as any).setSinkId === 'function') await (context as any).setSinkId(choices.output); await context.resume(); const oscillator = context.createOscillator(), gain = context.createGain(); oscillator.frequency.value = 520; gain.gain.value = 0.04; oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.3); oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); void context.close(); }; setNotice('Test sound played.'); }
    catch (e) { void context.close(); error(e); }
  }
  const outputSupported = transport?.getCapabilities().outputSelection ?? (typeof (AudioContext.prototype as any).setSinkId === 'function');
  return <section className="audio-device-settings"><h3>{t('Audio devices')}</h3>
    <label>{t('Microphone')}<select aria-label={t('Microphone')} value={choices.input} onChange={e => choose('input', e.target.value)}><option value="">{t('System default')}</option>{devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default').map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || t('Microphone')}</option>)}</select></label>
    <label>{t('Speakers or headset')}<select aria-label={t('Speakers or headset')} disabled={!outputSupported} value={choices.output} onChange={e => choose('output', e.target.value)}><option value="">{t('System default')}</option>{devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default').map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || t('Speaker')}</option>)}</select></label>
    {!outputSupported && <p>{t('Speaker selection is not supported in this browser.')}</p>}
    <div className="audio-test-actions"><button type="button" className="secondary" onClick={() => { void microphoneTest(); }}>{t(testing ? 'Stop microphone test' : 'Test microphone')}</button><button type="button" className="secondary" onClick={() => { void speakerTest(); }}>{t('Test speakers')}</button></div>
    {testing && <meter aria-label={t('Microphone level')} min={0} max={1} value={level}/>}<p role="status">{t(notice)}</p>
  </section>;
}
