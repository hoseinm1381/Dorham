import { useEffect, useState } from 'react';
import { t, formatFileSize } from './i18n';
import { clearStorage, saveStorageSettings, storageScope, storageSettings, storageUsage } from './offline-storage';

export function StorageSettings({ error }: { error: (cause: unknown) => void }) {
  const scope = storageScope();
  const [settings, setSettings] = useState(() => storageSettings(scope));
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof storageUsage>>>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => { void storageUsage(scope).then(setUsage).catch(error); }, [scope]);
  async function change(work: () => Promise<void>, message: string) {
    setBusy(true);
    try { await work(); setSettings(storageSettings(scope)); setUsage(await storageUsage(scope)); setNotice(t(message)); }
    catch (cause) { error(cause); }
    finally { setBusy(false); }
  }
  return <section className="settings-form" aria-label={t('Storage & Downloads')}>
    <p>{t('Recent conversations and media can be opened from this device on a weak connection.')}</p>
    <dl>{usage && ([['Messages', usage.messages], ['Images', usage.image], ['Videos', usage.video], ['Files', usage.file]] as const).map(([label, bytes]) => <div className="tag-row" key={label}><dt>{t(label)}</dt><dd>{formatFileSize(bytes)}</dd></div>)}</dl>
    <label>{t('Media cache limit')}<select value={settings.limit} disabled={busy} onChange={event => { const limit = Number(event.target.value); void change(() => saveStorageSettings({ ...settings, limit }), 'Storage settings saved.'); }}>{[25, 50, 100, 250, 500].map(value => <option key={value} value={value}>{formatFileSize(value * 1024 * 1024)}</option>)}</select></label>
    <label className="check-row"><input type="checkbox" checked={settings.dataSaver} disabled={busy} onChange={event => { const dataSaver = event.target.checked; void change(() => saveStorageSettings({ ...settings, dataSaver }), 'Storage settings saved.'); }}/>{t('Data Saver')}</label>
    <p>{t('Data Saver loads media on demand and favors speech during calls.')}</p>
    <button type="button" className="secondary" disabled={busy || !usage?.messages} onClick={() => void change(() => clearStorage(scope, 'history'), 'Message cache cleared.')}>{t('Clear message cache')}</button>
    <button type="button" className="secondary" disabled={busy || !usage || !(usage.image + usage.video + usage.file)} onClick={() => void change(() => clearStorage(scope, 'media'), 'Downloaded media cleared.')}>{t('Clear downloaded media')}</button>
    <p>{t('Files you saved to your device’s Downloads folder can be managed there.')}</p>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
