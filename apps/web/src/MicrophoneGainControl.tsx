import { useEffect, useState } from 'react';
import type { MediaTransport } from '@dorham/media';
import { clampMicrophoneGain } from '../../../packages/media/src/microphone-gain';
import { t, formatNumber } from './i18n';
import { readMicrophoneGain, saveMicrophoneGain, microphoneGainChanged } from './microphone-preferences';
export { readMicrophoneGain } from './microphone-preferences';
export function MicrophoneGainControl({ transport, onError }: { transport: MediaTransport | null; onError: (error: unknown) => void }) {
  const [gain, setGain] = useState(readMicrophoneGain);
  useEffect(() => { const changed = (e: Event) => setGain((e as CustomEvent<number>).detail); window.addEventListener(microphoneGainChanged, changed); return () => window.removeEventListener(microphoneGainChanged, changed); }, []);
  if (transport && !transport.getCapabilities().microphoneGain) return null;
  function update(percent: number) {
    const value = clampMicrophoneGain(percent / 100); setGain(value);
    saveMicrophoneGain(value);
    void transport?.setMicrophoneGain?.(value).catch(onError);
  }
  return <section className="microphone-gain"><label>{t('My microphone gain')}<input type="range" aria-label={t('My microphone gain')} min={50} max={250} step={5} value={Math.round(gain * 100)} onChange={e => update(Number(e.target.value))}/><output>{formatNumber(Math.round(gain * 100))}%</output></label>
    <p>{t('Changes the voice you send to everyone. 100% is the original level. Higher gain can distort a loud microphone.')}</p>
    <p>{t('Signal gain: {db} dB. 250% is about +8 dB, not 2.5 times the perceived loudness.', { db: `${gain >= 1 ? '+' : ''}${(20 * Math.log10(gain)).toFixed(1)}` })}</p>
    <button type="button" className="secondary" onClick={() => update(100)}>{t('Reset microphone gain')}</button>
  </section>;
}
