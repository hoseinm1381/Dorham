import { useEffect, useRef, useState } from 'react';
import { Download, ArrowUpCircle, X } from 'lucide-react';
import { RELEASE_ORIGIN, releaseFile, type ReleaseManifest } from '../../../packages/contracts/src/releases';
import { useRelease, releasePlatform } from './ReleaseProvider';
import { t } from './i18n';
import './releases.css';
export function ReleaseActions({ inCall = false }: { inCall?: boolean }) {
  const { info, refresh, install } = useRelease();
  const [open, setOpen] = useState(false), [manifest, setManifest] = useState<ReleaseManifest | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!container.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('click', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  async function load() {
    setOpen(true); setError(''); setBusy(true);
    try {
      const response = await fetch(`${RELEASE_ORIGIN}/downloads/latest.json`, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error('Downloads are temporarily unavailable.');
      const value: unknown = await response.json(); releaseFile(value, 'windows'); releaseFile(value, 'android'); setManifest(value as ReleaseManifest);
      await refresh();
    } catch { setError('Downloads are temporarily unavailable.'); } finally { setBusy(false); }
  }
  async function update() {
    setOpen(true); setError(''); setBusy(true);
    try { await install(); } catch (e) { const message = e instanceof Error ? e.message : ''; setError(message.includes('Allow Dorham to install updates') ? 'Allow Dorham to install updates, then tap Update again.' : 'The update could not be started. Try again later.'); } finally { setBusy(false); }
  }
  return <div className="release-actions" ref={container}>
    {info?.available && <button type="button" className="release-update" disabled={busy || inCall} title={t(inCall ? 'Disconnect voice before installing an update.' : 'Install update')} onClick={() => { void update(); }}><ArrowUpCircle size={14}/>{t('Update')} <b>{info.latest}</b></button>}
    <button type="button" className="release-trigger" aria-label={t('Download apps')} aria-expanded={open} onClick={() => { if (open) setOpen(false); else void load(); }}><Download size={14}/><span>{t('Get apps')}</span></button>
    {open && <section className="release-menu" role="dialog" aria-label={t('Download apps')}><header><strong>{t('Dorham apps')}</strong><button type="button" aria-label={t('Close downloads')} onClick={() => setOpen(false)}><X size={14}/></button></header>
      {busy && <p role="status">{t('Please wait…')}</p>}
      {manifest && !busy && <><a href={manifest.windows.url} target="_blank" rel="noopener noreferrer">Windows <small>{manifest.windows.version}</small></a><a href={manifest.android.url} target="_blank" rel="noopener noreferrer">Android <small>{manifest.android.version}</small></a></>}
      {releasePlatform && !busy && <button type="button" className="release-check" onClick={() => { void refresh(); }}>{t('Check for updates')}</button>}
      {error && <p role="status">{t(error)} <button type="button" onClick={() => { void load(); }}>{t('Try again')}</button></p>}
    </section>}
  </div>;
}
