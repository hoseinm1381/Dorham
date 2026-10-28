import { useState } from 'react';
import { defaultAudioProcessing, type AudioProcessing, type MediaTransport } from '@dorham/media';
import './audio-processing.css';

const preferenceKey = 'dorham.audioProcessing.v1';
export function readAudioProcessingPreferences(): AudioProcessing {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
    return { echoCancellation: typeof saved?.echoCancellation === 'boolean' ? saved.echoCancellation : true, noiseSuppression: typeof saved?.noiseSuppression === 'boolean' ? saved.noiseSuppression : true };
  } catch { return { ...defaultAudioProcessing }; }
}

export function AudioProcessingControls({ transport, onError }: { transport: MediaTransport | null; onError: (error: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AudioProcessing | null>(null);
  const [, refresh] = useState(0);
  if (!transport?.getAudioProcessing || !transport.setAudioProcessing) return <p>Android manages microphone noise and echo processing automatically.</p>;
  const state = transport.getAudioProcessing();
  async function update(key: keyof AudioProcessing, value: boolean) {
    if (!transport?.getAudioProcessing || !transport.setAudioProcessing) return;
    setBusy(true);
    const next = { ...transport.getAudioProcessing().requested, [key]: value }; setPending(next);
    try {
      await transport.setAudioProcessing(next);
      try { localStorage.setItem(preferenceKey, JSON.stringify(next)); } catch { /* Processing still applies when persistent storage is unavailable. */ }
    } catch (error) { onError(error); } finally { setPending(null); setBusy(false); refresh(value => value + 1); }
  }
  return <fieldset className="audio-processing" disabled={busy} aria-busy={busy}><legend>Microphone processing</legend>
    {([['noiseSuppression', 'Noise suppression'], ['echoCancellation', 'Echo cancellation']] as const).map(([key, label]) => <div key={key}>
      <label><input type="checkbox" checked={pending?.[key] ?? state.requested[key]} disabled={!state.supported[key]} onChange={e => { void update(key, e.target.checked); }}/>{label}</label>
      <small role="status">{busy ? 'Applying…' : !state.supported[key] ? 'Not supported by this browser' : !state.active ? 'Applies when you join voice' : state.effective[key] === undefined ? 'Browser does not report its applied setting' : `Microphone: ${state.effective[key] ? 'on' : 'off'}`}</small>
    </div>)}
    {state.pending && <p role="status">Saved. Leave and rejoin voice to apply these changes.</p>}
    <p>Uses built-in microphone processing. Changes apply when you next join voice. Each person controls their own microphone.</p>
  </fieldset>;
}
