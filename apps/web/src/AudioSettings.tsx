import { updateAudio } from './audio-updates';
import { useEffect, useState } from 'react';
import type { MediaTransport, NoiseRemoval } from '@dorham/media';
import { AudioDeviceSettings } from './AudioDevices';
import { AudioProcessingControls, readAudioProcessingPreferences } from './AudioProcessingControls';
import { MicrophoneGainControl } from './MicrophoneGainControl';
import { VoiceInputSettings } from './VoiceInput';
import { readNoiseRemoval, saveNoiseRemoval } from './noise-removal-preferences';
import { readBoostNoise, saveBoostNoise } from './microphone-preferences';
import { t } from './i18n';
import './audio-settings.css';
export function AudioSettings({ account, transport, error }: { account: string; transport: MediaTransport | null; error: (e: unknown) => void }) {
  const [mode, setMode] = useState(readNoiseRemoval), [busy, setBusy] = useState(false), [, refresh] = useState(0);
  useEffect(() => { const timer = setInterval(() => refresh(n => n + 1), 1000); return () => clearInterval(timer); }, []);
  const native = transport && !transport.getCapabilities().microphoneGain;
  const state = transport?.getNoiseRemoval?.();
  async function choose(next: NoiseRemoval) {
    setBusy(true);
    try {
      await updateAudio(transport, async () => {
      const processing = { ...readAudioProcessingPreferences(), noiseSuppression: next !== 'off' };
      await transport?.setAudioProcessing?.(processing); await transport?.setNoiseRemoval?.(next);
      saveNoiseRemoval(next); setMode(next);
      saveBoostNoise({ ...readBoostNoise(), enabled: next !== 'off' });
      await transport?.setBoostNoise?.(readBoostNoise());
      try { localStorage.setItem('dorham.audioProcessing.v1', JSON.stringify(processing)); } catch { /* Session still works. */ }
      });
    } catch (e) { error(e); } finally { setBusy(false); }
  }
  return <fieldset className="audio-settings" disabled={busy} aria-label={t('Audio')}><p className="audio-intro">{t('Sound good. Keep it simple.')}</p>
    <MicrophoneGainControl transport={transport} onError={error}/>
    <label>{t('Noise removal')}<select aria-label={t('Noise removal')} disabled={busy || Boolean(native)} value={mode} onChange={e => { void choose(e.target.value as NoiseRemoval); }}>
      <option value="off">{t('Off')}</option><option value="standard">{t('Standard')}</option><option value="strong">{t('Strong')}</option>
    </select></label>
    <p className="audio-noise-help" role="status">{t(native ? 'Android manages microphone noise and echo processing automatically.' : busy || state?.status === 'loading' ? 'Starting noise removal…' : state?.status === 'fallback' ? 'Strong noise removal is unavailable; Standard is active.' : mode === 'strong' ? 'Stronger background-noise removal on your device. Uses more processing.' : mode === 'off' ? 'Background-noise removal is off. Echo settings stay unchanged.' : 'Everyday background-noise removal with low processing use.')}</p>
    <AudioDeviceSettings account={account} transport={transport} error={error} advancedControls={<><MicrophoneGainControl transport={transport} onError={error} advanced/><VoiceInputSettings/><AudioProcessingControls transport={transport} onError={error} onBusyChange={setBusy}/></>}/>

  </fieldset>;
}
