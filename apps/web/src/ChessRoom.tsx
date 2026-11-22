import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RotateCcw, Swords } from 'lucide-react';
import type { Socket } from 'socket.io-client';
import type { PublicUser, VoiceRoom } from '@dorham/contracts';
import { colorOf, pieceNames, squareName, type ChessAction, type ChessMode, type ChessView, type VoiceGame } from '../../../packages/contracts/src/chess';
import { ChessBoard, chessBoardMotion, chessPieceArt, type BoardMotion } from './ChessBoard';
import { ChessMoveLog, ChessPromotion, ChessRules, ChessSeat, ChessShop, chessMoveLabel } from './ChessDetails';
import { GameSoundButton, GameSoundSettings, useGameCue, type GameSound } from './game-sound';
import { request } from './api';
import { t } from './i18n';
import './chess.css';

type Props = {
  me: PublicUser; room: VoiceRoom | null; serverId: string | null; initialGameId: string | null;
  socket: Socket | null; connected: boolean; games: VoiceGame[]; close: () => void;
  startInSettings?: boolean; onCatalog?: () => void; sound: GameSound;
};
type Frame = { game: ChessView; receivedAt: number; motion?: BoardMotion };
const modeName = (mode: ChessMode) => t(mode === 'elixer' ? 'Elixer Chess' : 'Standard chess');

export default function ChessRoom({ me, room, serverId, initialGameId, socket, connected, games, close,
  startInSettings = false, onCatalog, sound }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const current = useRef<string | null>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  const creation = useRef<{ key: string; id: string }>(null);
  const inFlight = useRef(false);
  const purchaseTrigger = useRef<HTMLButtonElement>(null);
  const [stage, setStage] = useState<'catalog' | 'settings' | 'game'>(initialGameId ? 'game' : startInSettings ? 'settings' : 'catalog');
  const [frame, setFrame] = useState<Frame | null>(null);
  const [sessionType, setSessionType] = useState('people');
  const [mode, setMode] = useState<ChessMode>('standard');
  const [minutes, setMinutes] = useState(10);
  const [increment, setIncrement] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [buy, setBuy] = useState<string | null>(null);
  const [promotion, setPromotion] = useState<ChessAction[]>([]);
  const [flipped, setFlipped] = useState(false);
  const game = frame?.game ?? null;
  const channelId = room?.channelId || null;
  const previousChannel = useRef(channelId);

  const accept = useCallback((next: ChessView, animate: boolean) => {
    if (!alive.current || current.current !== next.id) return;
    const receivedAt = performance.now();
    setFrame(old => {
      const previous = old?.game;
      if (previous?.id === next.id && (previous.revision > next.revision ||
        (previous.revision === next.revision && previous.serverNow >= next.serverNow))) return old;
      const sameMove = previous?.id === next.id && previous.position.ply === next.position.ply;
      const motion = animate ? chessBoardMotion(previous ?? null, next) ?? (sameMove ? old?.motion : undefined) : undefined;
      return { game: next, receivedAt, motion };
    });
  }, []);

  const load = useCallback(async (animate = false) => {
    const id = current.current;
    if (!id) return;
    const version = ++generation.current;
    const view = await request<ChessView>(`/chess/${id}`);
    if (version === generation.current) accept(view, animate);
  }, [accept]);

  const open = useCallback(async (id: string, resetView = true) => {
    current.current = id;
    const version = ++generation.current;
    if (resetView) setFrame(null);
    setStage('game');
    setError('');
    try {
      const view = await request<ChessView>(`/chess/${id}`);
      if (alive.current && version === generation.current) {
        accept(view, false);
      }
    } catch (e: any) {
      if (alive.current && version === generation.current) setError(e.message);
    }
  }, [accept]);

  useEffect(() => {
    const el = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    el.showModal();
    alive.current = true;
    return () => { alive.current = false; generation.current++; el.close(); previous?.focus(); };
  }, []);
  useEffect(() => { if (initialGameId) void open(initialGameId); }, [initialGameId, open]);
  useEffect(() => {
    const report = (e: Error) => { if (alive.current) setError(e.message); };
    const change = (e: { id: string }) => { if (e.id === current.current) void load(true).catch(report); };
    const connect = () => { void load().catch(report); };
    socket?.on('chess:changed', change);
    socket?.on('connect', connect);
    return () => { socket?.off('chess:changed', change); socket?.off('connect', connect); };
  }, [socket, load]);
  useEffect(() => {
    if (previousChannel.current === channelId) return;
    previousChannel.current = channelId;
    generation.current++;
    const matchId = current.current;
    if (matchId) void load().catch(e => {
      if (!alive.current || current.current !== matchId) return;
      setError(e.message);
      if (game && me.id !== game.whiteId && me.id !== game.blackId) {
        setFrame(null);
        current.current = null;
        setStage('catalog');
      }
    });
  }, [channelId, load]);
  useEffect(() => { setSelected(null); setBuy(null); setPromotion([]); }, [game?.id, game?.position.ply, game?.status, game?.pausedUntil, channelId, connected]);
  useEffect(() => { dialog.current?.scrollTo(0, 0); }, [stage, game?.id]);

  async function command(kind: string, action?: ChessAction) {
    if (!game || inFlight.current || !connected) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const view = await request<ChessView>(`/chess/${game.id}`, { kind, revision: game.revision, ...(action ? { action } : {}) });
      accept(view, true);
    } catch (e: any) {
      if (alive.current && current.current === game.id) { setError(e.message); await load().catch(() => {}); }
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function create() {
    if (!channelId || !serverId || inFlight.current || !connected) return;
    const body = { serverId, channelId, ...(sessionType === 'people' ? { openSeat: true } : { difficulty: sessionType }), mode, minutes, increment };
    const key = JSON.stringify(body);
    if (creation.current?.key !== key) creation.current = { key, id: crypto.randomUUID() };
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const view = await request<ChessView>('/chess', { ...body, requestId: creation.current.id });
      if (alive.current) {
        current.current = view.id;
        accept(view, false);
        setStage('game');
        creation.current = null;
      }
    } catch (e: any) {
      if (alive.current) setError(e.message);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const color = game?.whiteId === me.id ? 0 : game?.blackId === me.id ? 1 : undefined;
  useLayoutEffect(() => { setFlipped(color === 1); }, [game?.id, color]);
  const ownTurn = color !== undefined && game?.position.turn === color;
  const canInteract = connected && (!game?.channelId || channelId === game.channelId);
  const canMove = canInteract && game?.status === 'playing' && !game.pausedUntil && ownTurn && !busy;
  const choices = game?.actions.filter(action => buy ? action.buy === buy : action.from === selected && !action.buy) ?? [];
  const ownGame = games.find(item => (item.whiteId === me.id || item.blackId === me.id) && !(item.id === game?.id && game.status === 'finished'));
  const motion = frame?.motion;
  useGameCue(sound, canInteract ? game?.id : undefined, motion?.id, motion?.cue ?? 'move');

  function resetSelection() {
    const trigger = buy ? purchaseTrigger.current : null;
    setBuy(null); setSelected(null); setPromotion([]);
    purchaseTrigger.current = null;
    trigger?.focus();
  }
  function clickSquare(to: number) {
    if (!game || !canMove || promotion.length) return;
    const candidates = choices.filter(action => action.to === to);
    if (candidates.length > 1) { setPromotion(candidates); return; }
    if (candidates.length) { void command('action', candidates[0]); return; }
    const piece = game.position.board[to];
    if (!piece || colorOf(piece) !== color) return;
    setBuy(null);
    setSelected(selected === to ? null : to);
  }
  function boardSquare(square: number) { return dialog.current?.querySelector<HTMLButtonElement>(`[data-square="${squareName(square)}"]`); }
  function choosePiece(piece: string, keyboard: boolean, trigger: HTMLButtonElement) {
    const next = buy === piece ? null : piece;
    setSelected(null);
    setBuy(next);
    purchaseTrigger.current = next ? trigger : null;
    if (!next) return;
    const first = game?.actions.find(action => action.buy === next);
    if (first) requestAnimationFrame(() => {
      const square = boardSquare(first.to);
      if (keyboard) square?.focus();
      else square?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  function cancelPromotion() {
    const destination = promotion[0]?.to;
    setPromotion([]);
    if (destination !== undefined) requestAnimationFrame(() => boardSquare(destination)?.focus());
  }
  function goToCatalog() {
    current.current = null; generation.current++; setFrame(null); setError('');
    if (onCatalog) onCatalog(); else setStage('catalog');
  }
  function playAgain(match: ChessView) {
    setMode(match.position.mode);
    setMinutes(match.minutes);
    setIncrement(match.increment);
    setSessionType(match.difficulty || 'people');
    current.current = null; generation.current++; setFrame(null); setError(''); setStage('settings');
  }

  function currentHint(match: ChessView) {
    if (match.status === 'finished') return t('Play again to open a fresh lobby. Everyone chooses whether to join.');
    if (match.status === 'pending') return match.pausedUntil ? '' : t('The board and clocks stay still until both players are ready.');
    if (color === undefined) return t('Spectating. Watch the board while staying in voice.');
    if (match.pausedUntil) return t('Waiting for disconnected players. Your game clock is paused.');
    if (!canInteract) return '';
    if (busy) return t('Sending your move…');
    if (!ownTurn) return match.difficulty ? t('The computer is thinking…') : t('Waiting for your opponent.');
    if (promotion.length) return t('Choose a piece to finish your move.');
    if (buy) return t('Place your {piece} on a marked home square.', { piece: t(pieceNames[buy]) });
    if (selected !== null && match.position.board[selected]) {
      const piece = t(pieceNames[match.position.board[selected].toLowerCase()]);
      return t(choices.length ? 'Choose a marked square for your {piece}.' : 'Your {piece} has no legal moves.', { piece });
    }
    if (match.check) return t('Your king is in check. Look for a legal move to get it to safety.');
    return t(match.position.mode === 'elixer' ? 'Your turn. Move a piece or buy one from the shop.' : 'Your turn: select a piece, then a marked square.');
  }

  return <dialog ref={dialog} onClickCapture={sound.unlock}
    className={`chess-dialog games-dialog ${stage !== 'game' ? 'games-setup' : ''}`}
    aria-label={t(stage === 'game' ? 'Chess' : 'Games')} onCancel={event => {
      event.preventDefault();
      if (promotion.length) cancelPromotion();
      else if (selected !== null || buy) resetSelection();
      else close();
    }}>
    <div className="chess-shell">
      <header>
        <div>
          <span className="eyebrow">DORHAM · {t('PLAY TOGETHER')}</span>
          <h2>{stage === 'game' && game ? modeName(game.position.mode) : t(stage === 'settings' ? 'Chess settings' : stage === 'catalog' ? 'Games' : 'Chess')}</h2>
        </div>
        <nav className="game-nav"><GameSoundButton sound={sound}/><GameSoundSettings sound={sound}/>
          <button className="secondary" onClick={close}>{t('Back to chat')}</button></nav>
      </header>
      {!connected && <p className="chess-error" role="status">{t('Reconnecting. Game controls will return when connected.')}</p>}
      {!channelId && !game?.channelId && <p role="status">{t('Join a voice channel to create or join a game.')}</p>}
      {game?.channelId && game.channelId !== channelId && <p className="chess-error" role="status">{t('Return to the original voice channel to continue this game.')}</p>}
      {error && <p role="alert" className="chess-error">{t(error)} <button className="secondary" disabled={!connected || busy}
        onClick={() => { if (current.current) void open(current.current, false); else if (stage === 'settings') void create(); }}
      >{t('Retry')}</button></p>}

      {stage === 'catalog' && <div className="games-catalog">
        <p>{t('Choose a game to play together in your current voice channel.')}</p>
        <button className="game-catalog-card" aria-label={t('Chess')} disabled={!channelId || !connected}
          onClick={() => { setError(''); setStage('settings'); }}>
          <span aria-hidden="true">♔</span><strong>{t('Chess')}</strong><small>{modeName('standard')} · {modeName('elixer')}</small>
        </button>
        {ownGame && <button className="secondary" onClick={() => { void open(ownGame.id); }}>{t('Resume your game')}</button>}
      </div>}
      {stage === 'settings' && <form className="games-settings chess-settings" onSubmit={event => { event.preventDefault(); void create(); }}>
        <section className="chess-mode-card">
          <img src={chessPieceArt(mode === 'standard' ? 'K' : 'N')} alt=""/>
          <div><strong>{modeName(mode)}</strong><p>{t(mode === 'standard'
            ? 'Start with a full set of pieces and play for checkmate.'
            : 'Start with only your king. Build your side by buying pieces as you play.')}</p></div>
        </section>
        <label>{t('Game mode')}
          <select aria-label={t('Game mode')} value={mode} disabled={busy} onChange={event => setMode(event.target.value as ChessMode)}>
            <option value="standard">{modeName('standard')}</option><option value="elixer">{modeName('elixer')}</option>
          </select>
        </label>
        <label>{t('Play with')}
          <select aria-label={t('Play with')} value={sessionType} disabled={busy} onChange={event => setSessionType(event.target.value)}>
            <option value="people">{t('People in this voice channel')}</option>
            {['Easy', 'Medium', 'Hard'].map(level => <option key={level} value={level}>{t(`${level} AI`)}</option>)}
          </select>
        </label>
        <div className="chess-time-options">
          <label>{t('Minutes')}<select aria-label={t('Minutes')} disabled={busy} value={minutes}
            onChange={event => setMinutes(Number(event.target.value))}>{[3, 5, 10, 15].map(n => <option key={n}>{n}</option>)}</select></label>
          <label>{t('Increment (seconds)')}<select aria-label={t('Increment (seconds)')} disabled={busy} value={increment}
            onChange={event => setIncrement(Number(event.target.value))}>{[0, 2, 5, 10].map(n => <option key={n}>{n}</option>)}</select></label>
        </div>
        {sessionType === 'people' && <p>{t('This game will appear in your voice channel. People can watch or take the open seat.')}</p>}
        {ownGame ? <button type="button" className="primary" onClick={() => { void open(ownGame.id); }}>{t('Resume your game')}</button>
          : <button className="primary" disabled={busy || !channelId || !connected}>{t(busy ? 'Creating game…' : 'Create game')}</button>}
        <ChessRules mode={mode}/>
        <button type="button" className="secondary" disabled={busy} onClick={goToCatalog}>{t('All games')}</button>
      </form>}

      {stage === 'game' && <section className="chess-play">
        {!game || !frame ? <p role="status">{t(error ? 'Game unavailable. Return to Games or retry.' : 'Loading chess…')}</p>
          : <div className="chess-match-layout">
            <div className={`chess-match-info ${game.status === 'finished' ? 'finished' : ''} ${canMove ? 'your-turn' : ''} ${game.check && game.status === 'playing' ? 'check' : ''}`}>
              <Swords className="chess-status-icon" size={18} aria-hidden="true"/>
              <div className="chess-status-text">
                <div className="chess-status" role="status">
                  {game.result ? t(game.result) : game.status === 'pending'
                    ? t(game.pausedUntil ? 'Waiting for the host to return to voice.' : game.openSeat ? 'Waiting for a player — clocks start when someone presses Play' : 'Waiting for challenge acceptance')
                    : game.pausedUntil ? t('Paused for reconnection — 30 seconds total grace per player')
                      : `${t(game.position.turn === 0 ? 'White to move' : 'Black to move')}${game.check ? ` · ${t('Check')}` : ''}`}
                  {color === undefined && <span> · {t('Spectating')}</span>}
                </div>
                <p className="chess-guidance" aria-live="polite">{currentHint(game)}</p>
              </div>
            </div>
            <div className="chess-score">
              <ChessSeat game={game} color={flipped ? 0 : 1} anchor={frame.receivedAt} sound={sound}
                own={color === (flipped ? 0 : 1)} canWarn={canInteract}/>
              <ChessBoard key={game.id} game={game} flipped={flipped} selected={selected} choices={choices}
                disabled={!canMove || promotion.length > 0} motion={motion} onSquare={clickSquare} clearSelection={resetSelection}/>
              <ChessSeat game={game} color={flipped ? 1 : 0} anchor={frame.receivedAt} sound={sound}
                own={color === (flipped ? 1 : 0)} canWarn={canInteract}/>
            </div>
            <div className="chess-match-controls">
              {promotion.length > 0 && <ChessPromotion choices={promotion} color={game.position.turn} disabled={!canMove}
                choose={action => { void command('action', action); }} cancel={cancelPromotion}/>}
              {game.position.mode === 'elixer' && game.status === 'playing' &&
                <ChessShop game={game} playerColor={color} playable={canMove && !promotion.length} buy={buy} choose={choosePiece}/>}
              {game.drawBy && color !== undefined && game.status === 'playing' && <p className="chess-draw-note" role="status">
                {t(game.drawBy === me.id ? 'Draw offered. Waiting for your opponent.' : 'Your opponent offered a draw.')}
              </p>}
              <div className="chess-actions">
                {game.status === 'finished' && <button className="primary" disabled={busy || !channelId || !connected}
                  onClick={() => playAgain(game)}>{t('Play again')}</button>}
                {color === undefined && game.canPlay && <button className="primary" disabled={busy || !canInteract}
                  onClick={() => { void command('join'); }}>{t('Play')}</button>}
                <button className="secondary" onClick={() => setFlipped(value => !value)}><RotateCcw size={14} aria-hidden="true"/>{t('Flip board')}</button>
                {color !== undefined && game.status === 'pending' && (color === 1 ? <>
                  <button className="primary" disabled={busy || !connected} onClick={() => { void command('accept'); }}>{t('Accept challenge')}</button>
                  <button className="secondary" disabled={busy || !connected} onClick={() => { void command('decline'); }}>{t('Decline')}</button>
                </> : <button className="secondary" disabled={busy || !connected} onClick={() => { void command('cancel'); }}>{t('Cancel challenge')}</button>)}
                {color !== undefined && game.status === 'playing' && <>
                  {game.blackId && (game.drawBy && game.drawBy !== me.id ? <>
                    <button className="secondary" disabled={busy || !canInteract || Boolean(game.pausedUntil)} onClick={() => { void command('acceptDraw'); }}>{t('Accept draw')}</button>
                    <button className="secondary" disabled={busy || !canInteract || Boolean(game.pausedUntil)} onClick={() => { void command('declineDraw'); }}>{t('Decline draw')}</button>
                  </> : <button className="secondary" disabled={busy || !canInteract || Boolean(game.drawBy) || Boolean(game.pausedUntil)}
                    onClick={() => { void command('offerDraw'); }}>{t('Offer draw')}</button>)}
                  {ownTurn && game.canClaimDraw && <button className="secondary" disabled={busy || !canInteract || Boolean(game.pausedUntil)}
                    onClick={() => { void command('claimDraw'); }}>{t('Claim draw')}</button>}
                  <button className="secondary chess-resign" disabled={busy || !connected}
                    onClick={() => { if (window.confirm(t('Resign this match?'))) void command('resign'); }}>{t('Resign')}</button>
                </>}
              </div>
              {game.position.last && <p className="chess-last-move"><span>{t('Last move')}</span><bdi>{chessMoveLabel(game)}</bdi></p>}
              <ChessMoveLog game={game}/>
              <ChessRules mode={game.position.mode}/>
              <button className="secondary chess-back" onClick={goToCatalog}>{t('All games')}</button>
            </div>
          </div>}
        {!game && <button className="secondary" onClick={goToCatalog}>{t('All games')}</button>}
      </section>}
    </div>
  </dialog>;
}
