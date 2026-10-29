import { t as tr } from './i18n';
import { useState } from 'react';
import { defaultAudioProcessing, browserAudioProcessing, type AudioProcessing, type MediaTransport } from '@dorham/media';
import './audio-processing.css';

const preferenceKey = 'dorham.audioProcessing.v1';
export function readAudioProcessingPreferences(): AudioProcessing {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
    return { echoCancellation: typeof saved?.echoCancellation === 'boolean' ? saved.echoCancellation : true, noiseSuppression: typeof saved?.noiseSuppression === 'boolean' ? saved.noiseSuppression : true, autoGainControl: typeof saved?.autoGainControl === 'boolean' ? saved.autoGainControl : true };
  } catch { return { ...defaultAudioProcessing }; }
}

export function AudioProcessingControls({ transport, onError }: { transport: MediaTransport | null; onError: (error: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AudioProcessing | null>(null);
  const [, refresh] = useState(0);
  if (transport && (!transport.getAudioProcessing || !transport.setAudioProcessing)) return <p>{tr("Android manages microphone noise and echo processing automatically.")}</p>;
  const state = transport?.getAudioProcessing?.() ?? browserAudioProcessing(readAudioProcessingPreferences());
  async function update(key: keyof AudioProcessing, value: boolean) {
    setBusy(true);
    const next = { ...state.requested, [key]: value }; setPending(next);
    try {
      await transport?.setAudioProcessing?.(next);
      try { localStorage.setItem(preferenceKey, JSON.stringify(next)); } catch { /* Processing still applies when persistent storage is unavailable. */ }
    } catch (error) { onError(error); } finally { setPending(null); setBusy(false); refresh(value => value + 1); }
  }
  return <fieldset className="audio-processing" disabled={busy} aria-busy={busy}><legend>{tr("Microphone processing")}</legend>
    {([['noiseSuppression', tr("Noise suppression")], ['echoCancellation', tr("Echo cancellation")], ['autoGainControl', tr("Automatic microphone level")]] as const).map(([key, label]) => <div key={key}>
      <label><input type="checkbox" checked={pending?.[key] ?? state.requested[key]} disabled={!state.supported[key]} onChange={e => { void update(key, e.target.checked); }}/>{tr(label)}</label>
      <small role="status">{busy ? tr("Applying…") : !state.supported[key] ? tr("Not supported by this browser") : !state.active ? tr("Applies when you join voice") : state.effective[key] === undefined ? tr("Browser does not report its applied setting") : tr('Microphone: {state}', { state: tr(state.effective[key] ? 'On' : 'Off') })}</small>
    </div>)}
    {state.pending && <p role="status">{tr("Saved. Leave and rejoin voice to apply these changes.")}</p>}
    <p>{tr("Changes apply during your call and are saved for future calls. These settings affect your microphone only.")}</p>
    <p>{tr("Your browser controls noise reduction strength; it offers on/off, not an adjustable strength slider.")}</p>
  </fieldset>;
}
