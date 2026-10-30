import { Component, createContext, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import type { PublicUser, VoiceRoom } from '@dorham/contracts';
import type { VoiceGame } from '../../../packages/contracts/src/chess';
import { request } from './api';
import { t as tr } from './i18n';
import './games.css';
const ChessRoom = lazy(() => import('./ChessRoom'));
const Games = createContext<{ room: VoiceRoom | null; games: VoiceGame[]; error: boolean; connected: boolean; launch: (id?: string) => void; refresh: () => void } | null>(null);
class GameLoadBoundary extends Component<{ children: ReactNode; close: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div role="alert" className="games-load-error"><p>{tr('Games could not load. Close this window and try again, or reload Dorham.')}</p><button onClick={this.props.close}>{tr('Back to chat')}</button><button onClick={() => location.reload()}>{tr('Reload Dorham')}</button></div> : this.props.children; }
}
export function GamesProvider({ me, room, serverId, socket, children }: { me: PublicUser; room: VoiceRoom | null; serverId: string | null; socket: Socket | null; children: ReactNode }) {
  const [games, setGames] = useState<VoiceGame[]>([]), [error, setError] = useState(false), [opened, setOpened] = useState<{ id?: string } | null>(null), [connected, setConnected] = useState(Boolean(socket?.connected));
  const generation = useRef(0), channelId = room?.channelId || null;
  const refresh = useCallback(async () => {
    const version = ++generation.current; if (!channelId) { setGames([]); return; }
    try { const result = await request<{ games: VoiceGame[] }>(`/chess?channelId=${encodeURIComponent(channelId)}`); if (generation.current === version) { setGames(result.games); setError(false); } }
    catch { if (generation.current === version) { setGames([]); setError(true); } }
  }, [channelId]);
  useEffect(() => { setGames([]); setError(false); void refresh(); return () => { generation.current++; }; }, [refresh]);
  useEffect(() => {
    const change = (e: { channelId?: string; directoryChanged?: boolean }) => { if ((!e.channelId || e.channelId === channelId) && e.directoryChanged !== false) void refresh(); };
    const connect = () => { setConnected(true); void refresh(); }, disconnect = () => setConnected(false);
    setConnected(Boolean(socket?.connected)); socket?.on('chess:changed', change); socket?.on('connect', connect); socket?.on('disconnect', disconnect);
    return () => { socket?.off('chess:changed', change); socket?.off('connect', connect); socket?.off('disconnect', disconnect); };
  }, [socket, channelId, refresh]);
  return <Games.Provider value={{ room, games, error, connected, launch: id => setOpened(id ? { id } : {}), refresh: () => { void refresh(); } }}>{children}{opened && <GameLoadBoundary close={() => setOpened(null)}><Suspense fallback={<div className="games-load-error" role="status">{tr('Loading games…')}<button onClick={() => setOpened(null)}>{tr('Back to chat')}</button></div>}><ChessRoom me={me} room={room} serverId={serverId} initialGameId={opened.id || null} socket={socket} connected={connected} games={games} close={() => setOpened(null)}/></Suspense></GameLoadBoundary>}</Games.Provider>;
}
export function GamesButton() {
  const g = useContext(Games); if (!g) return null;
  return <button type="button" className="games-launch-button" disabled={!g.room || !g.connected} onClick={() => g.launch()}><span aria-hidden="true">♟</span>{tr('Games')}</button>;
}
export function VoiceGames({ channelId }: { channelId: string }) {
  const g = useContext(Games); if (!g || g.room?.channelId !== channelId) return null;
  return <div className="voice-games" aria-label={tr('Voice channel games')}>{g.error ? <button className="voice-game-entry" onClick={g.refresh}>{tr('Games unavailable. Retry')}</button> : g.games.map(game => <button className="voice-game-entry" aria-label={game.legacy ? tr("Resume your game") : tr("Join {name}'s game", { name: game.hostName })} key={game.id} disabled={!g.connected} onClick={() => g.launch(game.id)}><span className="voice-game-icon" aria-hidden="true">♟</span><span><strong>{game.legacy ? tr("Resume your game") : tr("Join {name}'s game", { name: game.hostName })}</strong><small>{tr('Chess')} · {tr(game.paused ? 'Reconnecting' : game.openSeat ? 'Seat open' : 'Watch game')}</small></span></button>)}</div>;
}
