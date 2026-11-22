import { useEffect, useRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { ServerMember } from '@dorham/contracts';
import { RankBadge } from './Features';
import { Tags } from './ExpansionControls';
import { Avatar } from './UserAvatar';
import { t } from './i18n';
import './member-list.css';

type Props = {
  member: ServerMember;
  online: boolean;
  openProfile: () => void;
  menuBindings: Pick<ComponentPropsWithoutRef<'button'>, 'draggable' | 'onDragStart' | 'onDragEnd'> & {
    openMenu: (trigger: HTMLElement, x?: number, y?: number) => void;
  };
  latency?: ReactNode;
  compact?: boolean;
};

export function MemberListRow({ member, online, openProfile, menuBindings, latency, compact }: Props) {
  const { user, role, hiddenFromMemberList } = member;
  const { openMenu, ...dragBindings } = menuBindings;
  const press = useRef<{ timer: number; id: number; x: number; y: number } | undefined>(undefined);
  const ignoreClick = useRef(false);
  function clearPress() {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = undefined;
  }
  useEffect(() => clearPress, []);

  return <button {...dragBindings} draggable={compact ? false : dragBindings.draggable}
      type="button" className="member-row member-list-row" aria-haspopup="menu"
      onClick={() => { if (!ignoreClick.current) openProfile(); ignoreClick.current = false; }}
      onContextMenu={event => {
        event.preventDefault();
        event.stopPropagation();
        if (ignoreClick.current) return;
        if (press.current) { clearPress(); ignoreClick.current = true; }
        openMenu(event.currentTarget, event.clientX || undefined, event.clientY || undefined);
      }}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          openMenu(event.currentTarget);
        }
      }}
      onPointerDown={event => {
        if (!event.isPrimary) return;
        ignoreClick.current = false;
        if (event.pointerType !== 'touch') return;
        clearPress();
        const { currentTarget: trigger, pointerId: id, clientX: x, clientY: y } = event;
        const timer = window.setTimeout(() => {
          press.current = undefined;
          ignoreClick.current = true;
          openMenu(trigger, x, y);
        }, 500);
        press.current = { timer, id, x, y };
      }}
      onPointerMove={event => {
        const current = press.current;
        if (current?.id === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8) clearPress();
      }}
      onPointerUp={clearPress} onPointerCancel={clearPress} onPointerLeave={clearPress}>
      <Avatar user={user} online={online} small/>
      <span>
        <strong><bdi>{user.displayName}</bdi>{!compact && <RankBadge user={user}/>}</strong>
        {hiddenFromMemberList && <span className="member-hidden-tag">{t('Hidden')}</span>}
        {latency}
        <small>{t(compact ? (online ? 'online' : 'offline') : (user.guest ? 'Guest' : role))}</small>
        {!compact && <><Tags tags={user.tags}/>{member.customRoles?.map(r => <span className="role-chip" key={r.id} style={{ borderColor: r.color }}><i style={{ background: r.color }}/>{r.name}</span>)}</>}
      </span>
      {!compact && role === 'owner' && <ShieldCheck size={13}/>}
  </button>;
}
