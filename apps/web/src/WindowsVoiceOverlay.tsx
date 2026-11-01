import { useEffect, useRef, useState } from 'react';
import type { VoiceRoom } from '@dorham/contracts';
import { t } from './i18n';
export type OverlayPreferences = { enabled: boolean; position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' };
export type OverlayState = { channel: string; language: string; members: { name: string; muted: boolean; deafened: boolean; serverMuted: boolean; speaking: boolean }[] } | null;
export function useWindowsVoiceOverlay(room: VoiceRoom | null, name: string, speaking: Record<string, boolean>, language: string) {
  const latest = useRef<OverlayState>(null);
  latest.current = room ? { channel: name, language, members: room.members.map(m => ({ name: m.user.displayName, muted: m.muted, deafened: m.deafened || m.serverDeafened === true, serverMuted: m.serverMuted, speaking: speaking[m.user.id] === true })) } : null;
  useEffect(() => {
    if (!window.desktop?.updateOverlay) return;
    let previous = '';
    const send = () => { const signature = JSON.stringify(latest.current); if (signature !== previous) { previous = signature; window.desktop?.updateOverlay?.(latest.current); } };
    send(); const timer = setInterval(send, 100);
    return () => { clearInterval(timer); window.desktop?.updateOverlay?.(null); };
  }, []);
}
export function WindowsVoiceOverlaySettings({ error }: { error: (error: unknown) => void }) {
  const [prefs, setPrefs] = useState<OverlayPreferences>({ enabled: false, position: 'top-left' }), [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; void window.desktop?.getOverlay?.().then(value => { if (active) { setPrefs(value); setReady(true); } }).catch(error); return () => { active = false; }; }, []);
  if (!window.desktop?.configureOverlay) return null;
  async function save(next: OverlayPreferences) { setBusy(true); try { const value = await window.desktop!.configureOverlay!(next); setPrefs(value); } catch (e) { error(e); } finally { setBusy(false); } }
  return <fieldset disabled={!ready || busy}><legend>{t('Windows voice overlay')}</legend><label className="check-row"><input type="checkbox" checked={prefs.enabled} onChange={e => { void save({ ...prefs, enabled: e.target.checked }); }}/>{t('Show voice overlay in games')}</label><label>{t('Overlay position')}<select aria-label={t('Overlay position')} value={prefs.position} onChange={e => { void save({ ...prefs, position: e.target.value as OverlayPreferences['position'] }); }}>{['top-left', 'top-right', 'bottom-left', 'bottom-right'].map(p => <option value={p} key={p}>{t(({ 'top-left': 'Top left', 'top-right': 'Top right', 'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right' } as Record<string, string>)[p])}</option>)}</select></label><small>{t('Click-through voice status on your main display. Works with windowed or borderless games; exclusive fullscreen is not supported.')}</small></fieldset>;
}
