import { useState } from 'react';
import type { Share } from '@dorham/contracts';
import type { ScreenPolicy } from '../../../packages/media/src';
import { screenBandwidths, screenSettings, type ScreenQuality } from '../../../packages/media/src/screen-quality';
import { effectiveScreenPreferences, screenSummary, type ScreenPreferences } from './ScreenShareSettings';
import { t } from './i18n';
export const screenPresets = [
  { name: 'Save data', quality: '480p15', bandwidth: 300000, description: 'For slower connections and lower data use.' },
  { name: 'Balanced', quality: '720p15', bandwidth: 750000, description: 'Clear text and everyday screen sharing.' },
  { name: 'High quality', quality: '720p30', bandwidth: 1500000, description: 'Smoother motion with more bandwidth.' }
] as const;
export function ScreenShareSetup({ value, policy, share, soundSupported, busy, submit }: { value: ScreenPreferences; policy?: ScreenPolicy; share?: Share; soundSupported: boolean; busy: boolean; submit: (next: ScreenPreferences, sound: boolean) => Promise<void> }) {
  const initial = effectiveScreenPreferences(value, share), cap = policy?.maxBitrate ?? 450000, maxFps = Math.min(policy?.maxFrameRate ?? 30, share?.maxFrameRate ?? 30);
  const [next, setNext] = useState(initial), [sound, setSound] = useState(share?.includeAudio || false), [advanced, setAdvanced] = useState(false);
  const height = next.quality.startsWith('480') ? '480' : '720', fps = next.quality.endsWith('30') ? '30' : '15';
  return <form className="screen-share-setup" onSubmit={e => { e.preventDefault(); void submit(next, sound); }}>
    <p>{t(share ? 'Adjust your current share without choosing a new screen.' : 'Choose how to share, then pick a screen or window.')}</p>
    <div className="screen-presets">{screenPresets.map(preset => {
      const bounded = { quality: (maxFps < 30 ? preset.quality.replace('30', '15') : preset.quality) as ScreenQuality, bandwidth: Math.min(cap, preset.bandwidth) };
      return <button type="button" key={preset.name} disabled={busy} aria-pressed={!advanced && next.quality === bounded.quality && next.bandwidth === bounded.bandwidth} onClick={() => { setAdvanced(false); setNext(bounded); }}><strong>{t(preset.name)}</strong><span>{t(preset.description)}</span><small>{screenSummary(bounded, policy, share)}</small></button>;
    })}</div>
    <button type="button" className="secondary" aria-expanded={advanced} disabled={busy} onClick={() => setAdvanced(!advanced)}>{t('Advanced')}</button>
    {advanced && <fieldset disabled={busy} className="screen-advanced"><legend>{t('Advanced screen settings')}</legend><label>{t('Resolution')}<select aria-label={t('Screen resolution')} value={height} onChange={e => setNext({ ...next, quality: `${e.target.value}p${fps}` as ScreenQuality })}><option value="480">480p</option><option value="720">720p</option></select></label><label>{t('FPS')}<select aria-label={t('Screen FPS')} value={fps} onChange={e => setNext({ ...next, quality: `${height}p${e.target.value}` as ScreenQuality })}><option value="15">15</option><option value="30" disabled={maxFps < 30}>30</option></select></label><label>{t('Bitrate')}<select aria-label={t('Screen bandwidth')} value={next.bandwidth} onChange={e => setNext({ ...next, bandwidth: Number(e.target.value) })}>{screenBandwidths.map(n => <option key={n} value={n} disabled={n > cap}>{n / 1000} {t('kbps')}</option>)}</select></label></fieldset>}
    {!share && <label className="check-row"><input type="checkbox" checked={sound} disabled={busy || !soundSupported} onChange={e => setSound(e.target.checked)}/>{t('Share sound')}</label>}
    {!soundSupported && <p>{t('Shared sound is unavailable on this capture path.')}</p>}
    <p role="status">{screenSummary(next, policy, share)} · {t('Maximum for video and shared sound. Actual use adapts to your connection.')}</p>
    {maxFps < 30 && <p>{t('30fps is unavailable on this sharing slot.')}</p>}
    {screenSettings(next.quality, policy, share, next.bandwidth).bitrate < 300000 && <p>{t('Shared sound uses part of the selected bandwidth.')}</p>}
    <button className="primary" disabled={busy}>{t(busy ? 'Applying…' : share ? 'Apply sharing settings' : 'Choose screen')}</button>
  </form>;
}
