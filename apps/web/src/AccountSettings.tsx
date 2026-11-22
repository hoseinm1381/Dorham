import { Capacitor } from '@capacitor/core';
import type { PublicUser } from '@dorham/contracts';
import type { MediaTransport } from '@dorham/media';
import { Bell, Check, CircleHelp, Globe, HardDrive, Headphones, LockKeyhole, LogOut, Monitor, Palette, ShieldCheck, UserRound } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AccountControls, GlobalAdministration } from './AccountControls';
import { AppearanceSettings } from './Appearance';
import { AudioSettings } from './AudioSettings';
import { AvatarPicker } from './AvatarPicker';
import { ProfileCatalog } from './Features';
import { SettingsDialog, type SettingsGroup } from './SettingsDialog';
import { AppVersion, BlockedPeople, NotificationSettings } from './SocialControls';
import { StorageSettings } from './StorageSettings';
import { Avatar } from './UserAvatar';
import { WhatsNew } from './WhatsNew';
import { WindowsVoiceOverlaySettings } from './WindowsVoiceOverlay';
import { request } from './api';
import { LanguagePicker, t } from './i18n';

type Section = 'profile' | 'security' | 'privacy' | 'appearance' | 'audio' | 'overlay' | 'notifications' |
  'language' | 'storage' | 'updates' | 'advanced';

export function AccountSettings({ me, blockedUsers, refresh, error, logout, transport, close, notice }: {
  me: PublicUser;
  blockedUsers: PublicUser[];
  refresh: () => Promise<void>;
  error: (error: unknown) => void;
  logout: () => Promise<void>;
  transport: MediaTransport | null;
  close: () => void;
  notice?: ReactNode;
}) {
  const [name, setName] = useState(me.displayName);
  const [bio, setBio] = useState(me.bio);
  const [status, setStatus] = useState(me.status === 'offline' ? 'online' : me.status);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState('');
  useEffect(() => {
    setName(me.displayName);
    setBio(me.bio);
    setStatus(me.status === 'offline' ? 'online' : me.status);
  }, [me.id, me.displayName, me.bio, me.status]);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    try {
      await request('/profile', { displayName: name, bio, status }, 'PATCH');
      await refresh();
      setSaved(true);
    } catch (cause) {
      error(cause);
    } finally {
      setBusy(false);
    }
  }

  const groups: SettingsGroup<Section>[] = [
    { label: 'Account', sections: [
      { id: 'profile', label: 'Profile', icon: UserRound },
      { id: 'security', label: 'Account & security', icon: LockKeyhole },
      { id: 'privacy', label: 'Privacy', icon: ShieldCheck },
    ] },
    { label: 'Preferences', sections: [
      { id: 'appearance', label: 'Appearance', icon: Palette },
      { id: 'audio', label: 'Audio', icon: Headphones },
      ...(window.desktop?.configureOverlay ? [{ id: 'overlay' as const, label: 'Game overlay', icon: Monitor }] : []),
      { id: 'notifications', label: 'Notifications', icon: Bell },
      { id: 'language', label: 'Language', icon: Globe },
      { id: 'storage', label: 'Storage & Downloads', icon: HardDrive },
    ] },
    { label: 'About Dorham', sections: [
      { id: 'updates', label: 'What’s new', icon: CircleHelp },
      ...(!me.guest ? [{ id: 'advanced' as const, label: 'Advanced', icon: ShieldCheck }] : []),
    ] },
  ];

  return <SettingsDialog title={t('Account settings')} groups={groups} close={close} notice={notice} footer={<>
    <button className="logout-button" onClick={() => { void logout().catch(error); }}><LogOut size={17}/> {t('Sign out')}</button>
    <AppVersion/>
  </>}>{section => {
    switch (section) {
      case 'profile': return <div className="settings-form">
        <div className="profile-heading"><Avatar user={me}/><span><strong dir="auto">{me.displayName}</strong>
          {!me.guest && <small dir="ltr">@{me.username}</small>}</span></div>
        {!me.guest && <details className="avatar-options"><summary>{t('Change avatar')}</summary><AvatarPicker avatar={me.avatar} saved={refresh} error={error}/></details>}
        <form className="profile-editor" onSubmit={event => { void saveProfile(event); }}>
          <label>{t('Display name')}<input required maxLength={48} value={name} onChange={event => { setName(event.target.value); setSaved(false); }}/></label>
          <label>{t('About you')}<textarea dir="auto" maxLength={500} value={bio} onChange={event => { setBio(event.target.value); setSaved(false); }} placeholder={t('A little about yourself…')}/></label>
          <label>{t('Status')}<select value={status} onChange={event => { setStatus(event.target.value as typeof status); setSaved(false); }}>
            <option value="online">{t('Online')}</option><option value="idle">{t('Idle')}</option><option value="busy">{t('Do not disturb')}</option>
          </select></label>
          <button className="primary" disabled={busy}>{saved ? <><Check size={17}/> {t('Saved')}</> : t('Save your profile')}</button>
        </form>
        <ProfileCatalog me={me} error={error}/>
      </div>;
      case 'security': return <AccountControls me={me} refresh={refresh} error={error} logout={logout}/>;
      case 'privacy': return <BlockedPeople users={blockedUsers} refresh={refresh} error={error}/>;
      case 'appearance': return <AppearanceSettings/>;
      case 'audio': return <AudioSettings account={me.id} transport={transport} error={error}/>;
      case 'overlay': return <WindowsVoiceOverlaySettings error={error}/>;
      case 'notifications': return <NotificationSettings/>;
      case 'language': return <LanguagePicker save={language => request('/profile', { displayName: me.displayName, bio: me.bio, status: me.status === 'offline' ? 'online' : me.status, language }, 'PATCH').then(refresh).catch(error)}/>;
      case 'storage': return <StorageSettings error={error}/>;
      case 'updates': return <WhatsNew initial={Capacitor.getPlatform() === 'android' ? 'Android' : window.desktop ? 'Windows' : 'Web'}/>;
      case 'advanced': return me.instanceAdmin ? <GlobalAdministration error={error}/> : <details>
        <summary>{t('Instance administration')}</summary>
        <form onSubmit={event => { event.preventDefault(); void request('/admin/claim', { secret }).then(refresh).catch(error); }}>
          <p>{t('Only the deployment operator has this code. It appoints the first global administrator once; it is not your password or an invitation.')}</p>
          <label>{t('One-time administrator setup code')}<input type="password" value={secret} onChange={event => setSecret(event.target.value)}/></label>
          <button className="secondary">{t('Activate global administration')}</button>
        </form>
      </details>;
    }
  }}</SettingsDialog>;
}
