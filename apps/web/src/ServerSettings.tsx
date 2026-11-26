import { canManage, type Channel, type Server, type ServerMember } from '@dorham/contracts';
import { Check, Copy, Hash, LayoutGrid, Link, Plus, Shield, SlidersHorizontal, Trash2, Users, Volume2, X } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { normalizePeopleSearch } from '../../../packages/contracts/src/persian';
import { channelLink } from '../../../packages/contracts/src/links';
import { ChannelPermissions } from './ChannelPermissions';
import { VoicePolicy } from './ExpansionControls';
import { MemberAccessSettings } from './MemberAccessSettings';
import { ServerBanList } from './MemberContextMenu';
import { ServerIconControl } from './ServerIconControl';
import { SettingsDialog, type SettingsGroup } from './SettingsDialog';
import { InvitationManager, MemberInviteSetting } from './SocialControls';
import { Avatar } from './UserAvatar';
import { request, serverUrl } from './api';
import { t } from './i18n';

export type ServerSection = 'overview' | 'channels' | 'permissions' | 'roles' | 'members' | 'invites' | 'bans' | 'moderation-log';
const memberRoles = ['administrator', 'moderator', 'member'] as const;

export function ServerSettings({ server, channels, members, account, instanceAdmin, refresh, error, leave, close, initial, initialKind = 'text', notice }: {
  server: Server;
  channels: Channel[];
  members: ServerMember[];
  account: string;
  instanceAdmin?: boolean;
  refresh: () => Promise<void>;
  error: (error: unknown) => void;
  leave: () => Promise<void>;
  close: () => void;
  initial?: ServerSection;
  initialKind?: 'text' | 'voice';
  notice?: ReactNode;
}) {
  const [name, setName] = useState(server.name);
  const [channelName, setChannelName] = useState('');
  const [kind, setKind] = useState(initialKind);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [kick, setKick] = useState<ServerMember>();
  const [reason, setReason] = useState('');
  const owner = server.ownerId === account;
  const manage = Boolean(server.permissions?.manageChannels);
  const manageRoles = server.role === 'owner' || server.role === 'administrator';
  const manageMembers = Boolean(server.permissions?.manageMembers);
  const actor = members.find(member => member.user.id === account);
  const authority = actor?.authority ?? server.role;
  const groups: SettingsGroup<ServerSection>[] = [
    { label: 'Server', sections: [
      { id: 'overview', label: 'overview', icon: LayoutGrid },
      { id: 'channels', label: 'channels', icon: Hash },
      ...(server.permissions?.createInvites ? [{ id: 'invites' as const, label: 'Invitations', icon: Link }] : []),
    ] },
    { label: 'Community', sections: [
      { id: 'members', label: 'members', icon: Users },
      ...(manage ? [{ id: 'permissions' as const, label: 'permissions', icon: Shield }] : []),
      ...(manage || manageRoles ? [{ id: 'roles' as const, label: 'Roles & tags', icon: Shield }] : []),
      ...(manageMembers ? [{ id: 'bans' as const, label: 'Server bans', icon: Shield }, { id: 'moderation-log' as const, label: 'Moderation log', icon: Shield }] : []),
    ] },
  ];

  async function save(work: () => Promise<unknown>) {
    setBusy(true);
    try { await work(); await refresh(); } catch (cause) { error(cause); } finally { setBusy(false); }
  }
  const serverPath = `/servers/${server.id}`;
  function renderSection(section: ServerSection) {
      switch (section) {
        case 'overview': return <>
          {manage && <ServerIconControl server={server} refresh={refresh} error={error}/>}
          <form onSubmit={event => {
            event.preventDefault();
            void save(() => request(serverPath, { name: name.trim() }, 'PATCH'));
          }}>
            <label>{t('Server name')}<input value={name} onChange={event => setName(event.target.value)} required maxLength={64} disabled={!manage}/></label>
            {manage && <button className="primary" disabled={busy || !name.trim() || name.trim() === server.name}>{t('Save changes')}</button>}
          </form>
          {manage && <label className="check-row"><input type="checkbox" checked={server.allowGuests !== false} disabled={busy}
            onChange={event => { const allowGuests = event.target.checked; void save(() => request(serverPath, { allowGuests }, 'PATCH')); }}/>{t('Allow guests in this server')}</label>}
          {!owner && <details className="danger-zone"><summary>{t('Leave server')}</summary>
            <p>{t('You will need a new invitation to rejoin. Server messages remain for other members.')}</p>
            <button className="danger-button" onClick={() => { void leave().catch(error); }}>{t('Confirm leave server')}</button>
          </details>}
          {owner && <details className="danger-zone"><summary>{t('Delete this server')}</summary>
            <p>{t('This removes its channels, messages, and membership. Type the server name to confirm.')}</p>
            <input aria-label={t('Confirm server name')} value={deleteConfirm} onChange={event => setDeleteConfirm(event.target.value)}/>
            <button className="danger-button" disabled={busy || deleteConfirm !== server.name}
              onClick={() => { void save(() => request(serverPath, { delete: true }, 'PATCH')); }}>{t('Permanently delete server')}</button>
          </details>}
        </>;
        case 'channels': return <>
          {manage && <form className="channel-form" onSubmit={event => {
            event.preventDefault();
            void save(async () => {
              await request(`${serverPath}/channels`, { name: channelName.trim(), kind });
              setChannelName('');
            });
          }}>
            <label>{t('Channel name')}<input required maxLength={64} value={channelName} onChange={event => setChannelName(event.target.value)} placeholder={t('A new conversation')}/></label>
            <label>{t('Type')}<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="text">{t('Text')}</option><option value="voice">{t('Voice')}</option></select></label>
            <button className="primary" disabled={busy || !channelName.trim()}><Plus size={17}/> {t('Add')}</button>
          </form>}
          {(['text', 'voice'] as const).map(type => {
            const group = channels.filter(channel => channel.kind === type);
            return group.length > 0 && <section className="settings-channel-group" key={type}>
              <h4>{t(type === 'text' ? 'TEXT CHANNELS' : 'VOICE LOUNGES')}</h4>
              {group.map(channel => <ChannelEditor key={channel.id} channel={channel} refresh={refresh} error={error}/>)}
            </section>;
          })}
        </>;
        case 'permissions': return <ChannelPermissions channels={channels.filter(channel => channel.permissions.manageChannels)} role={server.role} error={error} refresh={refresh}/>;
        case 'invites': return <>
          {owner && <MemberInviteSetting server={server} refresh={refresh} error={error}/>}
          <InvitationManager serverId={server.id} channels={channels} error={error}/>
        </>;
        case 'roles': return <MemberAccessSettings server={server} members={members} account={account} instanceAdmin={instanceAdmin}
          manageTags={manage} manageRoles={manageRoles} refresh={refresh} error={error}/>;
        case 'bans': return <ServerBanList serverId={server.id} error={error} initiallyOpen/>;
        case 'moderation-log': return <ModerationLog server={server.id}/>;
        case 'members': return <>
          <label>{t('Find a member')}<input type="search" value={memberSearch} onChange={event => setMemberSearch(event.target.value)}/></label>
          {kick && <form className="moderation-confirm" onSubmit={event => {
            event.preventDefault();
            void save(async () => {
              await request(`${serverPath}/members/${kick.user.id}/moderate`, { action: 'kick', reason });
              setKick(undefined); setReason('');
            });
          }}>
            <h4>{t('Kick from server')} · <bdi>{kick.user.displayName}</bdi></h4>
            <p>{t('They will leave this server and voice. An invite lets them rejoin.')}</p>
            <label>{t('Reason (optional)')}<input value={reason} onChange={event => setReason(event.target.value)} maxLength={320}/></label>
            <div><button type="button" className="secondary" disabled={busy} onClick={() => { setKick(undefined); setReason(''); }}>{t('Cancel')}</button> <button className="danger-button" disabled={busy}>{t('Confirm kick')}</button></div>
          </form>}
          {members.filter(member => normalizePeopleSearch(`${member.user.displayName} ${member.user.username}`).includes(normalizePeopleSearch(memberSearch))).map(member => {
          const editable = manageMembers && member.user.id !== account && !member.user.instanceAdmin &&
            canManage(authority, member.authority ?? member.role);
          const assignable = memberRoles.filter(role => canManage(authority, role) && (!member.user.guest || role === 'member'));
          const memberPath = `${serverPath}/members/${member.user.id}`;
          return <div className="manage-member" key={member.user.id}>
            <Avatar user={member.user} small/><span dir="auto">{member.user.displayName}</span>
            {editable && assignable.length > 0 ? <select aria-label={t('Role for {name}', { name: member.user.displayName })} value={member.role} disabled={busy}
              onChange={event => { const role = event.target.value; void save(() => request(memberPath, { role }, 'PATCH')); }}>
              {assignable.map(role => <option value={role} key={role}>{t(role)}</option>)}
            </select> : <small>{t(member.role)}</small>}
            {editable && <button type="button" className="icon-button danger" aria-label={t('Remove {name}', { name: member.user.displayName })}
              disabled={busy} onClick={() => { setReason(''); setKick(member); }}><X size={18}/></button>}
          </div>;
        })}
        </>;
      }
  }
  return <SettingsDialog title={t('Settings for {name}', { name: server.name })} groups={groups} initial={initial} close={close} notice={notice}>
    {section => <div className="manage-server">{renderSection(section)}</div>}
  </SettingsDialog>;
}

type ModerationEntry = { id: string; actor?: string; target?: string; action: string; reason: string; createdAt: number };
const moderationLabels: Record<string, string> = { 'member.kick': 'Kick from server', 'member.ban': 'Ban from server', 'member.unban': 'Unban', 'member.timeout': 'Time out member', 'member.untimeout': 'Remove timeout' };

function ModerationLog({ server }: { server: string }) {
  const [events, setEvents] = useState<ModerationEntry[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void request<{ events: ModerationEntry[] }>(`/servers/${encodeURIComponent(server)}/moderation-log`, undefined, 'GET', true, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setEvents(value.events); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [server]);
  if (error) return <p role="alert">{t(error)}</p>;
  if (!events) return <p role="status">{t('Please wait…')}</p>;
  if (!events.length) return <p>{t('No moderation actions recorded.')}</p>;
  return <ul className="moderation-log">{events.map(event => <li key={event.id}>
    <strong>{t(moderationLabels[event.action] || event.action)}</strong> <bdi>{event.target}</bdi>
    <div><bdi>{event.actor || t('Server')}</bdi> · <time dateTime={new Date(event.createdAt).toISOString()}>{new Date(event.createdAt).toLocaleString()}</time></div>
    {event.reason && <p dir="auto">{event.reason}</p>}
  </li>)}</ul>;
}

function ChannelEditor({ channel, refresh, error }: { channel: Channel; refresh: () => Promise<void>; error: (error: unknown) => void }) {
  const policyId = useId();
  const [draft, setDraft] = useState<string>();
  const [remove, setRemove] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const canEdit = channel.permissions.manageChannels;
  const name = draft ?? channel.name;
  async function change(body: { name: string } | { delete: true }) {
    setBusy(true);
    try {
      await request(`/channels/${channel.id}`, body, 'PATCH');
      await refresh();
      setDraft(undefined);
    } catch (cause) {
      error(cause);
    } finally {
      setBusy(false);
    }
  }
  return <div className="channel-manager-wrap">
    <form className="settings-channel-row" onSubmit={event => { event.preventDefault(); if (canEdit && !busy && name.trim() && name.trim() !== channel.name) void change({ name: name.trim() }); }}>
      {channel.kind === 'text' ? <Hash size={18}/> : <Volume2 size={18}/>}
      <input dir="auto" aria-label={t('Rename {name}', { name: channel.name })} value={name} maxLength={64} required readOnly={!canEdit} disabled={busy} onChange={event => setDraft(event.target.value)}/>
      <div className="settings-channel-actions">
      {canEdit && <>
        <button className="icon-button" title={t('Save {name}', { name: channel.name })} aria-label={t('Save {name}', { name: channel.name })} disabled={busy || !name.trim() || name.trim() === channel.name}><Check size={18}/></button>
        {channel.kind === 'voice' && <button type="button" className="icon-button" title={t('Voice access settings')} aria-label={t('Voice access settings')}
          aria-controls={policyId} aria-expanded={policyOpen} onClick={() => setPolicyOpen(value => !value)}><SlidersHorizontal size={17}/></button>}
        <button type="button" className="icon-button danger" title={t('Delete {name}', { name: channel.name })} aria-label={t('Delete {name}', { name: channel.name })} aria-expanded={remove} disabled={busy}
          onClick={() => setRemove(!remove)}><Trash2 size={17}/></button>
      </>}
      <button type="button" className="icon-button" title={t('Copy channel link')} aria-label={t('Copy channel link')} onClick={() => {
        void navigator.clipboard.writeText(channelLink(serverUrl() || location.origin, channel.serverId, channel.id)).catch(error);
      }}><Copy size={17}/></button>
      </div>
    </form>
    {remove && <div className="settings-delete-channel">
      <button className="secondary" disabled={busy} onClick={() => setRemove(false)}>{t('Cancel')}</button>
      <button className="danger-button" disabled={busy} onClick={() => { void change({ delete: true }); }}>{t('Confirm delete')}</button>
    </div>}
    {canEdit && channel.kind === 'voice' && <div id={policyId} hidden={!policyOpen}>
      {policyOpen && <VoicePolicy key={JSON.stringify([channel.requiredTags, channel.locked, channel.userLimit, channel.tagMode])} channel={channel} refresh={refresh} error={error}/>}
    </div>}
  </div>;
}
