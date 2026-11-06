import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { VoiceRoom } from '@dorham/contracts';
import { t } from './i18n';
import { assetUrl } from './api';
import './windows-overlay.css';
import { speakingStore } from './LiveStatus';
export type OverlayPreferences = { enabled: boolean; position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' };
export type OverlayState = { channel: string; language: string; members: { id?: string; name: string; avatar?: string | null; muted: boolean; deafened: boolean; serverMuted: boolean; speaking: boolean }[] } | null;
export function WindowsOverlayBridge({ room, name, language }: { room: VoiceRoom | null; name: string; language: string }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    void window.desktop?.getOverlay?.().then(value => { if (live) setEnabled(value.enabled); }).catch(() => {});
    const remove = window.desktop?.onOverlayPreferences?.(value => setEnabled(value.enabled));
    return () => { live = false; remove?.(); };
  }, []);
  const speaking = useSyncExternalStore(enabled && room ? speakingStore.subscribeAll : noSubscription, enabled && room ? speakingStore.snapshot : emptySnapshot);
  useWindowsVoiceOverlay(room, name, speaking, language, enabled);
  return null;
}
const emptySpeaking: Record<string, boolean> = {};
const emptySnapshot = () => emptySpeaking;
const noSubscription = () => () => {};
export function useWindowsVoiceOverlay(room: VoiceRoom | null, name: string, speaking: Record<string, boolean>, language: string, enabled: boolean) {
  const thumbnails = useRef(new Map<string, string>()), previous = useRef(new Map<string, string>());
  const [revision, setRevision] = useState(0);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), latest = useRef({ room, name, language, speaking });
  latest.current = { room, name, language, speaking };
  const avatarSources = JSON.stringify([...new Set(enabled ? room?.members.map(m => m.user.avatar).filter(Boolean) || [] : [])]);
  useEffect(() => {
    if (!window.desktop?.updateOverlay || !enabled) return;
    let active = true; const images: HTMLImageElement[] = [], wanted = new Set(JSON.parse(avatarSources) as string[]);
    for (const key of thumbnails.current.keys()) if (!wanted.has(key)) thumbnails.current.delete(key);
    for (const source of wanted) {
      if (thumbnails.current.has(source) || !/^\/avatars\/[A-Za-z0-9_-]+\.webp$/.test(source)) continue;
      const image = new Image(); images.push(image); image.crossOrigin = 'anonymous'; image.referrerPolicy = 'no-referrer';
      image.onload = () => {
        if (!active) return;
        try { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64; const context = canvas.getContext('2d'); if (!context) return; context.drawImage(image, 0, 0, 64, 64); const png = canvas.toDataURL('image/png'); if (png.length <= 32768) { thumbnails.current.set(source, png); setRevision(value => value + 1); } } catch { /* Keep initials if an avatar cannot be read. */ }
      };
      image.src = assetUrl(source)!;
    }
    return () => { active = false; for (const image of images) { image.onload = null; image.removeAttribute('src'); } };
  }, [avatarSources, enabled]);
  useEffect(() => {
    if (!window.desktop?.updateOverlay) return;
    if (!enabled || !room) { if (pending.current) clearTimeout(pending.current); pending.current = undefined; previous.current.clear(); window.desktop.updateOverlay(null); return; }
    if (pending.current) return;
    // Coalesce bursts of speaking events without a persistent polling timer.
    pending.current = setTimeout(() => {
      pending.current = undefined;
      const { room, name, language, speaking } = latest.current;
      if (!room) return;
      const next = new Map<string, string>();
      const members = room.members.map(member => {
        const id = member.user.id, avatar = thumbnails.current.get(member.user.avatar || '') || '';
        next.set(id, avatar);
        return { id, name: member.user.displayName, ...(previous.current.get(id) === avatar ? {} : { avatar: avatar || null }), muted: member.muted, deafened: member.deafened || member.serverDeafened === true, serverMuted: member.serverMuted, speaking: speaking[id] === true };
      });
      previous.current = next; window.desktop?.updateOverlay?.({ channel: name, language, members });
    }, 40);
  }, [room, name, language, speaking, enabled, revision]);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); window.desktop?.updateOverlay?.(null); }, []);
}
export function WindowsVoiceOverlaySettings({ error }: { error: (error: unknown) => void }) {
  const [prefs, setPrefs] = useState<OverlayPreferences>({ enabled: false, position: 'top-left' }), [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; void window.desktop?.getOverlay?.().then(value => { if (active) { setPrefs(value); setReady(true); } }).catch(error); return () => { active = false; }; }, []);
  if (!window.desktop?.configureOverlay) return null;
  async function save(next: OverlayPreferences) { setBusy(true); try { const value = await window.desktop!.configureOverlay!(next); setPrefs(value); } catch (e) { error(e); } finally { setBusy(false); } }
  return <fieldset className="game-overlay-settings" disabled={!ready || busy}><legend>{t('Windows voice overlay')}</legend><label className="check-row"><input type="checkbox" checked={prefs.enabled} onChange={e => { void save({ ...prefs, enabled: e.target.checked }); }}/>{t('Show voice overlay in games')}</label><label>{t('Overlay position')}<select aria-label={t('Overlay position')} value={prefs.position} onChange={e => { void save({ ...prefs, position: e.target.value as OverlayPreferences['position'] }); }}>{['top-left', 'top-right', 'bottom-left', 'bottom-right'].map(p => <option value={p} key={p}>{t(({ 'top-left': 'Top left', 'top-right': 'Top right', 'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right' } as Record<string, string>)[p])}</option>)}</select></label><small>{t('Click-through voice status on your main display. Works with windowed or borderless games; exclusive fullscreen is not supported.')}</small></fieldset>;
}
