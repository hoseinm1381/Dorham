import { useState } from 'react';
import { currentLanguage, t } from './i18n';
import type { MusicData } from './music-state';

export function MusicEvents({ data, busy, command }: { data: MusicData; busy: boolean; command: (action: string, value: Record<string, unknown>) => Promise<boolean> }) {
  const [title, setTitle] = useState('');
  const [playlist, setPlaylist] = useState('');
  const [when, setWhen] = useState('');
  const [expanded, setExpanded] = useState(false);
  const shared = (data.state.playlists || []).filter(list => list.shared && list.tracks?.length);
  const date = new Intl.DateTimeFormat(currentLanguage(), { dateStyle: 'medium', timeStyle: 'short' });
  const at = new Date(when).getTime();
  return <section className="music-form">
    <div className="music-section-heading"><h3>{t('Listening parties')}</h3><button type="button" className="secondary" aria-expanded={expanded} disabled={!shared.length || data.state.policy.disabled} onClick={() => setExpanded(!expanded)}>{t('Schedule session')}</button></div>
    {(data.state.events || []).map(event => <div className="music-event" key={event.id}><div><strong><bdi>{event.title}</bdi></strong><small>{date.format(event.at)}</small></div><button className="secondary" type="button" disabled={busy || data.state.policy.disabled} onClick={() => void command('cancelEvent', { event: event.id })}>{t('Cancel')}</button></div>)}
    {!shared.length && <p className="music-empty">{t('Create a shared playlist to schedule music.')}</p>}
    {expanded && <form className="music-form music-schedule" onSubmit={event => {
      event.preventDefault();
      if (!Number.isFinite(at)) return;
      void command('schedule', { title, playlist, at }).then(ok => { if (ok) { setExpanded(false); setTitle(''); setWhen(''); } });
    }}>
      <label>{t('Session name')}<input required value={title} maxLength={80} onChange={event => setTitle(event.target.value)}/></label>
      <label>{t('Shared playlist')}<select required value={playlist} onChange={event => setPlaylist(event.target.value)}><option value="" disabled>{t('Choose a playlist')}</option>{shared.map(list => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>
      <label>{t('Start date and time')}<input required type="datetime-local" value={when} onChange={event => setWhen(event.target.value)}/></label>
      <p className="music-empty">{t('Uses your local time. A session waits up to 20 minutes for an available voice channel with listeners.')}</p>
      <button className="secondary" disabled={busy || !title.trim() || !playlist || !Number.isFinite(at)}>{t('Save session')}</button>
    </form>}
  </section>;
}
