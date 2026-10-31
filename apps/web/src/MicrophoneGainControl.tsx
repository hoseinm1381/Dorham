import { useEffect, useState } from 'react';
import type { MediaTransport } from '@dorham/media';
import { clampMicrophoneGain } from '../../../packages/media/src/microphone-gain';
import { t, formatNumber } from './i18n';
import { readMicrophoneGain, saveMicrophoneGain, microphoneGainChanged, readMicrophoneBoost, saveMicrophoneBoost } from './microphone-preferences';
export { readMicrophoneGain } from './microphone-preferences';
export function MicrophoneGainControl({ transport, onError }: { transport: MediaTransport | null; onError: (error: unknown) => void }) {
  const [gain, setGain] = useState(readMicrophoneGain);
  const [boost, setBoost] = useState(readMicrophoneBoost);
  useEffect(() => { const changed = (e: Event) => { setGain((e as CustomEvent<number>).detail); setBoost(readMicrophoneBoost()); }; window.addEventListener(microphoneGainChanged, changed); return () => window.removeEventListener(microphoneGainChanged, changed); }, []);
  if (transport && !transport.getCapabilities().microphoneGain) return null;
  function update(percent: number) {
    const value = clampMicrophoneGain(percent / 100); setGain(value);
    saveMicrophoneGain(value);
    void transport?.setMicrophoneGain?.(value).catch(onError);
  }
  return <section className="microphone-gain"><label>{t('My microphone gain')}<input type="range" aria-label={t('My microphone gain')} min={boost ? -6 : 50} max={boost ? 30 : 250} step={boost ? 0.5 : 5} value={boost ? Math.max(-6, 20 * Math.log10(gain)) : Math.round(gain * 100)} onChange={e => update(boost ? 100 * 10 ** (Number(e.target.value) / 20) : Number(e.target.value))}/><output>{boost ? `${20 * Math.log10(gain) >= 0 ? '+' : ''}${(20 * Math.log10(gain)).toFixed(1)} dB` : `${formatNumber(Math.round(gain * 100))}%`}</output></label>
    <p>{t('Changes the voice you send to everyone. 100% is the original level. Higher gain can distort a loud microphone.')}</p>
    <p>{t('Signal gain: {db} dB. 250% is about +8 dB, not 2.5 times the perceived loudness.', { db: `${gain >= 1 ? '+' : ''}${(20 * Math.log10(gain)).toFixed(1)}` })}</p>
    <label className="check-row"><input type="checkbox" aria-describedby="microphone-boost-warning" checked={boost} onChange={e => { const enabled = e.target.checked; setBoost(enabled); saveMicrophoneBoost(enabled); update(Math.min(enabled ? Infinity : 250, gain * 100)); }}/>{t('Allow microphone boost up to +30 dB')}</label>
    <p id="microphone-boost-warning" className="boost-warning">{t('Warning: +30 dB amplifies the signal about 32 times. It can make noise very loud and cause severe distortion. Start low, use the private voice test and ask your listener before increasing it.')}</p>
    <button type="button" className="secondary" onClick={() => update(100)}>{t('Reset microphone gain')}</button>
  </section>;
}
