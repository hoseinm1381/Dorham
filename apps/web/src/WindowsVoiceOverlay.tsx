import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { VoiceRoom } from '@dorham/contracts';
import { t } from './i18n';
import { assetUrl } from './api';
import './windows-overlay.css';
import { speakingStore } from './LiveStatus';
export type OverlayPreferences = { enabled: boolean; opacity?: number; speakersOnly?: boolean; monitor?: number | null; monitors?: string[]; position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' };
export type OverlayState = { channel: string; language: string; sharing?: boolean; members: { id?: string; name: string; avatar?: string | null; muted: boolean; deafened: boolean; serverMuted: boolean; speaking: boolean; watching?: boolean }[] } | null;
export function WindowsOverlayBridge({ room, name, language, musicMuted = false, streamViewers }: { room: VoiceRoom | null; name: string; language: string; musicMuted?: boolean; streamViewers?: string[] }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    let receivedPreference = false;
    const remove = window.desktop?.onOverlayPreferences?.(value => {
      receivedPreference = true;
      setEnabled(value.enabled);
    });
    void window.desktop?.getOverlay?.().then(value => { if (live && !receivedPreference) setEnabled(value.enabled); }).catch(() => {});
    return () => { live = false; remove?.(); };
  }, []);
  const speaking = useSyncExternalStore(enabled && room ? speakingStore.subscribeAll : noSubscription, enabled && room ? speakingStore.snapshot : emptySnapshot);
  useWindowsVoiceOverlay(room, name, speaking, language, enabled, musicMuted, streamViewers);
  return null;
}
const emptySpeaking: Record<string, boolean> = {};
const emptySnapshot = () => emptySpeaking;
const noSubscription = () => () => {};
function thumbnailSource(avatar: string | null) {
  if (!avatar || !/^\/(?:avatars\/[A-Za-z0-9_-]+\.webp|catalog\/[A-Za-z0-9_-]{1,80}\/[a-f0-9]{64})$/.test(avatar)) return '';
  // Canvas reads need CORS. Keep them separate from display-only image cache entries.
  return `${assetUrl(avatar)}?overlay=1`;
}
export function useWindowsVoiceOverlay(room: VoiceRoom | null, name: string, speaking: Record<string, boolean>, language: string, enabled: boolean, musicMuted = false, streamViewers?: string[]) {
  const thumbnails = useRef(new Map<string, string>()), previous = useRef(new Map<string, string>());
  const [revision, setRevision] = useState(0);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), latest = useRef({ room, name, language, speaking, musicMuted, streamViewers });
  latest.current = { room, name, language, speaking, musicMuted, streamViewers };
  const avatarSources = JSON.stringify([...new Set(enabled ? room?.members.map(m => thumbnailSource(m.user.avatar)).filter(Boolean) || [] : [])]);
  useEffect(() => {
    if (!window.desktop?.updateOverlay || !enabled) return;
    let active = true; const images: HTMLImageElement[] = [], wanted = new Set(JSON.parse(avatarSources) as string[]);
    for (const key of thumbnails.current.keys()) if (!wanted.has(key)) thumbnails.current.delete(key);
    for (const source of wanted) {
      if (thumbnails.current.has(source)) continue;
      const image = new Image(); images.push(image); image.crossOrigin = 'anonymous'; image.referrerPolicy = 'no-referrer';
      image.onload = () => {
        if (!active) return;
        try {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
          const context = canvas.getContext('2d');
          if (!context) return;
          const { naturalWidth, naturalHeight } = image;
          const size = Math.min(naturalWidth, naturalHeight);
          context.drawImage(image, (naturalWidth - size) / 2, (naturalHeight - size) / 2, size, size, 0, 0, 64, 64);
          const png = canvas.toDataURL('image/png');
          if (png.length <= 32768) { thumbnails.current.set(source, png); setRevision(value => value + 1); }
        } catch { /* Keep initials if an avatar cannot be read. */ }
      };
      image.src = source;
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
      const { room, name, language, speaking, musicMuted, streamViewers } = latest.current;
      if (!room) return;
      const next = new Map<string, string>();
      const members = room.members.map(member => {
        const id = member.user.id, avatar = thumbnails.current.get(thumbnailSource(member.user.avatar)) || '';
        next.set(id, avatar);
                const bot = member.user.kind === 'music';
        return { id, name: bot ? t('Dorham Music') + ' · ' + t('BOT') : member.user.displayName, ...(previous.current.get(id) === avatar ? {} : { avatar: avatar || null }), muted: bot ? musicMuted : member.muted, deafened: member.deafened || member.serverDeafened === true, serverMuted: member.serverMuted, speaking: speaking[id] === true, watching: streamViewers?.includes(id) === true };
      });
      previous.current = next; window.desktop?.updateOverlay?.({ channel: name, language, members, sharing: Boolean(streamViewers) });
    }, 40);
  }, [room, name, language, speaking, enabled, revision, musicMuted, streamViewers]);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); window.desktop?.updateOverlay?.(null); }, []);
}
export function WindowsVoiceOverlaySettings({ error }: { error: (error: unknown) => void }) {
  const [prefs, setPrefs] = useState<OverlayPreferences>({ enabled: false, position: 'top-left' }), [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; void window.desktop?.getOverlay?.().then(value => { if (active) { setPrefs(value); setReady(true); } }).catch(error); return () => { active = false; }; }, []);
  const [opacity, setOpacity] = useState<number>();
  if (!window.desktop?.configureOverlay) return null;
  async function save(next: OverlayPreferences) { setBusy(true); try { const value = await window.desktop!.configureOverlay!({ opacity: 60, ...next }); setPrefs(value); } catch (e) { error(e); } finally { setBusy(false); } }
  return <fieldset className="game-overlay-settings" disabled={!ready || busy}><legend>{t('Windows voice overlay')}</legend><label className="check-row"><input type="checkbox" checked={prefs.enabled} onChange={e => { void save({ ...prefs, enabled: e.target.checked }); }}/>{t('Show voice overlay in games')}</label><label className="check-row"><input type="checkbox" checked={prefs.speakersOnly === true} onChange={e => { void save({ ...prefs, speakersOnly: e.target.checked }); }}/>{t('Show only people who are speaking')}</label>{Boolean(prefs.monitors?.length) && <label>{t('Overlay display')}<select value={prefs.monitor ?? ""} onChange={event => { void save({ ...prefs, monitor: event.target.value === "" ? null : Number(event.target.value) }); }}><option value="">{t('Follow the Dorham window')}</option>{prefs.monitors?.map((name, index) => <option key={index} value={index}>{name}</option>)}</select></label>}<label>{t('Overlay position')}<select aria-label={t('Overlay position')} value={prefs.position} onChange={e => { void save({ ...prefs, position: e.target.value as OverlayPreferences['position'] }); }}>{['top-left', 'top-right', 'bottom-left', 'bottom-right'].map(p => <option value={p} key={p}>{t(({ 'top-left': 'Top left', 'top-right': 'Top right', 'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right' } as Record<string, string>)[p])}</option>)}</select></label><label>{t('Overlay opacity')} <output>{opacity ?? prefs.opacity ?? 60}%</output><input type="range" min={10} max={100} value={opacity ?? prefs.opacity ?? 60} onChange={e => setOpacity(Number(e.target.value))} onPointerUp={e => { void save({ ...prefs, opacity: Number(e.currentTarget.value) }); }} onKeyUp={e => { if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) void save({ ...prefs, opacity: Number(e.currentTarget.value) }); }}/></label><small>{t('Click-through voice status for windowed and borderless games.')}</small></fieldset>;
}
