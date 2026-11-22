import { useEffect, useState, type RefObject } from 'react';
import { Eye } from 'lucide-react';
import type { Socket } from 'socket.io-client';
import { ack } from '../../../packages/media/src/signaling';
import { formatNumber, t } from './i18n';

type Audience = { shareId: string; viewers: string[] };
const nobody: string[] = [];

export function useStreamAudience(socket: RefObject<Socket | null>, connected: boolean, channel: string | undefined, ownShare: string | undefined, watching: readonly string[]) {
  const [audience, setAudience] = useState<Audience>();
  const watchedKey = JSON.stringify(watching);
  useEffect(() => {
    const connection = socket.current;
    if (!connected || !channel || !connection?.connected) return;
    const watched = JSON.parse(watchedKey) as string[];
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function sync() {
      try {
        const result = await ack<Audience>(connection!, 'share:audience', { watching: watched });
        if (active && ownShare) setAudience(old => old?.shareId === result.shareId && old.viewers.join() === result.viewers.join() ? old : result);
      } catch {
        if (active && ownShare) setAudience(undefined);
      } finally {
        if (active && (ownShare || watched.length)) timer = setTimeout(sync, ownShare ? 3000 : 5000);
      }
    }
    void sync();
    return () => { active = false; clearTimeout(timer); };
  }, [socket, connected, channel, ownShare, watchedKey]);
  return connected && ownShare && audience?.shareId === ownShare ? audience.viewers : nobody;
}

export function StreamAudience({ names }: { names: string[] }) {
  return <details className="stream-audience">
    <summary aria-label={t('Stream viewers') + ' · ' + formatNumber(names.length)}><Eye size={15}/><span>{formatNumber(names.length)}</span></summary>
    <div className="stream-audience-list"><strong>{t('Stream viewers')}</strong>{names.length ? <ul>{names.map((name, index) => <li key={index}><bdi>{name}</bdi></li>)}</ul> : <small>{t('Nobody is watching yet')}</small>}</div>
  </details>;
}
