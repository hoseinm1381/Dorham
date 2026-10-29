import { useCallback, useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { request } from './api';
import { t, formatFileSize } from './i18n';
import './upload-allowance.css';

type Usage = { usedBytes: number; limitBytes: number; sharedUsedBytes: number; softBytes: number; hardBytes: number; smallFileBytes: number };

export function UploadAllowance({ revision }: { revision: number }) {
  const [usage, setUsage] = useState<Usage | null>(null), [failed, setFailed] = useState(false);
  const active = useRef(true), pending = useRef(false), queued = useRef(false), refreshed = useRef(0);
  const refresh = useCallback(async (force = false): Promise<void> => {
    if (pending.current) { queued.current ||= force; return; }
    if (!force && Date.now() - refreshed.current < 30000) return;
    pending.current = true;
    try { const next = await request<Usage>('/uploads/usage'); if (active.current) { setUsage(next); setFailed(false); refreshed.current = Date.now(); } }
    catch { if (active.current) { setUsage(null); setFailed(true); } }
    finally { pending.current = false; if (queued.current && active.current) { queued.current = false; void refresh(true); } }
  }, []);
  useEffect(() => {
    active.current = true;
    const focus = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { active.current = false; window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [refresh]);
  useEffect(() => { void refresh(true); }, [revision, refresh]);
  const full = usage && (usage.usedBytes >= usage.limitBytes || usage.sharedUsedBytes >= usage.hardBytes);
  const smallOnly = usage && usage.sharedUsedBytes >= usage.softBytes;
  const caption = usage ? t('{used} of {limit} uploaded in the last 24 hours', { used: formatFileSize(usage.usedBytes), limit: formatFileSize(usage.limitBytes) }) : t(failed ? 'Upload usage unavailable' : 'Loading…');
  return <>
    <div className={`upload-allowance ${full ? 'upload-full' : ''}`} title={caption}>
      <span>{t('Daily uploads')}</span>
      <progress aria-label={t('Daily upload usage')} aria-valuetext={caption} max={usage?.limitBytes || 1} value={usage ? Math.min(usage.usedBytes, usage.limitBytes) : undefined}/>
      <span className="upload-amount" dir="auto">{usage ? `${formatFileSize(usage.usedBytes)} / ${formatFileSize(usage.limitBytes)}` : caption}</span>
      {(full || smallOnly) && <span className="upload-restriction" role="status">{t(full ? 'Upload limit reached' : 'Small files only')}</span>}
    </div>
    <details className="upload-limits" onToggle={e => { if (e.currentTarget.open) void refresh(); }}>
      <summary aria-label={t('Upload limits')} title={t('Upload limits')}><Info size={15}/></summary>
      <div className="upload-limits-panel">
        <p>{t('Your allowance covers the last 24 hours and becomes available gradually as older uploads expire from that window.')}</p>
        <p>{t('Tip: paste a copied picture into the message box with Ctrl+V.')}</p>
        <p>{t('Up to 10 MiB: 7 days · Up to 100 MiB: 24 hours · 300 MiB per 24 hours. Storage pressure may remove files earlier.')}</p>
        <p>{t('Shared allowance: 512 MiB daily, then files up to 2 MiB until 1 GiB total.')}</p>
        {usage && <p>{t('Shared usage: {used} of {limit}', { used: formatFileSize(usage.sharedUsedBytes), limit: formatFileSize(usage.hardBytes) })}</p>}
      </div>
    </details>
  </>;
}
