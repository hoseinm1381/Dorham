import { useState } from 'react';
import type { Server } from '@dorham/contracts';
import { request, assetUrl } from './api';
import { prepareAvatar } from './avatar';
import { t } from './i18n';
export function ServerIconControl({ server, refresh, error }: { server: Server; refresh: () => Promise<void>; error: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  return <section className="avatar-upload server-icon-control" aria-label={t('Server icon')}><span className="server-icon">{server.icon ? <img crossOrigin="anonymous" src={assetUrl(server.icon)} alt=""/> : server.name.slice(0, 2).toUpperCase()}</span><label className={`secondary ${busy ? 'disabled' : ''}`}>{t('Change server icon')}<input disabled={busy} type="file" aria-label={t('Change server icon')} accept="image/png,image/jpeg,image/webp" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setBusy(true); void prepareAvatar(file).then(image => { const form = new FormData(); form.set('icon', image); return request(`/servers/${server.id}/icon`, form); }).then(refresh).catch(error).finally(() => setBusy(false)); }}/></label>{server.icon && <button className="secondary" disabled={busy} onClick={() => { setBusy(true); void request(`/servers/${server.id}/icon`, {}, 'DELETE').then(refresh).catch(error).finally(() => setBusy(false)); }}>{t('Remove server icon')}</button>}<small>{t('PNG, JPG or WebP · up to 25 MB · resized automatically')}</small></section>;
}
