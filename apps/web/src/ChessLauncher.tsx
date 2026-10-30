import { lazy, Suspense, useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { PublicUser, Server } from '@dorham/contracts';
import { t as tr } from './i18n';
const ChessRoom = lazy(() => import('./ChessRoom'));
export function ChessLauncher({ me, servers, serverId, socket }: { me: PublicUser; servers: Server[]; serverId: string | null; socket: Socket | null }) {
  const [open, setOpen] = useState(false), [incoming, setIncoming] = useState(false);
  useEffect(() => { const changed = (e: { challengeTo: string | null }) => { if (e.challengeTo === me.id) setIncoming(true); }; socket?.on('chess:changed', changed); return () => { socket?.off('chess:changed', changed); }; }, [socket, me.id]);
  return <><button className="server-icon" title={tr('Chess')} aria-label={tr('Chess')} onClick={() => { setIncoming(false); setOpen(true); }}>♟{incoming && <i aria-label={tr('New chess challenge')}/>}</button>{open && <Suspense fallback={<div role="status">{tr('Loading chess…')}</div>}><ChessRoom me={me} servers={servers} serverId={serverId} socket={socket} close={() => setOpen(false)}/></Suspense>}</>;
}
