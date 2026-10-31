import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
type UpdateInfo = { current: string; latest: string; available: boolean };
const android = registerPlugin<{ check(): Promise<UpdateInfo>; install(): Promise<{started: boolean}> }>('DorhamUpdates');
export const releasePlatform = window.desktop ? 'windows' : Capacitor.getPlatform() === 'android' ? 'android' : null;
const Releases = createContext<{ info: UpdateInfo | null; refresh(): Promise<void>; install(): Promise<void> }>({ info: null, refresh: async () => {}, install: async () => {} });
export const useRelease = () => useContext(Releases);
export function ReleaseProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null), last = useRef(0), busy = useRef(false);
  const refresh = useCallback(async () => {
    if (!releasePlatform || busy.current) return; busy.current = true; last.current = Date.now();
    try { const value = releasePlatform === 'windows' ? await window.desktop?.checkUpdate?.() : await android.check(); if (value) setInfo(value); } catch { /* Offline checks do not interrupt the app. */ } finally { busy.current = false; }
  }, []);
  const install = useCallback(async () => { if (releasePlatform === 'windows') await window.desktop?.installUpdate?.(); else if (releasePlatform === 'android') await android.install(); }, []);
  useEffect(() => {
    void refresh(); const timer = setInterval(() => { void refresh(); }, 3600000);
    const resume = () => { if (document.visibilityState === 'visible' && Date.now() - last.current > 300000) void refresh(); };
    window.addEventListener('online', resume); window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
    return () => { clearInterval(timer); window.removeEventListener('online', resume); window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); };
  }, [refresh]);
  return <Releases.Provider value={{ info, refresh, install }}>{children}</Releases.Provider>;
}
