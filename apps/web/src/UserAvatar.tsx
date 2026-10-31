import type { PublicUser } from '@dorham/contracts';
import { assetUrl } from './api';
export function Avatar({ user, online = false, small = false }: { user: PublicUser; online?: boolean; small?: boolean }) {
  return <span className={`avatar ${small ? 'small' : ''}`} style={{ backgroundColor: `hsl(${[...user.id].reduce((n, c) => n + c.charCodeAt(0), 0) % 360} 26% 35%)` }}>
    {user.avatar ? <img crossOrigin="anonymous" src={assetUrl(user.avatar)} alt=""/> : user.displayName.slice(0, 2).toUpperCase()}
    {online && <i className={`status-dot ${user.status}`}/>}
  </span>;
}
