import { Component, createContext, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import type { PublicUser, VoiceRoom } from '@dorham/contracts';
import { definition, type GameKind, type GameSummary } from '../../../packages/contracts/src/games';
import type { VoiceGame } from '../../../packages/contracts/src/chess';
import { request } from './api';
import { t as tr } from './i18n';
import './games.css';
const GamesHub = lazy(() => import('./GamesHub'));
const Games = createContext<{ room: VoiceRoom | null; games: VoiceGame[]; arcade: GameSummary[]; error: boolean; connected: boolean; launch: (id?: string,kind?:GameKind|'chess') => void; refresh: () => void } | null>(null);
class GameLoadBoundary extends Component<{ children: ReactNode; close: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div role="alert" className="games-load-error"><p>{tr('Games could not load. Close this window and try again, or reload Dorham.')}</p><button onClick={this.props.close}>{tr('Back to chat')}</button><button onClick={() => location.reload()}>{tr('Reload Dorham')}</button></div> : this.props.children; }
}
export function GamesProvider({ me, room, serverId, socket, children }: { me: PublicUser; room: VoiceRoom | null; serverId: string | null; socket: Socket | null; children: ReactNode }) {
  const [games, setGames] = useState<VoiceGame[]>([]), [arcade,setArcade]=useState<GameSummary[]>([]), [error, setError] = useState(false), [opened, setOpened] = useState<{ id?: string;kind?:GameKind|'chess' } | null>(null), [connected, setConnected] = useState(Boolean(socket?.connected));
  const returnFocus=useRef<HTMLElement|null>(null);
  const close=()=>{setOpened(null);requestAnimationFrame(()=>returnFocus.current?.focus());};
  const generation = useRef(0), channelId = room?.channelId || null;
  const refresh = useCallback(async () => {
    const version = ++generation.current; if (!channelId) { setGames([]);setArcade([]); return; }
    try { const result = await request<{games:GameSummary[];chess:VoiceGame[]}>(`/games?channelId=${encodeURIComponent(channelId)}`); if (generation.current === version) { setGames(result.chess);setArcade(result.games); setError(false); } }
    catch { if (generation.current === version) { setGames([]);setArcade([]); setError(true); } }
  }, [channelId]);
  useEffect(() => { setGames([]);setArcade([]); setError(false); void refresh(); return () => { generation.current++; }; }, [refresh]);
  useEffect(() => {
    const change = (e: { channelId?: string; directoryChanged?: boolean }) => { if ((!e.channelId || e.channelId === channelId) && e.directoryChanged !== false) void refresh(); };
    const connect = () => { setConnected(true); void refresh(); }, disconnect = () => setConnected(false);
    setConnected(Boolean(socket?.connected)); socket?.on('chess:changed', change); socket?.on('game:changed',change); socket?.on('connect', connect); socket?.on('disconnect', disconnect);
    return () => { socket?.off('chess:changed', change);socket?.off('game:changed',change); socket?.off('connect', connect); socket?.off('disconnect', disconnect); };
  }, [socket, channelId, refresh]);
  return <Games.Provider value={{ room, games, arcade, error, connected, launch: (id,kind) => {returnFocus.current=document.activeElement as HTMLElement;setOpened(id ? { id,kind:kind||'chess' } : {});}, refresh: () => { void refresh(); } }}>{children}{opened && <GameLoadBoundary close={close}><Suspense fallback={<div className="games-load-error" role="status">{tr('Loading games…')}<button onClick={close}>{tr('Back to chat')}</button></div>}><GamesHub me={me} room={room} serverId={serverId} initialGameId={opened.id || null} initialKind={opened.kind||null} arcade={arcade} socket={socket} connected={connected} games={games} close={close}/></Suspense></GameLoadBoundary>}</Games.Provider>;
}
export function GamesButton() {
  const g = useContext(Games); if (!g) return null;
  return <button type="button" className="games-launch-button" disabled={!g.room || !g.connected} onClick={() => g.launch()}><span aria-hidden="true">♟</span>{tr('Games')}</button>;
}
export function VoiceGames({ channelId }: { channelId: string }) {
  const g = useContext(Games); if (!g || g.room?.channelId !== channelId) return null;
  return <div className="voice-games" aria-label={tr('Voice channel games')}>{g.error ? <button className="voice-game-entry" onClick={g.refresh}>{tr('Games unavailable. Retry')}</button> : <>{g.games.map(game => <button className="voice-game-entry" aria-label={game.legacy ? tr("Resume your game") : tr("Join {name}'s game", { name: game.hostName })} key={game.id} disabled={!g.connected} onClick={() => g.launch(game.id)}><span className="voice-game-icon" aria-hidden="true">♟</span><span><strong>{game.legacy ? tr("Resume your game") : tr("Join {name}'s game", { name: game.hostName })}</strong><small>{tr('Chess')} · {tr(game.paused ? 'Reconnecting' : game.openSeat ? 'Seat open' : 'Watch game')}</small></span></button>)}{g.arcade.map(game=><button className="voice-game-entry" key={game.id} aria-label={tr("Join {name}'s game",{name:game.hostName})} disabled={!g.connected} onClick={()=>g.launch(game.id,game.kind)}><span className="voice-game-icon" aria-hidden="true">{definition(game.kind).icon}</span><span><strong>{tr("Join {name}'s game",{name:game.hostName})}</strong><small>{tr(definition(game.kind).name)} · {tr('{joined}/{max} joined',{joined:game.players,max:game.maxPlayers})} · {tr(game.paused?'Reconnecting':game.status==='waiting'?'Seats open':'Watch game')}</small></span></button>)}</>}</div>;
}
