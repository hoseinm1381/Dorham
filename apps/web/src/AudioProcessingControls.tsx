import { updateAudio } from './audio-updates';
import { t as tr } from './i18n';
import { useState } from 'react';
import { defaultAudioProcessing, browserAudioProcessing, type AudioProcessing } from '../../../packages/media/src/audio-processing';
import type { MediaTransport } from '@dorham/media';
import './audio-processing.css';
import { readNoiseRemoval } from './noise-removal-preferences';
import { readVoiceClarity, saveVoiceClarity } from './voice-clarity-preferences';

const preferenceKey = 'dorham.audioProcessing.v1';
export function readAudioProcessingPreferences(): AudioProcessing {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
    return { echoCancellation: typeof saved?.echoCancellation === 'boolean' ? saved.echoCancellation : true, noiseSuppression: readNoiseRemoval() !== 'off', autoGainControl: typeof saved?.autoGainControl === 'boolean' ? saved.autoGainControl : true };
  } catch { return { ...defaultAudioProcessing }; }
}

export function AudioProcessingControls({ transport, onError, onBusyChange }: { transport: MediaTransport | null; onError: (error: unknown) => void; onBusyChange?: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const working = (value: boolean) => { setBusy(value); onBusyChange?.(value); };
  const [clarity, setClarity] = useState(readVoiceClarity);
  const [pending, setPending] = useState<AudioProcessing | null>(null);
  const [, refresh] = useState(0);
  if (transport && (!transport.getAudioProcessing || !transport.setAudioProcessing)) return <p>{tr("Android manages microphone noise and echo processing automatically.")}</p>;
  const state = transport?.getAudioProcessing?.() ?? browserAudioProcessing(readAudioProcessingPreferences());
  async function update(key: keyof AudioProcessing, value: boolean) {
    working(true);
    try {
      await updateAudio(transport, async () => {
      const next = { ...(transport?.getAudioProcessing?.().requested ?? readAudioProcessingPreferences()), [key]: value }; setPending(next);
      await transport?.setAudioProcessing?.(next);
      try { localStorage.setItem(preferenceKey, JSON.stringify(next)); } catch { /* Processing still applies when persistent storage is unavailable. */ }
      });
    } catch (error) { onError(error); } finally { setPending(null); working(false); refresh(value => value + 1); }
  }
  return <fieldset className="audio-processing" disabled={busy} aria-busy={busy}><legend>{tr("Microphone processing")}</legend>
    {([['echoCancellation', tr("Echo cancellation")], ['autoGainControl', tr("Automatic microphone level")]] as const).map(([key, label]) => <div key={key}>
      <label><input type="checkbox" checked={pending?.[key] ?? state.requested[key]} disabled={!state.supported[key]} onChange={e => { void update(key, e.target.checked); }}/>{tr(label)}</label>
      <small role="status">{busy ? tr("Applying…") : !state.supported[key] ? tr("Not supported by this browser") : !state.active ? tr("Applies when you join voice") : state.effective[key] === undefined ? tr("Browser does not report its applied setting") : tr('Microphone: {state}', { state: tr(state.effective[key] ? 'On' : 'Off') })}</small>
    </div>)}
    <div><label><input type="checkbox" aria-label={tr('Voice clarity')} checked={clarity} onChange={e => { const enabled = e.target.checked; working(true); void Promise.resolve(transport?.setVoiceClarity?.(enabled)).then(() => { setClarity(enabled); saveVoiceClarity(enabled); }).catch(onError).finally(() => working(false)); }}/>{tr('Voice clarity')}</label><small>{tr('Reduces low rumble and gently clarifies speech on this device. Turn off to save processing on a weak PC. No extra server processing.')}</small></div>
    {state.pending && <p role="status">{tr("Saved. Leave and rejoin voice to apply these changes.")}</p>}

  </fieldset>;
}
