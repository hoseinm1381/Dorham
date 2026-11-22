import { Music2, HeadphoneOff, LogOut, Volume2, VolumeX } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from './i18n';
import './music.css';

export function MusicVoiceButton({ open }: { open: () => void }) {
  const label = t('Open music player');
  return <button type="button" className="icon-button music-compact" aria-label={label} title={label} aria-haspopup="dialog" onClick={open}><Music2 size={19} aria-hidden="true"/></button>;
}

export function MusicBotRow({ title, active, muted, serverDeafened, open, toggle, remove, removing }: { title?: string; active?: boolean; muted?: boolean; serverDeafened?: boolean; open: () => void; toggle?: () => void; remove?: () => void; removing?: boolean }) {
  return <div className="music-bot-item"><button className="music-bot-row" type="button" onClick={open} onContextMenu={event => { event.preventDefault(); open(); }}>
    <span className="music-art" aria-hidden="true"><Music2 size={18}/></span><span className="music-bot-name"><strong>{t('Dorham Music')} <small>{t('BOT')}</small></strong>{title && <span><bdi>{title}</bdi></span>}</span>
    {serverDeafened && <HeadphoneOff className="music-deafened" size={14} role="img" aria-label={t('Server deafened')}><title>{t('Server deafened. Dorham Music cannot hear voice chat.')}</title></HeadphoneOff>}
    {active && !muted && <span className="music-wave" aria-label={t('Playing')}><i/><i/><i/></span>}
  </button>
    {toggle && <QuickMusicIcon label={muted ? 'Unmute music for me' : 'Mute music for me'} pressed={muted} onClick={toggle}>{muted ? <VolumeX size={15}/> : <Volume2 size={15}/>}</QuickMusicIcon>}
    {remove && <QuickMusicIcon label="Remove music bot from voice" disabled={removing} onClick={remove}><LogOut size={15}/></QuickMusicIcon>}
  </div>;
}

function QuickMusicIcon({ label, children, onClick, disabled, pressed }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean; pressed?: boolean }) {
  return <button type="button" className="music-icon" aria-label={t(label)} title={t(label)} onClick={onClick} disabled={disabled} aria-pressed={pressed}>{children}</button>;
}
