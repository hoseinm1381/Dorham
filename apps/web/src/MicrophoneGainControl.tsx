import { useEffect, useState } from 'react';
import type { MediaTransport } from '@dorham/media';
import { clampMicrophoneGain } from '../../../packages/media/src/microphone-gain';
import { t, formatNumber } from './i18n';
import { readMicrophoneGain, saveMicrophoneGain, microphoneGainChanged, readMicrophoneBoost, saveMicrophoneBoost } from './microphone-preferences';
export { readMicrophoneGain } from './microphone-preferences';
export function MicrophoneGainControl({ transport, onError, advanced = false, compact = false }: { transport: MediaTransport | null; onError: (error: unknown) => void; advanced?: boolean; compact?: boolean }) {
  const [gain, setGain] = useState(readMicrophoneGain);
  const [boost, setBoost] = useState(readMicrophoneBoost);
  useEffect(() => { const changed = (e: Event) => { setGain((e as CustomEvent<number>).detail); setBoost(readMicrophoneBoost()); }; window.addEventListener(microphoneGainChanged, changed); return () => window.removeEventListener(microphoneGainChanged, changed); }, []);
  if (transport && !transport.getCapabilities().microphoneGain) return null;
  function update(percent: number) {
    const value = clampMicrophoneGain(percent / 100); setGain(value);
    saveMicrophoneGain(value);
    void transport?.setMicrophoneGain?.(value).catch(onError);
  }
  if (advanced) return <section className="microphone-boost"><label className="check-row"><input type="checkbox" checked={boost} onChange={e => { const enabled = e.target.checked; setBoost(enabled); saveMicrophoneBoost(enabled); update(Math.min(enabled ? Infinity : 250, gain * 100)); }}/>{t('Allow microphone boost up to +45 dB')}</label>{boost && <p className="boost-warning">{t('High boost also amplifies noise and can distort your voice. Start low and use the private voice test.')}</p>}<label>{t('Advanced microphone gain')}<input type="range" aria-label={t('Advanced microphone gain')} min={boost ? -60 : 0} max={boost ? 45 : 250} step={boost ? 0.5 : 1} value={boost ? Math.max(-60, 20 * Math.log10(gain)) : Math.round(gain * 100)} onChange={e => update(boost ? Number(e.target.value) === -60 ? 0 : 100 * 10 ** (Number(e.target.value) / 20) : Number(e.target.value))}/><output>{boost && gain > 0 ? `${20 * Math.log10(gain) >= 0 ? '+' : ''}${(20 * Math.log10(gain)).toFixed(1)} dB` : `${formatNumber(Math.round(gain * 100))}%`}</output></label></section>;
  if (compact) return <div className="member-local-audio" role="group" aria-label={t('My microphone')}><label><span>{t('Microphone volume')}<output>{formatNumber(Math.round(gain * 100))}%</output></span><input type="range" aria-label={t('Microphone volume')} min={0} max={200} step={1} value={Math.min(200, Math.round(gain * 100))} onChange={e => update(Number(e.target.value))}/></label><small>{t('More controls are in Settings → Audio → Advanced audio.')}</small>{gain > 2 && <small>{t('Higher gain is set in Advanced audio.')}</small>}</div>;
  return <section className="microphone-gain"><label>{t('Microphone volume')}<input type="range" aria-label={t('Microphone volume')} min={0} max={200} step={1} value={Math.min(200, Math.round(gain * 100))} onChange={e => update(Number(e.target.value))}/><output>{formatNumber(Math.round(gain * 100))}%</output></label>
    <div className="audio-volume-note"><small>{t('100% is your normal microphone level.')}</small><button type="button" className="secondary" onClick={() => update(100)}>{t('Reset microphone gain')}</button></div>
    {gain > 2 && <p className="audio-gain-hint">{t('Higher gain is set in Advanced audio.')}</p>}
  </section>;
}
