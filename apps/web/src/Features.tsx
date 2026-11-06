import { createContext, useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Capacitor } from '@capacitor/core';
import type { Socket } from 'socket.io-client';
import type { PublicUser } from '@dorham/contracts';
import { assetUrl, request, serverUrl } from './api';
import { currentLanguage, t } from './i18n';
import './features.css';

declare const __APP_VERSION__: string;
export type CatalogItem = {
  id: string;
  kind: 'avatar' | 'badge' | 'frame' | 'banner' | 'emoji' | 'sticker' | 'sound';
  label: string;
  pack?: string;
  url: string;
  serverId: string;
  usable: boolean;
  active: boolean;
  freeSlot?: number | null;
};
type FeatureState = {
  grants: Record<string, number>;
  screen: 'hidden' | 'selected' | 'locked';
  soundboard: boolean;
  catalog: CatalogItem[];
  voices: { id: string; label: string }[];
  plusSelected: boolean;
  announcements: { id: string; en: string; fa: string }[];
  announcementBoundary: number;
  communityBoundary: number;
  catalogVersion: string;
};
const empty: FeatureState = { grants: {}, screen: 'hidden', soundboard: false, catalog: [], voices: [], plusSelected: false, announcements: [], announcementBoundary: 0, communityBoundary: 0, catalogVersion: "" };
const initial = { ...empty, refresh: () => {}, byId: new Map<string, CatalogItem>(),  };
export const FeatureContext = createContext(initial);
export const useFeatures = () => useContext(FeatureContext);
export function useFeatureState(socket: RefObject<Socket | null>, uid: string | undefined) {
  const [entry, setEntry] = useState<{ uid: string; origin: string; data: FeatureState }>();
  const current = useRef(entry);
  const origin = serverUrl();
  const [revision, setRevision] = useState(0);
  const refresh = useMemo(() => () => setRevision(value => value + 1), []);
  const state = entry?.uid === uid && entry?.origin === origin ? entry.data : empty;
  useEffect(() => {
    if (!uid) return;
    let running = false, again = false;
    const controller = new AbortController();
    const load = async () => {
      if (running) { again = true; return; }
      running = true;
      try {
        const platform = Capacitor.getPlatform() === 'android' ? 'android' : window.desktop ? 'windows' : 'web';
        const cached = current.current?.uid === uid && current.current.origin === origin ? current.current.data : empty;
        const data = await request<FeatureState>(`/features?platform=${platform}&version=${encodeURIComponent(__APP_VERSION__)}&catalogVersion=${cached.catalogVersion}`, undefined, 'GET', true, { signal: controller.signal });
        if (!controller.signal.aborted) {
          const next = { uid, origin, data: { ...data, catalog: data.catalog ?? cached.catalog } };
          current.current = next;
          setEntry(next);
        }
      } catch { /* Bundled defaults also support older Dorham servers. */ }
      finally {
        running = false;
        if (again && !controller.signal.aborted) { again = false; void load(); }
      }
    };
    const visible = () => { if (!document.hidden) void load(); };
    const instance = socket.current;
    instance?.on('features:changed', load);
    instance?.on('state:changed', load);
    instance?.on('connect', load);
    document.addEventListener('visibilitychange', visible);
    void load();
    return () => {
      controller.abort();
      instance?.off('features:changed', load);
      instance?.off('state:changed', load);
      instance?.off('connect', load);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [socket, uid, origin, revision]);
  useEffect(() => {
    const now = Date.now(), boundaries = [...Object.values(state.grants), state.announcementBoundary, state.communityBoundary].filter(at => at > now);
    if (!boundaries.length) return;
    const timer = window.setTimeout(refresh, Math.min(2147483647, Math.min(...boundaries) - now + 100));
    return () => window.clearTimeout(timer);
  }, [state, refresh]);
  const byId = useMemo(() => new Map(state.catalog.map(item => [item.id, item])), [state.catalog]);
  return useMemo(() => ({ ...state, refresh, byId }), [state, refresh, byId]);
}

const ranks = {
  plus: { text: 'Plus', icon: <path d="M12 1.5 14.8 9.2 22.5 12 14.8 14.8 12 22.5 9.2 14.8 1.5 12 9.2 9.2Z"/> },
  pro: { text: 'Pro', icon: <path d="m5 4-4 6 11 12 11-12-4-6H5Zm0 6h14M8 4l4 18 4-18" /> },
  ultra: { text: 'Ultra', icon: <path d="M12 4 17 8v8l-5 5-5-5V8l5-4ZM7 10 1 6l2 8 4 2m10-6 6-4-2 8-4 2m-5-9v7"/> },
  max: { text: 'Max', icon: <path d="m3 10 4 3 5-5 5 5 4-3-2 10H5L3 10Zm4 6h10M12 1v4M4 3l2 3m14-3-2 3"/> },
} as const;
export function RankBadge({ user, label = false }: { user: PublicUser; label?: boolean }) {
  const rank = user.rankBadge;
  if (!rank || rank === 'none' || !Object.hasOwn(ranks, rank)) return null;
  const value = ranks[rank];
  return <span className={`rank-badge rank-${rank}`} title={value.text} aria-label={value.text}>
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">{value.icon}</svg>
    {label && value.text}
  </span>;
}

export function FeatureAnnouncements() {
  const { announcements } = useFeatures();
  const language = currentLanguage() === 'fa-IR' ? 'fa' : 'en';
  return <>{announcements.map(item => <p key={item.id} className="feature-announcement" role="status" dir="auto">{item[language] || item.en || item.fa}</p>)}</>;
}

export function ProfileCatalog({ me, error }: { me: PublicUser; error: (err: unknown) => void }) {
  const { catalog, grants, voices, plusSelected, refresh } = useFeatures();
  const [busy, setBusy] = useState(false);
  const [accent, setAccent] = useState(me.profileAccent || '#86e5bd');
  const visible = catalog.filter(item => item.active && item.usable && ['avatar', 'badge', 'banner', 'frame'].includes(item.kind));
  const change = async (route: string, body: unknown) => {
    setBusy(true);
    try { await request(route, body, 'PUT'); refresh(); }
    catch (e) { error(e); }
    finally { setBusy(false); }
  };
  if (!visible.length && grants.profilePlus === undefined && !voices.length) return null;
  return <section className="feature-profile" aria-label={t('Profile catalog')}>
    {visible.length > 0 && <><h3>{t('Profile catalog')}</h3>{(['avatar', 'badge', 'banner', 'frame'] as const).map(kind => {
      const items = visible.filter(item => item.kind === kind);
      return items.length > 0 && <div key={kind}><strong>{t(kind)}</strong><div className="feature-assets">
        {items.map(item => <button type="button" className="secondary" key={item.id} title={item.label} disabled={busy} onClick={() => void change('/features/profile', { kind, value: item.id })}>
          <img src={assetUrl(item.url)} alt={item.label} width="42" height="42" loading="lazy" />
        </button>)}
        <button type="button" className="secondary" disabled={busy} onClick={() => void change('/features/profile', { kind, value: '' })}>{t('Clear')}</button>
      </div></div>;
    })}</>}
    {grants.profilePlus !== undefined && <label>{t('Profile accent')} <input type="color" value={accent} onChange={e => setAccent(e.target.value)} />
      <button type="button" className="secondary" disabled={busy} onClick={() => void change('/features/profile', { kind: 'accent', value: accent })}>{t('Save')}</button></label>}
    {voices.length > 0 && <label>{t('Speech voice')}<select disabled={busy} value={plusSelected ? 'plus' : 'standard'} onChange={e => void change('/features/speech', { voice: e.target.value })}>
      <option value="standard">{t('Standard')}</option>{voices.map(voice => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
    </select><small>{t('TTS Plus sends the selected message text to the configured speech provider and plays AI-generated audio.')}</small></label>}
  </section>;
}
