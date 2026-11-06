import { useEffect, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { t } from './i18n';
const files = registerPlugin<any>('DorhamFiles');
export function AndroidDownloadStatus() {
  const [value, setValue] = useState<{ progress: number; active: boolean } | null>(null);
  useEffect(() => { if (Capacitor.getPlatform() !== 'android') return; let disposed = false, handle: { remove(): Promise<void> } | undefined; void files.addListener('download', (next: typeof value) => { if (!disposed) setValue(next); }).then((next: typeof handle) => { if (disposed) void next?.remove(); else handle = next; }).catch(() => {}); return () => { disposed = true; void handle?.remove(); }; }, []);
  if (!value?.active) return null;
  return <div className="android-download-status" role="status"><span>{t('Downloading file')} · {value.progress}%</span><progress max={100} value={value.progress} aria-label={t('File download progress')}/><button onClick={() => { void files.cancel(); }}>{t('Cancel download')}</button></div>;
}
