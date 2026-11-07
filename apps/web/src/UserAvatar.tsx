import type { PublicUser } from '@dorham/contracts';
import { assetUrl } from './api';
import { memo, useState } from 'react';

function AvatarPicture({ source, initials }: { source: string; initials: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? initials : <img src={source} alt="" onError={() => setFailed(true)}/>;
}

export const Avatar = memo(function Avatar({ user, online = false, small = false }: { user: PublicUser; online?: boolean; small?: boolean }) {
  const source = assetUrl(user.avatar), initials = Array.from(user.displayName).slice(0, 2).join('').toUpperCase();
  return <span className={`avatar ${small ? 'small' : ''}`} style={{ backgroundColor: `hsl(${[...user.id].reduce((n, c) => n + c.charCodeAt(0), 0) % 360} 26% 35%)` }}>
    {source ? <AvatarPicture key={source} source={source} initials={initials}/> : initials}
    {user.profileFrame && <img className="profile-frame" src={assetUrl(user.profileFrame)} alt="" loading="lazy"/>}
    {user.profileBadge && <img className="profile-badge-icon" src={assetUrl(user.profileBadge)} alt="" loading="lazy"/>}
    {online && <i className={`status-dot ${user.status}`}/>}
  </span>;
});
