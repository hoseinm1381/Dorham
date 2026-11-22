import { useEffect, useState } from 'react';
import type { MediaTransport } from '@dorham/media';
import type { VoiceRoom } from '@dorham/contracts';
import { speakingStore } from './LiveStatus';

export const MUSIC_ID = 'dorham-music';
export const MUSIC_DEFAULT_VOLUME = 30;

export type MusicTrack = { id: string; title: string; artist: string; album?: string; duration: number; live?: boolean; explicit?: boolean; source: 'library' | 'upload' | 'radio' | 'link' };
export type MusicEntry = { id: string; track: MusicTrack; requester: string; name: string };
export type MusicPlaylist = { id: string; name: string; shared: boolean; collaborative: boolean; original?: boolean; editable: boolean; manageable: boolean; tracks: string[] | null };
export type MusicPolicy = { disabled: boolean; mode: 'open' | 'dj' | 'approval'; fair: boolean; allowExplicit: boolean; allowUploads: boolean; history: boolean; maxVolume: number; djRole?: string };
export type MusicState = {
  revision: number; events?: { id: string; title: string; at: number; playlist: string }[];
  current: MusicEntry | null;
  queue: MusicEntry[] | null;
  pending: MusicEntry[] | null;
  history: MusicEntry[] | null;
  playlists: MusicPlaylist[] | null;
  position: number;
  status: 'idle' | 'playing' | 'paused' | 'buffering' | 'error';
  disconnected?: boolean;
  repeat: 'off' | 'track' | 'queue';
  volume: number;
  lowBandwidth?: boolean;
  autoplay?: string;
  policy: MusicPolicy;
  message?: string;
};
export type MusicData = { state: MusicState; library: MusicTrack[]; roles: { id: string; name: string }[] | null; serverDeafened?: boolean; canDJ: boolean; canModerate: boolean; canManage: boolean; canRequest: boolean; canUpload: boolean; canVote: boolean; canUndo: boolean; canUnshuffle: boolean; votes: number; skipThreshold: number; voted: boolean };
type Listening = { level: number; restore: number; startMuted: boolean; duck: 'off' | 'light' | 'strong'; favorites: string[] };
const defaults: Listening = { level: MUSIC_DEFAULT_VOLUME, restore: MUSIC_DEFAULT_VOLUME, startMuted: false, duck: 'off', favorites: [] };

function readListening(account: string | null): Listening {
  try { return account ? { ...defaults, ...JSON.parse(localStorage.getItem('dorham.music.' + account) || '{}') } : defaults; } catch { return defaults; }
}
export function initialMusicLevel(account: string) {
  const preferences = readListening(account);
  return preferences.startMuted ? 0 : preferences.level;
}

export function useMusicListening(account: string | null, room: VoiceRoom | null, media: React.RefObject<MediaTransport | null>) {
  const [preferences, setPreferences] = useState(() => readListening(account));
  const [sessionMute, setSessionMute] = useState(false);
  const [sleep, setSleep] = useState(0);
  const channel = room?.channelId;
  useEffect(() => { setPreferences(readListening(account)); setSleep(0); }, [account]);
  useEffect(() => { setSessionMute(readListening(account).startMuted); }, [channel, account]);
  useEffect(() => {
    if (!sleep) return;
    const timer = setTimeout(() => { setSessionMute(true); setSleep(0); }, Math.max(0, sleep - Date.now()));
    return () => clearTimeout(timer);
  }, [sleep]);
  function update(value: Partial<Listening>) {
    const next = { ...preferences, ...value };
    setPreferences(next);
    if (account) { try { localStorage.setItem('dorham.music.' + account, JSON.stringify(next)); } catch { /* playback can continue without storage */ } }
  }
  function changeLevel(level: number) {
    setSessionMute(false);
    update({ level, restore: level || preferences.restore });
    media.current?.setVolume(MUSIC_ID, level / 100);
  }
  const level = sessionMute ? 0 : preferences.level;
  useEffect(() => {
    if (!room?.musicAvailable) return;
    let release: ReturnType<typeof setTimeout> | undefined;
    const factor = preferences.duck === 'strong' ? .24 : .52;
    const set = (value: number) => media.current?.setVolume(MUSIC_ID, value / 100);
    const onSpeech = () => {
      clearTimeout(release);
      const speaking = speakingStore.snapshot();
      if (room.members.some(member => member.user.id !== MUSIC_ID && speaking[member.user.id])) set(level * factor);
      else release = setTimeout(() => set(level), 340);
    };
    set(level);
    if (preferences.duck === 'off' || !level) return;
    onSpeech();
    const stop = speakingStore.subscribeAll(onSpeech);
    return () => { clearTimeout(release); stop(); };
  }, [room, level, media, preferences.duck]);
  return {
    ...preferences, level, sleep, setSleep, update, changeLevel,
    toggle: () => changeLevel(level ? 0 : preferences.restore),
    favorite: (id: string) => update({ favorites: preferences.favorites.includes(id) ? preferences.favorites.filter(value => value !== id) : [id, ...preferences.favorites].slice(0, 200) }),
  };
}
export type MusicListening = ReturnType<typeof useMusicListening>;
