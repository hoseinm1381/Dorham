import { useState } from 'react';
import type { MediaTransport } from '@dorham/media';
import { clampMicrophoneGain } from '../../../packages/media/src/microphone-gain';
import { t, formatNumber } from './i18n';

const key = 'dorham.microphoneGain.v1';
export function readMicrophoneGain() {
  try { const saved = localStorage.getItem(key); return saved === null ? 1 : clampMicrophoneGain(Number(saved)); } catch { return 1; }
}
export function MicrophoneGainControl({ transport, onError }: { transport: MediaTransport | null; onError: (error: unknown) => void }) {
  const [gain, setGain] = useState(readMicrophoneGain);
  if (transport && !transport.getCapabilities().microphoneGain) return null;
  function update(percent: number) {
    const value = clampMicrophoneGain(percent / 100); setGain(value);
    try { localStorage.setItem(key, String(value)); } catch { /* The current call still uses the selected gain. */ }
    void transport?.setMicrophoneGain?.(value).catch(onError);
  }
  return <section className="microphone-gain"><label>{t('My microphone gain')}<input type="range" aria-label={t('My microphone gain')} min={50} max={250} step={5} value={Math.round(gain * 100)} onChange={e => update(Number(e.target.value))}/><output>{formatNumber(Math.round(gain * 100))}%</output></label>
    <p>{t('Changes the voice you send to everyone. 100% is the original level. Higher gain can distort a loud microphone.')}</p>
    <button type="button" className="secondary" onClick={() => update(100)}>{t('Reset microphone gain')}</button>
  </section>;
}
