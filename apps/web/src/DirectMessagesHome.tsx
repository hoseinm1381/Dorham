import { MessageCircle, Plus } from 'lucide-react';
import type { PublicUser } from '@dorham/contracts';
import { assetUrl } from './api';
import { t, currentLanguage } from './i18n';
export type DirectChat = { id: string; user: PublicUser; lastMessageAt?: number };
export function orderedDirectChats<T extends DirectChat>(chats: T[]) {
  return chats.filter(chat => (chat.lastMessageAt || 0) > 0).sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0) || a.id.localeCompare(b.id));
}
export function DirectMessagesHome({ me, chats, open, discover }: { me: PublicUser; chats: DirectChat[]; open: (id: string) => void; discover: () => void }) {
  return <div className="home-content dm-home"><h1>{t('Hey,')} {me.displayName.split(' ')[0]}.</h1>
    <p className="home-lead">{t('Your conversations, latest first.')}</p>
    {!chats.length ? <section className="dm-welcome"><MessageCircle size={56}/><h2>{t('Start a conversation')}</h2><p>{t('To talk to someone, click the + next to Direct messages. Your chats will appear here after the first message.')}</p><button className="primary" onClick={discover}><Plus size={20}/>{t('New direct message')}</button></section> : <><h2>{t('Direct messages')}</h2><div className="people-list">{chats.map(chat => <button className="person-row dm-conversation" key={chat.id} onClick={() => open(chat.id)}><span className="avatar">{chat.user.avatar ? <img crossOrigin="anonymous" src={assetUrl(chat.user.avatar)} alt=""/> : chat.user.displayName.slice(0, 2).toUpperCase()}</span><strong><bdi>{chat.user.displayName}</bdi></strong><time dateTime={new Date(chat.lastMessageAt!).toISOString()}>{new Date(chat.lastMessageAt!).toLocaleString(currentLanguage(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time><MessageCircle size={18}/></button>)}</div><p>{t('To find someone new, use the + next to Direct messages.')}</p></>}
  </div>;
}
