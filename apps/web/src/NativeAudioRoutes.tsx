import { useEffect, useState } from 'react';
import { registerPlugin } from '@capacitor/core';
import { t } from './i18n';
const media = registerPlugin<any>('DorhamMedia');
type Routes = { selected: string; devices: { id: string; name: string }[] };
export function NativeAudioRoutes() {
  const [routes, setRoutes] = useState<Routes>({ selected: 'system', devices: [] }), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { let disposed = false; const update = () => { void media.getAudioRoutes().then((value: Routes) => { if (!disposed) setRoutes(value); }).catch(() => {}); }; update(); let handle: { remove(): Promise<void> } | undefined; void media.addListener('audioRoutes', update).then((value: typeof handle) => { if (disposed) void value?.remove(); else handle = value; }); return () => { disposed = true; void handle?.remove(); }; }, []);
  return <section className="native-route-settings"><label>{t('Audio output')}<select aria-label={t('Audio output')} disabled={busy} value={routes.selected} onChange={event => { setBusy(true); setError(''); void media.setDevice({ deviceId: event.target.value }).then(() => media.getAudioRoutes()).then(setRoutes).catch(() => setError(t('Could not change audio route. Check the connected device.'))).finally(() => setBusy(false)); }}><option value="system">{t('System default')}</option>{routes.devices.map(device => <option key={device.id} value={device.id}>{t(device.name)}</option>)}</select></label><p>{t('Android manages the microphone for the selected speaker or headset.')}</p>{error && <p role="alert">{error}</p>}</section>;
}
