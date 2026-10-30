import { useEffect, useRef, useState } from 'react';
import { permissions, resolvePermissions, type Channel, type Permission, type Role } from '@dorham/contracts';
import { request } from './api';
import { t } from './i18n';
type Document = { channelId: string; role: Role; revision: number; permissions: Partial<Record<Permission, boolean>> };
export function ChannelPermissions({ channels, manage, error }: { channels: Channel[]; manage: boolean; error: (e: unknown) => void }) {
  const [channelId, setChannelId] = useState(channels[0]?.id || ''), [role, setRole] = useState<Role>('member');
  const [document, setDocument] = useState<Document | null>(null), [values, setValues] = useState<Partial<Record<Permission, boolean>>>({});
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false), generation = useRef(0);
  async function load(signal?: AbortSignal) {
    const epoch = ++generation.current; setDocument(null); setSaved(false);
    try { const next = await request<Document>(`/channels/${channelId}/overrides?role=${role}`, undefined, 'GET', true, { signal });
      if (generation.current === epoch && !signal?.aborted) { setDocument(next); setValues(next.permissions); }
    } catch (e) { if (!signal?.aborted && generation.current === epoch) error(e); }
  }
  useEffect(() => { if (!channelId || !manage) return; const abort = new AbortController(); void load(abort.signal); return () => { generation.current++; abort.abort(); }; }, [channelId, role, manage]);
  const current = document?.channelId === channelId && document.role === role;
  const effective = resolvePermissions(role, values);
  return <form onSubmit={e => { e.preventDefault(); if (!current || busy) return; setBusy(true);
    void request(`/channels/${channelId}`, { role, permissions: values, expectedRevision: document.revision }, 'PATCH').then(async () => { await load(); setSaved(true); }).catch(e => { error(e); if (e.code === 'STALE_PERMISSIONS') void load(); }).finally(() => setBusy(false));
  }}><p>{t('Load saved overrides before editing. Effective access also includes assigned custom roles.')}</p>
    <label>{t('Channel')}<select value={channelId} disabled={busy} onChange={e => setChannelId(e.target.value)}>{channels.map(ch => <option key={ch.id} value={ch.id}>{ch.name}</option>)}</select></label>
    <label>{t('Role')}<select value={role} disabled={busy} onChange={e => setRole(e.target.value as Role)}>{(['member', 'moderator', 'administrator'] as const).map(r => <option key={r} value={r}>{t(r)}</option>)}</select></label>
    {!current && <p role="status">{t(manage ? 'Loading permissions…' : 'You cannot edit channel permissions.')}</p>}
    {permissions.map(p => <label className="permission-row" key={p}>{t(p)}<span className="permission-effective">{t(effective[p] ? 'Role access: allowed' : 'Role access: denied')}</span><select disabled={!current || busy || !manage} value={values[p] === undefined ? '' : String(values[p])} onChange={e => { const next = { ...values }; if (!e.target.value) delete next[p]; else next[p] = e.target.value === 'true'; setValues(next); setSaved(false); }}><option value="">{t('Use role default')}</option><option value="true">{t('Allow')}</option><option value="false">{t('Deny')}</option></select></label>)}
    <button className="primary" disabled={!current || !manage || busy}>{t(saved ? 'Saved' : 'Save channel overrides')}</button>
  </form>;
}
