import { useEffect, useState, type FormEvent } from 'react';
import { Music2, Play, Plus, Search, Trash2, Upload } from 'lucide-react';
import { request } from './api';
import { t, formatNumber } from './i18n';
import type { MusicData, MusicTrack } from './music-state';

type MemberList = { id: string; name: string; owner: string; owned: boolean; public: boolean; tracks: MusicTrack[] };
type Community = { lists: MemberList[]; allowance: { usedBytes: number; limitBytes: number }; canEdit: boolean; canUpload: boolean };
type Props = {
  route: string;
  data: MusicData;
  queue: (action: string, fields: Record<string, unknown>) => Promise<boolean>;
};
const mb = (bytes: number) => formatNumber(Math.round(bytes / 10000) / 100);
const errorMessage = (error: unknown) => t(error instanceof Error ? error.message : 'Music is temporarily unavailable.');

export function MusicCommunity({ route, data, queue }: Props) {
  const [community, setCommunity] = useState<Community>();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [isPublic, setPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [update, setUpdate] = useState(0);
  const endpoint = route + '/community';
  const list = community?.lists.find(item => item.id === selected);
  const canQueue = data.canRequest && !data.state.policy.disabled;

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const search = new URLSearchParams({ q: query.trim() });
      void request<Community>(endpoint + '?' + search, undefined, 'GET', true, { signal: controller.signal })
        .then(setCommunity)
        .catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    }, query ? 220 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [endpoint, query, update]);

  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      const result = await action() as { id?: string };
      if (result?.id) setSelected(result.id);
      setUpdate(value => value + 1);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally { setBusy(false); }
  }

  const edit = (action: string, fields: Record<string, unknown>) => change(() => request(endpoint, { action, ...fields }));
  function create(event: FormEvent) {
    event.preventDefault();
    void edit('create', { name: name.trim(), public: isPublic }).then(ok => {
      if (ok) { setCreating(false); setName(''); setPublic(false); }
    });
  }

  return <div className="music-pane">
    <div className="music-search"><Search size={18} aria-hidden="true"/><input aria-label={t('Search community playlists')} placeholder={t('Search community playlists')} value={query} maxLength={80} onChange={event => setQuery(event.target.value)}/></div>
    {error && <p role="alert" className="music-feedback error">{error}</p>}
    {community ? <>
      <div className="music-section-heading music-community-heading">
        <h3>{t('Community playlists')}</h3>
        <small>{t('{used} of {limit} MB used', { used: mb(community.allowance.usedBytes), limit: mb(community.allowance.limitBytes) })}</small>
      </div>
      {community.canEdit && <div className="music-filter"><button type="button" aria-expanded={creating} disabled={busy} onClick={() => setCreating(value => !value)}><Plus size={15}/>{t('New playlist')}</button></div>}
      {creating && community.canEdit && <form className="music-form" onSubmit={create}>
        <label>{t('Playlist name')}<input value={name} maxLength={60} required onChange={event => setName(event.target.value)}/></label>
        <label className="music-checkbox"><input type="checkbox" checked={isPublic} onChange={event => setPublic(event.target.checked)}/>{t('Public playlist')}</label>
        <button className="secondary" disabled={busy || !name.trim()}>{t('Create playlist')}</button>
      </form>}
      <div className="music-list">{community.lists.map(item => <div key={item.id} className="music-track-row">
        <Music2 size={18} aria-hidden="true"/>
        <button className="music-track-text music-community-name" type="button" aria-expanded={item.id === selected} onClick={() => setSelected(item.id === selected ? '' : item.id)}>
          <strong><bdi>{item.name}</bdi></strong><small><bdi>{item.owner}</bdi> · {t(item.public ? 'Public playlist' : 'Private playlist')}</small>
        </button>
        {canQueue && <button className="music-icon" type="button" disabled={busy || !item.tracks.length} aria-label={t('Play playlist')} title={t('Play playlist')} onClick={() => void queue('import', { memberList: item.id })}><Play size={16}/></button>}
      </div>)}</div>
      {!community.lists.length && <p className="music-empty">{t('No community playlists found.')}</p>}
      {list && <MemberPlaylist key={list.id} list={list} canEdit={community.canEdit && list.owned} canUpload={community.canUpload && list.owned && list.public} canQueue={canQueue} busy={busy}
        allowExplicit={data.state.policy.allowExplicit} route={route} edit={edit} change={change} queue={queue}/>}
    </> : !error && <p role="status" className="music-empty">{t('Loading music…')}</p>}
  </div>;
}

type PlaylistProps = {
  list: MemberList; canEdit: boolean; canUpload: boolean; canQueue: boolean; busy: boolean; allowExplicit: boolean; route: string;
  edit: (action: string, fields: Record<string, unknown>) => Promise<boolean>;
  change: (action: () => Promise<unknown>) => Promise<boolean>;
  queue: Props['queue'];
};

function MemberPlaylist({ list, canEdit, canUpload, canQueue, busy, allowExplicit, route, edit, change, queue }: PlaylistProps) {
  const [link, setLink] = useState('');
  const [rename, setRename] = useState(false);
  const [name, setName] = useState(list.name);
  const [deleting, setDeleting] = useState(false);
  return <section className="music-community-detail" aria-label={list.name}>
    <div className="music-section-heading"><h3><bdi>{list.name}</bdi></h3></div>
    {canEdit && <>
      <div className="music-filter">
        <button type="button" disabled={busy} onClick={() => void edit('visibility', { list: list.id, public: !list.public })}>{t(list.public ? 'Make private' : 'Make public')}</button>
        <button type="button" disabled={busy} aria-expanded={rename} onClick={() => setRename(value => !value)}>{t('Rename playlist')}</button>
        {deleting ? <>
          <button type="button" disabled={busy} onClick={() => void edit('delete', { list: list.id })}>{t('Confirm delete playlist')}</button>
          <button type="button" onClick={() => setDeleting(false)}>{t('Cancel')}</button>
        </> : <button type="button" onClick={() => setDeleting(true)}>{t('Delete playlist')}</button>}
      </div>
      {rename && <form className="music-form" onSubmit={event => {
        event.preventDefault(); void edit('rename', { list: list.id, name: name.trim() }).then(ok => { if (ok) setRename(false); });
      }}><label>{t('Playlist name')}<input value={name} maxLength={60} required onChange={event => setName(event.target.value)}/></label>
        <button className="secondary" disabled={busy || !name.trim()}>{t('Save')}</button>
      </form>}
      <form className="music-form" onSubmit={event => {
        event.preventDefault(); void edit('addLink', { list: list.id, url: link.trim() }).then(ok => { if (ok) setLink(''); });
      }}>
        <label>{t('Direct HTTPS audio or M3U playlist link')}<input type="url" value={link} maxLength={2048} required onChange={event => setLink(event.target.value)}/></label>
        <button className="secondary" disabled={busy || !link.trim()}>{t('Add link')}</button>
      </form>
      {canUpload && <PlaylistUpload allowExplicit={allowExplicit} busy={busy} submit={(file, title, explicit) => {
        const query = new URLSearchParams({ list: list.id, name: title, rights: 'yes', explicit: explicit ? 'yes' : 'no' });
        return change(() => request(route + '/upload?' + query, file, 'POST', true, { timeoutMs: 60000 }));
      }}/>}
    </>}
    {!list.tracks.length && <p className="music-empty">{t('There are no tracks here yet.')}</p>}
    <div className="music-list">{list.tracks.map(track => <div className="music-track-row" key={track.id}>
      <Music2 size={16} aria-hidden="true"/><div className="music-track-text"><strong><bdi>{track.title}</bdi></strong><small>{t(track.source === 'link' ? 'Linked audio' : 'Community upload')}</small></div>
      <div className="music-row-actions">
        {canQueue && <button className="music-icon" type="button" disabled={busy} aria-label={t('Play track')} title={t('Play track')} onClick={() => void queue('add', { track: track.id })}><Play size={15}/></button>}
        {canEdit && <button className="music-icon" type="button" disabled={busy} aria-label={t('Remove track')} title={t('Remove track')} onClick={() => void edit('remove', { list: list.id, track: track.id })}><Trash2 size={15}/></button>}
      </div>
    </div>)}</div>
  </section>;
}

function PlaylistUpload({ busy, allowExplicit, submit }: {
  busy: boolean; allowExplicit: boolean; submit: (file: File, title: string, explicit: boolean) => Promise<boolean>;
}) {
  const [file, setFile] = useState<File>();
  const [title, setTitle] = useState('');
  const [rights, setRights] = useState(false);
  const [explicit, setExplicit] = useState(false);
  return <details className="music-form">
    <summary><Upload size={15} aria-hidden="true"/>{t('Upload audio')}</summary>
    <form className="music-upload-fields" onSubmit={event => {
      event.preventDefault();
      const form = event.currentTarget;
      if (file && rights) void submit(file, title.trim(), explicit).then(ok => {
        if (ok) { form.reset(); setFile(undefined); setTitle(''); setRights(false); setExplicit(false); }
      });
    }}>
      <label>{t('Choose an audio file')}<input type="file" accept="audio/*,.opus,.flac,.m4a" required onChange={event => {
        const next = event.target.files?.[0]; setFile(next); setTitle(next?.name.replace(/\.[^.]+$/, '').slice(0, 100) || ''); setRights(false);
      }}/></label>
      <label>{t('Track title')}<input value={title} maxLength={100} required onChange={event => setTitle(event.target.value)}/></label>
      <label className="music-checkbox"><input type="checkbox" checked={rights} onChange={event => setRights(event.target.checked)}/>{t('I have permission to share this audio publicly.')}</label>
      {allowExplicit && <label className="music-checkbox"><input type="checkbox" checked={explicit} onChange={event => setExplicit(event.target.checked)}/>{t('Explicit audio')}</label>}
      <button className="secondary" disabled={busy || !file || !rights || !title.trim()}>{t('Upload audio')}</button>
    </form>
  </details>;
}
