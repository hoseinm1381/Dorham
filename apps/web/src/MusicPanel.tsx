import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, Disc3, Heart, HeadphoneOff, Headphones, Link2, ListMusic, LogOut, Music2, Pause, Play, Plus, Radio, Repeat, Repeat1, Search, Settings2, Shuffle, SkipBack, SkipForward, Trash2, Volume2, VolumeX, X } from 'lucide-react';
import type { Socket } from 'socket.io-client';
import { normalizePeopleSearch } from '../../../packages/contracts/src/persian';
import { request } from './api';
import { t, formatNumber } from './i18n';
import type { MusicData, MusicEntry, MusicListening, MusicPlaylist, MusicPolicy, MusicTrack } from './music-state';
import { MusicCommunity } from './MusicCommunity';
import { MusicEvents } from './MusicEvents';
import './music.css';

type Command = (action: string, value?: Record<string, unknown>) => Promise<boolean>;
type Tab = 'Queue' | 'Library' | 'Playlists' | 'Community' | 'Music settings';
type LibraryFilter = 'All tracks' | 'Favorites' | 'Radio';

const labels = { playing: 'Playing', paused: 'Paused', buffering: 'Buffering music…', idle: 'Ready to play', error: 'Playback interrupted' };
const time = (value: number) => {
  const seconds = Math.max(0, Math.floor(value / 1000));
  return Math.floor(seconds / 60) + ':' + (seconds % 60).toString().padStart(2, '0');
};
function artIndex(track?: MusicTrack) {
  return (track?.id || '').split('').reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 3;
}
export function MusicAvatar({ track, large = false }: { track?: MusicTrack; large?: boolean }) {
  const Icon = track?.live ? Radio : large ? Disc3 : Music2;
  return <span className={'music-art' + (large ? ' music-art-large' : '')} data-palette={artIndex(track)} aria-hidden="true"><Icon size={large ? 46 : 18}/></span>;
}

export function MusicVoiceButton({ open }: { open: () => void }) {
  const label = t('Open music player');
  return <button type="button" className="icon-button music-compact" aria-label={label} title={label} aria-haspopup="dialog" onClick={open}><Music2 size={19} aria-hidden="true"/></button>;
}

export function MusicBotRow({ title, active, muted, serverDeafened, open, toggle, remove, removing }: { title?: string; active?: boolean; muted?: boolean; serverDeafened?: boolean; open: () => void; toggle?: () => void; remove?: () => void; removing?: boolean }) {
  return <div className="music-bot-item"><button className="music-bot-row" type="button" onClick={open} onContextMenu={event => { event.preventDefault(); open(); }}>
    <MusicAvatar/><span className="music-bot-name"><strong>{t('Dorham Music')} <small>{t('BOT')}</small></strong>{title && <span><bdi>{title}</bdi></span>}</span>
    {serverDeafened && <HeadphoneOff className="music-deafened" size={14} role="img" aria-label={t('Server deafened')}><title>{t('Server deafened. Dorham Music cannot hear voice chat.')}</title></HeadphoneOff>}
    {active && !muted && <span className="music-wave" aria-label={t('Playing')}><i/><i/><i/></span>}
  </button>
    {toggle && <MusicIcon label={muted ? 'Unmute music for me' : 'Mute music for me'} pressed={muted} onClick={toggle}>{muted ? <VolumeX size={15}/> : <Volume2 size={15}/>}</MusicIcon>}
    {remove && <MusicIcon label="Remove music bot from voice" disabled={removing} onClick={remove}><LogOut size={15}/></MusicIcon>}
  </div>;
}

function MusicIcon({ label, children, onClick, disabled, pressed }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean; pressed?: boolean }) {
  return <button type="button" className="music-icon" aria-label={t(label)} title={t(label)} onClick={onClick} disabled={disabled} aria-pressed={pressed}>{children}</button>;
}

export function MusicPanel({ channel, name, account, socket, listening, close }: { channel: string; name: string; account: string; socket: Socket | null; listening: MusicListening; close: () => void }) {
  const node = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<MusicData>();
  const [tab, setTab] = useState<Tab>('Library');
  const [link, setLink] = useState('');
  const [checkingLink, setCheckingLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [received, setReceived] = useState(Date.now());
  const [clock, setClock] = useState(Date.now());
  const [seeking, setSeeking] = useState<number>();
  const lastRequest = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const route = '/voice/' + encodeURIComponent(channel) + '/music';

  useEffect(() => {
    const dialog = node.current!;
    const focus = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); if (focus?.isConnected) focus.focus(); };
  }, []);

  async function refresh(signal?: AbortSignal) {
    const serial = ++lastRequest.current;
    try {
      const value = await request<MusicData>(route, undefined, 'GET', true, { signal });
      if (signal?.aborted || serial !== lastRequest.current) return;
      const now = Date.now();
      setData(value); setReceived(now); setClock(now);
    } catch (cause) {
      if (!signal?.aborted && serial === lastRequest.current) setError(msg(cause));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    const update = (event?: { channelId: string }) => { if (!event || event.channelId === channel) void refresh(controller.signal); };
    update();
    socket?.on('music:changed', update);
    const timer = setInterval(update, 6000);
    return () => { controller.abort(); socket?.off('music:changed', update); clearInterval(timer); };
  // The panel is keyed by channel. Its socket and fetches are replaced together.
  }, [channel, socket]);

  useEffect(() => {
    if (data?.state.status !== 'playing') return;
    const timer = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(timer);
  }, [data?.state.status]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await action() as { added?: number; skipped?: number } | undefined;
      if (typeof result?.added === 'number') setNotice(t('Added {count} · Skipped {skipped}', { count: formatNumber(result.added), skipped: formatNumber(result.skipped || 0) }));
      await refresh(abort.current?.signal);
      return true;
    } catch (cause) { setError(msg(cause)); return false; }
    finally { setBusy(false); }
  }
  const command: Command = (action, value) => act(() => request(route, { action, ...value }));
  const state = data?.state;
  const current = state?.current;
  const queued = state?.queue || [];
  const position = state?.status === 'playing' ? (state.position || 0) + Math.max(0, clock - received) : state?.position || 0;
  const playable = state?.status === 'playing' || state?.status === 'buffering';
  const stage = state?.policy.disabled ? t('Music is disabled in this channel.') : state?.disconnected ? t('Music disconnected') : t(labels[state?.status || 'idle']);
  const tabs: Tab[] = ['Library', 'Queue', 'Playlists', 'Community', 'Music settings'];
  const canAddLink = data?.canRequest && !state?.policy.disabled;
  const linkAction = state?.policy.mode === 'approval' && !data?.canDJ ? 'Request track' : current ? 'Add to queue' : 'Play link';

  async function submitLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = link.trim();
    if (!url || busy || !canAddLink) return;
    setCheckingLink(true);
    try {
      if (await command('addLink', { url })) setLink('');
    } finally { setCheckingLink(false); }
  }

  return <dialog ref={node} className="music-dialog" aria-label={t('Dorham Music')} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="music-shell">
      <header className="music-header">
        <div className="music-brand"><MusicAvatar/><div><h2>{t('Dorham Music')}</h2><p><bdi>{name}</bdi></p>
          {data?.serverDeafened && <p className="music-privacy"><HeadphoneOff size={14} aria-hidden="true"/>{t('Server deafened. Dorham Music cannot hear voice chat.')}</p>}
        </div></div>
        <div className="music-header-actions">
          {current && !state?.disconnected && !state?.policy.disabled && <button type="button" className="secondary music-remove-bot" aria-label={t('Remove music bot from voice')} disabled={busy} onClick={() => void command('stop')}><LogOut size={15} aria-hidden="true"/>{t('Remove bot')}</button>}
          <MusicIcon label="Close music player" onClick={close}><X size={20}/></MusicIcon>
        </div>
      </header>
      {data && state ? <>
        {canAddLink && <form className="music-link-bar" onSubmit={submitLink}>
          <div className="music-link-field">
            <Link2 size={18} aria-hidden="true"/>
            <input type="url" inputMode="url" required autoComplete="off" spellCheck={false} maxLength={2048} readOnly={checkingLink} value={link}
              aria-label={t('Play from an audio or playlist link')} placeholder={t('Paste a link')} onChange={event => setLink(event.target.value)}/>
          </div>
          <button className="secondary" type="submit" disabled={busy || !link.trim()}><Play size={15} aria-hidden="true"/>{t(checkingLink ? 'Checking link…' : linkAction)}</button>
        </form>}
        {(error || state.message) && <p role="alert" className="music-feedback error">{error || t(state.message!)}</p>}
        {notice && <p role="status" className="music-feedback">{notice}</p>}
        <div className="music-layout">
          <section className="music-playing" aria-label={t('Now playing')}>
            <div className="music-hero">
              <MusicAvatar large track={current?.track}/>
              <div className="music-track-head"><span className={'music-stage music-stage-' + state.status}>{stage}</span>
                <h3><bdi>{current?.track.title || t('Nothing playing yet')}</bdi></h3>
                {current ? <p><bdi>{current.track.artist}</bdi>{current.track.explicit && <span className="music-explicit" title={t('Explicit')}>E</span>}</p> : <p>{t('Choose a track from the library to get started.')}</p>}
              </div>
            </div>
            {current && !current.track.live && current.track.duration > 0 && <div className="music-timeline">
              <input aria-label={t('Playback position')} disabled={!data.canDJ || busy || state.policy.disabled} type="range" min={0} max={Math.max(0, current.track.duration - 100)} step={100} value={seeking ?? Math.min(position, current.track.duration)} onChange={event => setSeeking(Number(event.target.value))} onPointerUp={event => { void command('seek', { position: Number(event.currentTarget.value) }); setSeeking(undefined); }} onKeyUp={event => { if (seeking !== undefined && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) { void command('seek', { position: seeking }); setSeeking(undefined); } }} onBlur={() => setSeeking(undefined)}/>
              <div dir="ltr"><span>{time(seeking ?? Math.min(position, current.track.duration))}</span><span>{time(current.track.duration)}</span></div>
            </div>}
            {current?.track.live && <p className="music-live"><span/> {t(current.track.source === 'link' ? 'Linked audio' : 'Live radio')}</p>}
            {current?.name && <p className="music-requester">{t('Requested by {name}', { name: current.name })}</p>}
            {data.canDJ && <div className="music-transport">
              <MusicIcon label="Previous track" disabled={busy || !state.history?.length} onClick={() => void command('previous')}><SkipBack size={20}/></MusicIcon>
              <button type="button" className="music-play" disabled={busy || (!current && !queued.length) || state.policy.disabled} aria-label={t(playable ? 'Pause music' : 'Resume music')} onClick={() => void command(current ? playable ? 'pause' : 'resume' : 'start')}>
                {playable ? <Pause size={23} fill="currentColor"/> : <Play size={23} fill="currentColor"/>}
              </button>
              <MusicIcon label="Skip track" disabled={busy || !current} onClick={() => void command('skip', { entry: current?.id })}><SkipForward size={20}/></MusicIcon>
            </div>}
            {!data.canDJ && data.canVote && current && <button className="secondary music-vote" disabled={busy || data.voted} onClick={() => void command('vote', { entry: current.id })}>{t(data.voted ? 'Vote cast' : 'Vote to skip')} · {formatNumber(data.votes)}/{formatNumber(data.skipThreshold)}</button>}
            <div className="music-listening">
              <div><Headphones size={16}/><strong>{t('Your listening')}</strong></div>
              <div className="music-volume">
                <MusicIcon pressed={!listening.level} label={listening.level ? 'Mute for me' : 'Unmute for me'} onClick={listening.toggle}>{listening.level ? <Volume2 size={18}/> : <VolumeX size={18}/>}</MusicIcon>
                <input aria-label={t('Personal music volume')} type="range" min={0} max={100} value={listening.level} onChange={event => listening.changeLevel(Number(event.target.value))}/>
                <output>{formatNumber(listening.level)}%</output>
              </div>
            </div>
          </section>
          <section className="music-content">
            <nav className="music-tabs" aria-label={t('Music views')}>{tabs.map(next => <button key={next} type="button" aria-current={tab === next ? 'page' : undefined} onClick={() => setTab(next)}>{next === 'Music settings' ? <Settings2 size={17} aria-hidden="true"/> : null}{t(next)}{next === 'Queue' && queued.length > 0 && <small>{formatNumber(queued.length)}</small>}</button>)}</nav>
            {tab === 'Library' && <MusicLibrary data={data} busy={busy} command={command} listening={listening} playlists={() => setTab("Playlists")}/>}
            {tab === 'Queue' && <MusicQueue data={data} busy={busy} command={command} account={account}/>}
            {tab === 'Playlists' && <MusicPlaylists data={data} busy={busy} command={command}/>}
            {tab === 'Community' && <MusicCommunity route={route} data={data} queue={command}/>}
            {tab === 'Music settings' && <MusicSettings key={JSON.stringify(state.policy)} data={data} busy={busy} command={command} listening={listening}/>}
          </section>
        </div>
      </> : <p role={error ? 'alert' : 'status'} className="music-feedback">{error || t('Loading music…')}</p>}
    </div>
  </dialog>;
}

const msg = (cause: unknown) => t(cause instanceof Error ? cause.message : 'Music is temporarily unavailable.');

function TrackRow({ track, subtitle, children }: { track: MusicTrack; subtitle?: ReactNode; children?: ReactNode }) {
  return <div className="music-track-row">
    <MusicAvatar track={track}/><div className="music-track-text"><strong><bdi>{track.title}</bdi>{track.explicit && <span className="music-explicit" title={t('Explicit')}>E</span>}</strong>
      <small><bdi>{track.artist}</bdi>{subtitle}</small></div>
    <span className="music-duration" dir="ltr">{track.live ? t('Live') : time(track.duration)}</span>
    {children && <div className="music-row-actions">{children}</div>}
  </div>;
}

function MusicLibrary({ data, busy, listening, command, playlists }: { playlists: () => void; data: MusicData; busy: boolean; listening: MusicListening; command: Command }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('All tracks');
  const clean = (value: string) => normalizePeopleSearch(value).normalize('NFD').replace(/\p{M}/gu, '');
  const text = clean(query.trim());
  const tracks = data.library.filter(track => (filter === 'All tracks' || filter === 'Favorites' && listening.favorites.includes(track.id) || filter === 'Radio' && track.live)
    && (!text || clean([track.title, track.artist, track.album].join(' ')).includes(text)
      || track.id.toLowerCase() === query.trim().toLowerCase()));
  const official = data.state.playlists?.find(list => list.original);
  const album = text ? data.library.filter(track => track.album && clean(track.album) === text) : [];
  const allowed = !busy && data.canRequest && !data.state.policy.disabled;
  const play = data.state.policy.mode === 'approval' && !data.canDJ ? 'Request track' : data.state.current ? 'Add to queue' : 'Play track';
  return <div className="music-pane">
    {official && !text && filter === 'All tracks' && <div className="music-official">
      <MusicAvatar/>
      <button className="music-track-text" type="button" onClick={playlists}><strong><bdi>{t(official.name)}</bdi></strong><small>{t('Official playlist')}</small></button>
      {data.canRequest && <button className="secondary" type="button" disabled={!allowed || !official.tracks?.length} onClick={() => void command('import', { playlist: official.id })}><Play size={15}/>{t(data.state.current ? 'Add to queue' : 'Play playlist')}</button>}
    </div>}
    <div className="music-search"><Search size={18} aria-hidden="true"/><input aria-label={t('Search music')} placeholder={t('Search by title, artist, or album')} value={query} onChange={event => setQuery(event.target.value)}/></div>
    <div className="music-filter">{(['All tracks', 'Favorites', 'Radio'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(value)}</button>)}</div>
    {album.length > 1 && allowed && <div className="music-filter"><button onClick={() => void command('import', { tracks: album.map(track => track.id) })}><ListMusic size={16}/>{t('Add album')}</button></div>}
    {!tracks.length && <p className="music-empty">{t(text ? 'No tracks match your search.' : 'There are no tracks here yet.')}</p>}
    <div className="music-list">{tracks.map(track => <TrackRow key={track.id} track={track} subtitle={track.album ? <> · <bdi>{track.album}</bdi></> : undefined}>
      <MusicIcon label={listening.favorites.includes(track.id) ? 'Remove from favorites' : 'Add to favorites'} pressed={listening.favorites.includes(track.id)} onClick={() => listening.favorite(track.id)}><Heart size={17}/></MusicIcon>
      {data.canDJ && data.state.current && <MusicIcon label="Play next" disabled={!allowed} onClick={() => void command('add', { track: track.id, next: true })}><SkipForward size={17}/></MusicIcon>}
      {data.canRequest && <MusicIcon label={play} disabled={!allowed} onClick={() => void command('add', { track: track.id })}>{data.state.current ? <Plus size={19}/> : <Play size={17}/>}</MusicIcon>}
    </TrackRow>)}</div>
  </div>;
}

function MusicQueue({ data, busy, account, command }: { data: MusicData; busy: boolean; account: string; command: Command }) {
  const state = data.state;
  const list = state.queue || [], pending = state.pending || [];
  const [clearing, setClearing] = useState(false);
  const [dragged, setDragged] = useState('');
  const duration = state.current?.track.live || list.some(entry => entry.track.live) ? -1 : list.reduce((total, entry) => total + entry.track.duration, 0);
  const repeat = state.repeat === 'off' ? 'track' : state.repeat === 'track' ? 'queue' : 'off';
  const indexOf = (entry: MusicEntry) => list.findIndex(value => value.id === entry.id);
  const move = (entry: string, index: number) => void command('move', { entry, index, revision: state.revision });
  return <div className="music-pane">
    <div className="music-section-heading"><h3>{t('Up next')}</h3><small>{t(list.length === 1 ? '{count} track' : '{count} tracks', {count: formatNumber(list.length)})}{duration > 0 && <> · <bdi>{time(duration)}</bdi></>}</small></div>
    {data.canDJ && <div className="music-filter">
      <button disabled={busy || list.length < 2} onClick={() => void command('shuffle')}><Shuffle size={15}/>{t('Shuffle')}</button>
      {data.canUnshuffle && <button disabled={busy} onClick={() => void command('unshuffle')}>{t('Undo shuffle')}</button>}
      <button aria-pressed={state.repeat !== 'off'} disabled={busy} onClick={() => void command('repeat', { value: repeat })}>{state.repeat === 'track' ? <Repeat1 size={15}/> : <Repeat size={15}/>} {t(state.repeat === 'off' ? 'Repeat off' : state.repeat === 'track' ? 'Repeat track' : 'Repeat queue')}</button>
      {!clearing && <button disabled={busy || !list.length} onClick={() => setClearing(true)}>{t('Clear queue')}</button>}
      {clearing && <><button disabled={busy} onClick={() => void command('clear').then(ok => { if (ok) setClearing(false); })}>{t('Confirm clear')}</button><button onClick={() => setClearing(false)}>{t('Cancel')}</button></>}
      {data.canUndo && <button disabled={busy} onClick={() => void command('undo')}>{t('Restore queue')}</button>}
    </div>}
    {!list.length && <p className="music-empty">{t('The next track you add will appear here.')}</p>}
    <div className="music-list">{list.map(entry => <div key={entry.id} draggable={data.canDJ && !busy} className={dragged === entry.id ? 'music-dragging' : undefined} onDragStart={event => { event.dataTransfer.setData('text/plain', entry.id); setDragged(entry.id); }} onDragEnd={() => setDragged('')} onDragOver={event => { if (dragged && data.canDJ) event.preventDefault(); }} onDrop={event => { if (dragged && dragged !== entry.id && data.canDJ) { event.preventDefault(); move(dragged, indexOf(entry)); } setDragged(''); }}>
      <TrackRow track={entry.track} subtitle={<> · {t('Requested by {name}', { name: entry.name })}</>}>
        {data.canDJ && <><MusicIcon label="Move up" disabled={busy || indexOf(entry) === 0} onClick={() => move(entry.id, indexOf(entry) - 1)}><ArrowUp size={16}/></MusicIcon><MusicIcon label="Move down" disabled={busy || indexOf(entry) === list.length - 1} onClick={() => move(entry.id, indexOf(entry) + 1)}><ArrowDown size={16}/></MusicIcon></>}
        {(data.canDJ || account === entry.requester) && <MusicIcon label="Remove track" disabled={busy} onClick={() => void command('remove', { entry: entry.id })}><Trash2 size={16}/></MusicIcon>}
      </TrackRow>
    </div>)}</div>
    {!!pending.length && <><div className="music-section-heading"><h3>{t('Pending requests')}</h3></div><div className="music-list">{pending.map(entry => <TrackRow track={entry.track} key={entry.id} subtitle={<> · {t('Requested by {name}', { name: entry.name })}</>}>
      {data.canDJ && <MusicIcon label="Approve request" disabled={busy} onClick={() => void command('approve', { entry: entry.id })}><Check size={17}/></MusicIcon>}
      <MusicIcon label={data.canDJ ? 'Reject request' : 'Withdraw request'} disabled={busy} onClick={() => void command(data.canDJ ? 'reject' : 'remove', { entry: entry.id, pending: true })}><X size={17}/></MusicIcon>
    </TrackRow>)}</div></>}
    {!!state.history?.length && <details className="music-history"><summary>{t('Recently played')}</summary><div className="music-list">{state.history.map((entry, index) => <TrackRow track={entry.track} key={entry.id + index}><MusicIcon label="Add to queue" disabled={busy || !data.canRequest} onClick={() => void command('add', { track: entry.track.id })}><Plus size={17}/></MusicIcon></TrackRow>)}</div></details>}
  </div>;
}

function MusicPlaylists({ data, busy, command }: { data: MusicData; busy: boolean; command: Command }) {
  const [edit, setEdit] = useState<MusicPlaylist | 'new'>();
  const [view, setView] = useState('');
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [collaborative, setCollaborative] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [currentQueue, setCurrentQueue] = useState(false);
  const playlists = data.state.playlists || [];
  const openEditor = (list: MusicPlaylist | 'new') => {
    setEdit(list); setName(list === 'new' ? '' : list.name); setShared(list !== 'new' && list.shared);
    setCollaborative(list !== 'new' && list.collaborative); setSelected(list === 'new' ? [] : list.tracks || []); setCurrentQueue(false);
  };
  const toggle = (id: string) => setSelected(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!edit) return;
    const payload = edit === 'new' ? { name, shared, collaborative: shared && collaborative, tracks: selected, queue: currentQueue } : { playlist: edit.id, ...(edit.manageable ? { name } : {}), tracks: selected };
    void command(edit === 'new' ? 'savePlaylist' : 'updatePlaylist', payload).then(ok => { if (ok) setEdit(undefined); });
  }
  return <div className="music-pane">
    <div className="music-section-heading"><h3>{t('Playlists')}</h3>{data.canRequest && <button className="secondary" type="button" onClick={() => openEditor('new')}><Plus size={15}/>{t('New playlist')}</button>}</div>
    {edit && <form className="music-form" onSubmit={submit}>
      {(edit === 'new' || edit.manageable) && <label>{t('Playlist name')}<input required maxLength={60} value={name} onChange={event => setName(event.target.value)}/></label>}
      {edit === 'new' && <>
        {data.canDJ && <><label className="music-checkbox"><input type="checkbox" checked={shared} onChange={event => setShared(event.target.checked)}/>{t('Share with the voice channel')}</label>{shared && <label className="music-checkbox"><input type="checkbox" checked={collaborative} onChange={event => setCollaborative(event.target.checked)}/>{t('Allow members to edit tracks')}</label>}</>}
        <label className="music-checkbox"><input type="checkbox" checked={currentQueue} onChange={event => setCurrentQueue(event.target.checked)}/>{t('Save current queue')}</label>
      </>}
      {!currentQueue && <fieldset className="music-choices"><legend>{t('Choose tracks')}</legend>{data.library.map(track => <label className="music-checkbox" key={track.id}><input type="checkbox" checked={selected.includes(track.id)} onChange={() => toggle(track.id)}/><bdi>{track.title}</bdi></label>)}</fieldset>}
      <div className="music-filter"><button disabled={busy || !selected.length && !currentQueue}>{t('Save playlist')}</button><button type="button" onClick={() => setEdit(undefined)}>{t('Cancel')}</button></div>
    </form>}
    {!playlists.length && !edit && <p className="music-empty">{t('Save your favorite tracks or the current queue as a playlist.')}</p>}
    {playlists.map(list => <div className="music-playlist" key={list.id}>
      <div className="music-track-row"><MusicAvatar/><button type="button" className="music-track-text" aria-expanded={view === list.id} onClick={() => { setView(view === list.id ? '' : list.id); setSelected(list.tracks || []); }}><strong><bdi>{list.original ? t(list.name) : list.name}</bdi></strong><small>{t(list.original ? 'Official playlist' : list.shared ? 'Shared' : 'Private')} · {formatNumber(list.tracks?.length || 0)} {t('tracks')}</small></button>
      <div className="music-row-actions">{list.editable && <MusicIcon label="Edit playlist" disabled={busy} onClick={() => openEditor(list)}><Settings2 size={16}/></MusicIcon>}
      {data.canRequest && <MusicIcon label="Add playlist to queue" disabled={busy || !list.tracks?.length} onClick={() => void command('import', { playlist: list.id })}><ListMusic size={18}/></MusicIcon>}</div></div>
      {view === list.id && !edit && <div className="music-form music-playlist-preview">
        <fieldset className="music-choices"><legend>{t('Choose tracks to add')}</legend>{(list.tracks || []).map((id, index) => <label key={id + index} className="music-checkbox"><input type="checkbox" checked={selected.includes(id)} onChange={() => toggle(id)}/><bdi>{data.library.find(track => track.id === id)?.title || t('Unavailable track')}</bdi></label>)}</fieldset>
        <div className="music-filter">{data.canRequest && <button disabled={busy || !selected.length} onClick={() => void command('import', { playlist: list.id, tracks: selected })}>{t('Add selected tracks')}</button>}{list.manageable && <button disabled={busy} onClick={() => void command('deletePlaylist', { playlist: list.id })}>{t('Delete playlist')}</button>}</div>
      </div>}
    </div>)}
  </div>;
}

function MusicSettings({ data, busy, listening, command }: { data: MusicData; busy: boolean; listening: MusicListening; command: Command }) {
  const [policy, set] = useState(data.state.policy);
  const [roomVolume, setRoomVolume] = useState(data.state.volume);
  function change(key: keyof MusicPolicy, value: string | boolean | number) { set(old => ({ ...old, [key]: value })); }
  const checks = [['disabled', 'Disable music in this channel'], ['fair', 'Rotate requests between listeners'], ['allowUploads', 'Allow audio uploads'], ['allowExplicit', 'Allow explicit tracks'], ['history', 'Keep playback history']] as const;
  const playlists = (data.state.playlists || []).filter(list => list.shared);
  return <div className="music-pane">
    <div className="music-form"><h3>{t('Your listening')}</h3>
      <label className="music-checkbox"><input type="checkbox" checked={listening.startMuted} onChange={event => listening.update({ startMuted: event.target.checked })}/>{t('Start with music muted when joining voice')}</label>
      <label>{t('Lower music while people talk')}<select value={listening.duck} onChange={event => listening.update({ duck: event.target.value as MusicListening['duck'] })}><option value="off">{t('Off')}</option><option value="light">{t('Light')}</option><option value="strong">{t('Strong')}</option></select></label>
      <label>{t('Sleep timer')}<select value="" onChange={event => listening.setSleep(Number(event.target.value) ? Date.now() + Number(event.target.value) * 60000 : 0)}><option value="" disabled>{listening.sleep ? t('Timer active') : t('Off')}</option><option value="0">{t('Turn off timer')}</option>{[15, 30, 60].map(min => <option key={min} value={min}>{t('{count} minutes', { count: formatNumber(min) })}</option>)}</select></label>
    </div>
    {data.canDJ && <div className="music-form"><h3>{t('Room playback')}</h3>
      <label>{t('Room music level')}<input type="range" min={0} max={data.state.policy.maxVolume} value={roomVolume} onChange={event => setRoomVolume(Number(event.target.value))}/><output>{formatNumber(roomVolume)}%</output></label>
      <button type="button" className="secondary" disabled={busy || data.state.policy.disabled || roomVolume === data.state.volume} onClick={() => void command('volume', { value: roomVolume })}>{t('Set room level')}</button>
      <label>{t('Continue with a shared playlist')}<select disabled={busy || data.state.policy.disabled} value={data.state.autoplay || ''} onChange={event => void command('autoplay', { playlist: event.target.value })}><option value="">{t('Off')}</option>{playlists.map(list => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>
    </div>}
    {data.canDJ && <MusicEvents data={data} busy={busy} command={command}/>}
    {data.canManage && <form className="music-form" onSubmit={event => { event.preventDefault(); void command('policy', { ...policy, djRole: policy.djRole || '' }); }}><h3>{t('Channel permissions')}</h3>
      <label>{t('Who can queue music?')}<select value={policy.mode} onChange={event => change('mode', event.target.value)}><option value="open">{t('Members in voice')}</option><option value="dj">{t('DJs only')}</option><option value="approval">{t('Requests require approval')}</option></select></label>
      <label>{t('Additional DJ role')}<select value={policy.djRole || ''} onChange={event => change('djRole', event.target.value)}><option value="">{t('None')}</option>{data.roles?.map(role => <option value={role.id} key={role.id}>{role.name}</option>)}</select></label>
      <label>{t('Maximum room level')}<input type="range" min={10} max={100} value={policy.maxVolume} onChange={event => change('maxVolume', Number(event.target.value))}/><output>{formatNumber(policy.maxVolume)}%</output></label>
      {checks.map(([key, label]) => <label className="music-checkbox" key={key}><input type="checkbox" checked={policy[key]} onChange={event => change(key, event.target.checked)}/>{t(label)}</label>)}
      <button className="secondary" disabled={busy}>{t('Save music settings')}</button>
    </form>}
  </div>;
}


