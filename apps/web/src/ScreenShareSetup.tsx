import { Capacitor } from '@capacitor/core';
import { useState } from 'react';
import type { Share } from '@dorham/contracts';
import type { ScreenPolicy } from '../../../packages/media/src';
import { screenBandwidths, screenSettings, type ScreenQuality } from '../../../packages/media/src/screen-quality';
import { effectiveScreenPreferences, screenSummary, type ScreenPreferences } from './ScreenShareSettings';
import { useFeatures } from './Features';
import { t } from './i18n';
export const screenPresets = [
  { name: 'Save data', quality: '480p15', bandwidth: 300000, description: 'For slower connections and lower data use.' },
  { name: 'Balanced', quality: '720p15', bandwidth: 750000, description: 'Clear text and everyday screen sharing.' },
  { name: 'High quality', quality: '720p30', bandwidth: 1500000, description: 'Smoother motion with more bandwidth.' }
] as const;
export function ScreenShareSetup({ value, policy, share, soundSupported, busy, submit }: { value: ScreenPreferences; policy?: ScreenPolicy; share?: Share; soundSupported: boolean; busy: boolean; submit: (next: ScreenPreferences, sound: boolean) => Promise<void> }) {
  const { screen, grants } = useFeatures();
  const canUseHD = screen !== 'hidden' && grants.screen1080 !== undefined;
  const android = Capacitor.getPlatform() === 'android';
  const initial = effectiveScreenPreferences(value.quality === '1080p15' && !canUseHD ? { ...value, quality: '720p15' } : value, share), cap = policy?.maxBitrate ?? 450000, maxFps = Math.min(policy?.maxFrameRate ?? 30, share?.maxFrameRate ?? 30);
  const [next, setNext] = useState(initial), [sound, setSound] = useState(share?.includeAudio || false), [advanced, setAdvanced] = useState(false);
  const selection = next.quality === '1080p15' && !canUseHD ? { ...next, quality: '720p15' as const } : next;
  const height = selection.quality.startsWith('480') ? '480' : selection.quality === '1080p15' ? '1080' : '720', fps = selection.quality.endsWith('30') ? '30' : '15';
  return <form className="screen-share-setup" onSubmit={e => { e.preventDefault(); void submit(selection, sound); }}>
    <p>{t(share ? 'Adjust your current share without choosing a new screen.' : android ? 'Android 13 shares your entire phone screen, including other apps and notifications. Newer Android versions may offer a single-app choice. Use Stop sharing when finished.' : 'Choose how to share, then pick a screen or window.')}</p>
    <div className="screen-presets">{screenPresets.map(preset => {
      const bounded = { quality: (maxFps < 30 ? preset.quality.replace('30', '15') : preset.quality) as ScreenQuality, bandwidth: Math.min(cap, preset.bandwidth) };
      return <button type="button" key={preset.name} disabled={busy} aria-pressed={!advanced && next.quality === bounded.quality && next.bandwidth === bounded.bandwidth} onClick={() => { setAdvanced(false); setNext(bounded); }}><strong>{t(preset.name)}</strong><span>{t(preset.description)}</span><small>{screenSummary(bounded, policy, share)}</small></button>;
    })}{screen !== 'hidden' && <button type="button" disabled={busy || !canUseHD} aria-pressed={selection.quality === '1080p15'} onClick={() => { setAdvanced(false); setNext({ quality: '1080p15', bandwidth: Math.min(cap, 1500000) }); }}><strong>1080p</strong><span>{t(canUseHD ? 'Higher resolution · 15fps' : 'Locked')}</span></button>}</div>
    <button type="button" className="secondary" aria-expanded={advanced} disabled={busy} onClick={() => setAdvanced(!advanced)}>{t('Advanced')}</button>
    {advanced && <fieldset disabled={busy} className="screen-advanced"><legend>{t('Advanced screen settings')}</legend><label>{t('Resolution')}<select aria-label={t('Screen resolution')} value={height} onChange={e => setNext({ ...next, quality: `${e.target.value}p${e.target.value === '1080' ? '15' : fps}` as ScreenQuality })}><option value="480">480p</option><option value="720">720p</option>{screen !== 'hidden' && <option value="1080" disabled={!canUseHD}>1080p{canUseHD ? '' : ' · ' + t('Locked')}</option>}</select></label><label>{t('FPS')}<select aria-label={t('Screen FPS')} value={fps} onChange={e => setNext({ ...next, quality: `${height}p${e.target.value}` as ScreenQuality })}><option value="15">15</option><option value="30" disabled={maxFps < 30 || height === '1080'}>30</option></select></label><label>{t('Bitrate')}<select aria-label={t('Screen bandwidth')} value={next.bandwidth} onChange={e => setNext({ ...next, bandwidth: Number(e.target.value) })}>{screenBandwidths.map(n => <option key={n} value={n} disabled={n > cap}>{n / 1000} {t('kbps')}</option>)}</select></label></fieldset>}
    {!share && <label className="check-row"><input type="checkbox" checked={sound} disabled={busy || !soundSupported} onChange={e => setSound(e.target.checked)}/>{t('Share sound')}</label>}
    {!share && sound && soundSupported && <p>{t(android ? 'Shares supported game and media sound. Some apps block audio capture. Dorham call audio is excluded.' : window.desktop?.startCaptureAudio ? 'Choose application sound or computer sound in the next picker. Application sound shares only the selected program. Computer sound excludes Dorham call audio.' : 'Enable audio in Chrome’s picker too. Window requests the selected application’s sound; Chrome Tab shares just that tab. Entire Screen shares computer sound. Window audio depends on Chrome and Windows support.')}</p>}
    {!soundSupported && <p>{t('Shared sound is unavailable on this capture path.')}</p>}
    <p role="status">{screenSummary(selection, policy, selection.quality === '1080p15' ? { ...share, maxHeight: 1080, maxFrameRate: 15 } : share)} · {t('Maximum for video and shared sound. Actual use adapts to your connection.')}</p>
    {maxFps < 30 && <p>{t('30fps is unavailable on this sharing slot.')}</p>}
    {screenSettings(next.quality, policy, share, next.bandwidth).bitrate < 300000 && <p>{t('Shared sound uses part of the selected bandwidth.')}</p>}
    <button className="primary" disabled={busy}>{t(busy ? 'Applying…' : share ? 'Apply sharing settings' : android ? 'Share phone screen' : 'Choose screen')}</button>
  </form>;
}
