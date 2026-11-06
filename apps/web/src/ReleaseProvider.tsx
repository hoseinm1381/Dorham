import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
type UpdateInfo = { current: string; latest: string; available: boolean };
type UpdateStatus = { state: string; progress: number };
export type WindowsUpdateState = UpdateInfo & { phase: string; progress: number };
const android = registerPlugin<{ check(): Promise<UpdateInfo>; install(): Promise<{started: boolean}>; prepare(options: { automatic: boolean }): Promise<unknown>; cancel(): Promise<void>; getStatus(): Promise<UpdateStatus>; addListener(name: string, listener: (status: UpdateStatus) => void): Promise<{ remove(): Promise<void> }> }>('DorhamUpdates');
export const releasePlatform = window.desktop ? 'windows' : Capacitor.getPlatform() === 'android' ? 'android' : null;
const Releases = createContext<{ info: UpdateInfo | null; status: UpdateStatus; refresh(): Promise<void>; install(): Promise<void>; prepare(): Promise<void>; cancel(): Promise<void> }>({ info: null, status: { state: 'idle', progress: 0 }, refresh: async () => {}, install: async () => {}, prepare: async () => {}, cancel: async () => {} });
export const useRelease = () => useContext(Releases);
export function ReleaseProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null), last = useRef(0), busy = useRef(false);
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle', progress: 0 });
  const refresh = useCallback(async () => {
    if (!releasePlatform || busy.current) return; busy.current = true; last.current = Date.now();
    try { const value = releasePlatform === 'windows' ? await window.desktop?.checkUpdate?.() : await android.check(); if (value) { setInfo(value); if (releasePlatform === 'android' && value.available) void android.prepare({ automatic: true }).catch(() => {}); } } catch { /* Offline checks do not interrupt the app. */ } finally { busy.current = false; }
  }, []);
  const install = useCallback(async () => { if (releasePlatform === 'windows') await window.desktop?.installUpdate?.(); else if (releasePlatform === 'android') await android.install(); }, []);
  const prepare = useCallback(async () => {
    if (releasePlatform === 'windows') await window.desktop?.prepareUpdate?.();
    else if (releasePlatform === 'android') await android.prepare({ automatic: false });
  }, []);
  const cancel = useCallback(async () => { if (releasePlatform === 'android') await android.cancel(); }, []);
  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop?.onUpdateState) return;
    let disposed = false, received = false;
    const update = (value: WindowsUpdateState) => {
      received = true;
      setInfo(value);
      setStatus({ state: value.phase, progress: value.progress });
    };
    const unsubscribe = desktop.onUpdateState(update);
    void desktop.getUpdateState?.().then(value => { if (!disposed && !received) update(value); }).catch(() => {});
    return () => { disposed = true; unsubscribe(); };
  }, []);
  useEffect(() => { if (releasePlatform !== 'android') return; let disposed = false, handle: { remove(): Promise<void> } | undefined; void android.getStatus().then(value => { if (!disposed) setStatus(value); }).catch(() => {}); void android.addListener('progress', setStatus).then(value => { if (disposed) void value.remove(); else handle = value; }); return () => { disposed = true; void handle?.remove(); }; }, []);
  useEffect(() => {
    void refresh(); const timer = setInterval(() => { void refresh(); }, 3600000);
    const resume = () => { if (document.visibilityState === 'visible' && Date.now() - last.current > 300000) void refresh(); };
    const callEnded = (event: Event) => { if (!(event as CustomEvent<boolean>).detail) void refresh(); };
    window.addEventListener('dorham-native-call', callEnded); window.addEventListener('online', resume); window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
    return () => { clearInterval(timer); window.removeEventListener('dorham-native-call', callEnded); window.removeEventListener('online', resume); window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); };
  }, [refresh]);
  return <Releases.Provider value={{ info, status, refresh, install, prepare, cancel }}>{children}</Releases.Provider>;
}
