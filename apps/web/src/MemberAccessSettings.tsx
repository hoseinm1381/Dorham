import { canManage, permissions, type CustomRole, type Permission, type Server, type ServerMember, type Tag } from '@dorham/contracts';
import { ChevronDown, Shield, Tag as TagIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { request } from './api';
import { t } from './i18n';

const permissionLabels: Record<Permission, string> = {
  view: 'View channels', write: 'Send messages', speak: 'Speak in voice', share: 'Share screen',
  moderate: 'Moderate messages and voice', manageChannels: 'Manage channels',
  manageMembers: 'Remove lower-ranked members', createInvites: 'Create and revoke invitations',
};

type AccessKind = 'roles' | 'tags';
type AccessLists = { roles: CustomRole[]; tags: Tag[] };
type Assignment = { kind: AccessKind; userId: string; id: string; assigned: boolean };

function hasAssignment(member: ServerMember | undefined, kind: AccessKind, id: string) {
  const items = kind === 'roles' ? member?.customRoles : member?.user.tags;
  return Boolean(items?.some(item => item.id === id));
}

export function MemberAccessSettings({ server, members, account, instanceAdmin, manageTags, manageRoles, refresh, error }: {
  server: Server;
  members: ServerMember[];
  account: string;
  instanceAdmin?: boolean;
  manageTags: boolean;
  manageRoles: boolean;
  refresh: () => Promise<void>;
  error: (cause: unknown) => void;
}) {
  const [lists, setLists] = useState<AccessLists>({ roles: [], tags: [] });
  const [selectedMember, setSelectedMember] = useState('');
  const [busy, setBusy] = useState(false);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const path = `/servers/${server.id}`;
  const member = members.find(row => row.user.id === selectedMember) ?? members[0];

  useEffect(() => {
    let active = true;
    void Promise.all([
      manageRoles ? request<{ roles: CustomRole[] }>(`${path}/roles`) : { roles: [] },
      manageTags ? request<{ tags: Tag[] }>(`${path}/tags`) : { tags: [] },
    ]).then(([{ roles }, { tags }]) => {
      if (active) setLists({ roles, tags });
    }).catch(cause => { if (active) error(cause); });
    return () => { active = false; };
  }, [path, manageRoles, manageTags]);

  useEffect(() => {
    setAssignments(previous => {
      const pending = previous.filter(change => {
        const row = members.find(current => current.user.id === change.userId);
        return row && hasAssignment(row, change.kind, change.id) !== change.assigned;
      });
      return pending.length === previous.length ? previous : pending;
    });
  }, [members]);

  async function change(kind: AccessKind, body: object, assignment?: Assignment) {
    setBusy(true);
    const different = (change: Assignment) => !assignment ||
      change.kind !== kind || change.userId !== assignment.userId || change.id !== assignment.id;
    if (assignment) setAssignments(previous => [...previous.filter(different), assignment]);
    try {
      await request(`${path}/${kind}`, body);
    } catch (cause) {
      if (assignment) setAssignments(previous => previous.filter(different));
      error(cause);
      setBusy(false);
      return false;
    }
    try {
      if (!assignment) {
        const updated = await request<Partial<AccessLists>>(`${path}/${kind}`);
        setLists(previous => ({ ...previous, ...updated }));
      }
      await refresh();
    } catch (cause) {
      error(cause);
    } finally {
      setBusy(false);
    }
    return true;
  }

  const sections = [
    { kind: 'roles' as const, label: 'Custom roles', empty: 'No custom roles yet', icon: Shield },
    { kind: 'tags' as const, label: 'Member tags', empty: 'No member tags yet', icon: TagIcon },
  ].filter(({ kind }) => kind === 'roles' ? manageRoles : manageTags);

  return <div className="member-access">
    <section className="member-access-card">
      <label>{t('Member')}
        <select aria-label={t('Member')} value={member?.user.id ?? ''} disabled={!member || busy} onChange={event => setSelectedMember(event.target.value)}>
          {!member && <option value="">{t('No members available')}</option>}
          {members.map(row => <option key={row.user.id} value={row.user.id}>{row.user.displayName}</option>)}
        </select>
      </label>
      {member && <div className="member-access-groups" aria-busy={busy}>
        {sections.map(({ kind, label, empty }) => {
          const allowed = kind === 'roles'
            ? !member.user.guest && (server.role === 'owner' || canManage(server.role, member.role))
            : instanceAdmin || account === member.user.id || canManage(server.role, member.role);
          return <div key={kind}>
            <h4>{t(label)}</h4>
            {lists[kind].length === 0 && <p>{t(empty)}</p>}
            <div className="member-access-choices">
              {lists[kind].map(item => {
                const userId = member.user.id;
                const override = assignments.find(row => row.kind === kind && row.userId === userId && row.id === item.id);
                return <label className="member-access-choice" key={item.id}>
                  <input type="checkbox" disabled={busy || !allowed}
                    checked={override?.assigned ?? hasAssignment(member, kind, item.id)}
                    onChange={event => {
                      const assigned = event.target.checked;
                      void change(kind, { [kind === 'roles' ? 'roleId' : 'tagId']: item.id, userId, assigned },
                        { kind, userId, id: item.id, assigned });
                    }}/>
                  <i style={{ backgroundColor: item.color }} aria-hidden="true"/>
                  <bdi>{item.name}</bdi>
                </label>;
              })}
            </div>
          </div>;
        })}
      </div>}
    </section>
    {sections.map(({ kind, icon: Icon }) => <details className="member-access-editor" key={kind}>
      <summary><Icon size={17}/>{t(kind === 'roles' ? 'Manage custom roles' : 'Manage member tags')}<ChevronDown size={16}/></summary>
      <AccessEditor kind={kind} items={lists[kind]} busy={busy} save={body => change(kind, body)}/>
    </details>)}
  </div>;
}

function AccessEditor({ kind, items, busy, save }: {
  kind: AccessKind;
  items: (Tag | CustomRole)[];
  busy: boolean;
  save: (body: object) => Promise<boolean>;
}) {
  const role = kind === 'roles';
  const initialColor = role ? '#9b8aff' : '#a99bff';
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState(initialColor);
  const [values, setValues] = useState<Partial<Record<Permission, boolean>>>({});
  const idKey = role ? 'roleId' : 'tagId';

  function select(id: string) {
    const item = items.find(row => row.id === id);
    setSelected(id);
    setName(item?.name ?? '');
    setColor(item?.color ?? initialColor);
    setValues(item && 'permissions' in item ? item.permissions : {});
  }

  return <form className="member-access-form" onSubmit={event => {
    event.preventDefault();
    if (busy || !name.trim()) return;
    void save({ ...(selected ? { [idKey]: selected } : {}), name: name.trim(), color, ...(role ? { permissions: values } : {}) })
      .then(saved => { if (saved && !selected) select(''); });
  }}>
    <label>{t(role ? 'Edit custom role' : 'Edit tag')}
      <select aria-label={t(role ? 'Edit custom role' : 'Edit tag')} value={selected} disabled={busy} onChange={event => select(event.target.value)}>
        <option value="">{t(role ? 'New role' : 'New tag')}</option>
        {items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    <div className="member-access-fields">
      <label>{t(role ? 'Role name' : 'Tag name')}<input dir="auto" required maxLength={32} value={name} onChange={event => setName(event.target.value)}/></label>
      <label>{t(role ? 'Role color' : 'Tag color')}<input type="color" value={color} onChange={event => setColor(event.target.value)}/></label>
    </div>
    {role && <div className="member-role-permissions">
      {permissions.map(permission => <label className="permission-row" key={permission}>
        {t(permissionLabels[permission])}
        <select aria-label={t(permissionLabels[permission])} value={values[permission] === undefined ? '' : String(values[permission])} onChange={event => {
          const value = event.target.value;
          setValues(previous => {
            const next = { ...previous };
            if (value) next[permission] = value === 'true';
            else delete next[permission];
            return next;
          });
        }}>
          <option value="">{t('Inherit')}</option><option value="true">{t('Allow')}</option><option value="false">{t('Deny')}</option>
        </select>
      </label>)}
    </div>}
    <div className="member-access-actions">
      <button className="primary" disabled={busy || !name.trim()}>{t(role ? (selected ? 'Save role' : 'Create role') : (selected ? 'Save tag' : 'Create tag'))}</button>
      {selected && <button type="button" className="danger-button" disabled={busy} onClick={() => {
        void save({ [idKey]: selected, delete: true }).then(saved => { if (saved) select(''); });
      }}>{t(role ? 'Delete role' : 'Delete tag')}</button>}
    </div>
  </form>;
}
