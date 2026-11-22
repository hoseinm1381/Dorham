import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Gamepad2 } from 'lucide-react';
import type { Socket } from 'socket.io-client';
import type { PublicUser, VoiceRoom } from '@dorham/contracts';
import { gameCatalog, isQuickGame, type GameKind, type GameSummary } from '../../../packages/contracts/src/games';
import { gameClientFeature, supportsClientFeature, type ClientFeature } from '../../../packages/contracts/src/client-features';
import type { VoiceGame } from '../../../packages/contracts/src/chess';
import { ClientFeatureNotice } from './ClientFeatureNotice';
import { clientVersion } from './client-version';
import { GameSoundButton, GameSoundSettings, useGameSound } from './game-sound';
import { t } from './i18n';
import './arcade.css';
import './game-catalog.css';

const ChessRoom = lazy(() => import('./ChessRoom'));
const GameRoom = lazy(() => import('./GameRoom'));

type Title = GameKind | 'chess';
type Selection = { kind: Title; id: string | null };
type Props = {
  me: PublicUser;
  room: VoiceRoom | null;
  serverId: string | null;
  socket: Socket | null;
  connected: boolean;
  initialGameId: string | null;
  initialKind: Title | null;
  games: VoiceGame[];
  arcade: GameSummary[];
  clientFeatures: ClientFeature[];
  close: () => void;
  gameAudioSilenced: boolean;
};

const catalogGroups = [
  { label: 'Quick games', theme: 'quick', games: gameCatalog.filter(game => isQuickGame(game.id)) },
  { label: 'Table games', theme: 'table', games: gameCatalog.filter(game => ['chess', 'poker', 'domino', 'ludo', 'four'].includes(game.id)) },
  { label: 'Drawing and words', theme: 'creative', games: gameCatalog.filter(game => ['telephone', 'drawing', 'words'].includes(game.id)) },
] as const;

export function PlayerBadge({ min, max }: { min: number; max: number }) {
  return <span className="game-player-badge">{min === max ? t('{count} players', { count: max }) : t('{min}–{max} players', { min, max })}</span>;
}

export default function GamesHub(props: Props) {
  const sound = useGameSound(props.gameAudioSilenced);
  const [selection, setSelection] = useState<Selection | null>(() => props.initialKind ? { kind: props.initialKind, id: props.initialGameId } : null);
  const dialog = useRef<HTMLDialogElement>(null);
  const catalogScroll = useRef(0);
  const lastCard = useRef<Title | null>(null);
  useEffect(() => {
    if (selection) return;
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    const card = lastCard.current && element.querySelector<HTMLButtonElement>(`[data-game="${lastCard.current}"]`);
    if (card && !card.disabled) card.focus({ preventScroll: true });
    element.scrollTop = catalogScroll.current;
    return () => { element.close(); previous?.focus({ preventScroll: true }); };
  }, [selection]);

  function open(kind: Title, id: string | null) {
    if (dialog.current) catalogScroll.current = dialog.current.scrollTop;
    lastCard.current = id ? null : kind;
    setSelection({ kind, id });
  }

  const backToCatalog = () => setSelection(null);
  if (selection) return <Suspense fallback={<div className="games-load-error" role="status">
    {t('Loading games…')}<button onClick={props.close}>{t('Back to chat')}</button>
  </div>}>
    {selection.kind === 'chess' ? <ChessRoom {...props} sound={sound} initialGameId={selection.id} startInSettings={!selection.id} onCatalog={backToCatalog}/>
      : <GameRoom {...props} sound={sound} kind={selection.kind} initialGameId={selection.id} onCatalog={backToCatalog}/>}
  </Suspense>;

  const updates = props.clientFeatures.filter(feature => !supportsClientFeature(feature, clientVersion));
  function availability(kind: Title) {
    const feature = props.clientFeatures.find(item => item.gameKinds?.includes(kind));
    if (feature && !supportsClientFeature(feature, clientVersion)) return t('App update required');
    if (!feature && gameClientFeature(kind)) return t('Unavailable on this server');
    return '';
  }
  const live = [...props.arcade].sort((a, b) => Number(b.seated) - Number(a.seated) || Number(b.status === 'waiting') - Number(a.status === 'waiting'));

  return <dialog ref={dialog} className="arcade-dialog catalog-dialog" aria-label={t('Games')} onClickCapture={sound.unlock}
    onCancel={event => { event.preventDefault(); props.close(); }}>
    <header className="games-catalog-heading">
      <div className="games-catalog-title"><span className="games-catalog-mark" aria-hidden="true"><Gamepad2 size={23}/></span><h2>{t('Games')}</h2></div>
      <nav className="game-nav">
        <GameSoundButton sound={sound}/><GameSoundSettings sound={sound}/>
        <button className="secondary" onClick={props.close}>{t('Back to chat')}</button>
      </nav>
    </header>
    {!props.connected && <p className="game-error" role="status">{t('Reconnecting. Game controls will return when connected.')}</p>}
    {(live.length > 0 || props.games.length > 0) && <section className="game-live-list" aria-label={t('Games in this voice channel')}>
      <h3>{t('Games in this voice channel')}</h3>
      {live.map(game => <button key={game.id} disabled={!props.connected} onClick={() => open(game.kind, game.id)}>
        <strong>{t(gameCatalog.find(item => item.id === game.kind)!.name)} · <bdi>{game.hostName}</bdi></strong>
        <small>{t('{joined}/{max} joined', { joined: game.players, max: game.maxPlayers })} · {t(game.seated ? 'Resume your game' : game.paused ? 'Reconnecting' : game.status === 'waiting' && game.players < game.maxPlayers ? 'Seats open' : 'Watch game')}</small>
      </button>)}
      {props.games.map(game => {
        const seated = game.whiteId === props.me.id || game.blackId === props.me.id;
        return <button key={game.id} disabled={!props.connected} onClick={() => open('chess', game.id)}>
          <strong>{t(game.mode === 'elixer' ? 'Elixer Chess' : 'Chess')} · <bdi>{game.hostName}</bdi></strong>
          <small>{t(seated ? 'Resume your game' : game.paused ? 'Reconnecting' : game.openSeat ? 'Seat open' : 'Watch game')}</small>
        </button>;
      })}
    </section>}
    {updates.map(feature => <ClientFeatureNotice key={feature.id} feature={feature}/>)}
    <p className="game-catalog-intro">{t('Choose a game to host in this voice channel. Friends can take a seat or watch.')}</p>
    <nav className="game-catalog-links" aria-label={t('Game categories')}>
      {catalogGroups.map(group => <a key={group.theme} href={`#games-${group.theme}`} onClick={event => {
        event.preventDefault();
        const heading = dialog.current?.querySelector<HTMLElement>(`#games-${group.theme}`);
        heading?.focus({ preventScroll: true });
        heading?.scrollIntoView({ block: 'start' });
      }}>{t(group.label)}</a>)}
    </nav>
    {catalogGroups.map(group => <section className={`game-catalog-group theme-${group.theme}`} key={group.theme}>
      <h3 id={`games-${group.theme}`} tabIndex={-1}>{t(group.label)}</h3>
      <div className="arcade-catalog">{group.games.map(game => {
        const unavailable = availability(game.id);
        return <button key={game.id} className="game-catalog-card" data-game={game.id} aria-label={t(game.name)}
          disabled={!props.room || !props.connected || Boolean(unavailable)} onClick={() => open(game.id, null)}>
          <span className="game-catalog-icon" aria-hidden="true">{game.icon}</span>
          <strong>{t(game.name)}</strong>
          <small>{t(game.description)}</small>
          <span className="game-catalog-meta"><PlayerBadge min={game.min} max={game.max}/>
            {game.id === 'chess' && <small>{t('Also playable against AI')}</small>}
          </span>
          {unavailable && <small className="game-availability">{unavailable}</small>}
        </button>;
      })}</div>
    </section>)}
  </dialog>;
}
