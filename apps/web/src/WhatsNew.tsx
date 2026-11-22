import { useEffect, useState } from 'react';
import { t } from './i18n';

const platforms = ['Web', 'Android', 'Windows'] as const;
type Platform = typeof platforms[number];
const connectionChanges = ['Recent chats open from this device on a weak connection.', 'Messages you send offline go through when you reconnect.', 'Pause and resume large file transfers.', 'Manage saved messages and media in Storage & Downloads.', 'The simpler music player puts links, search, and the queue within easy reach.'];
const memberVisibility = { version: '1.4.4', notes: ['Space owners can hide people from the member list while keeping their access to voice and chat.'] };
const memberMenu = { version: '1.4.5', notes: ['Space owners can find Hide and Show in the member menu. Right-click a name or press and hold on a touchscreen.'] };
const gameRefresh = { version: '1.4.6', notes: ['Find games by category, follow clearer turns and results, and adjust game sound while you play.'] };
const streamUpdate = { version: '1.4.7', notes: ['See who is watching while you share your screen.', 'Choose 30 FPS for 1080p sharing when a slot is available.', 'Choose from four new color palettes in Appearance.'] };
const weakStream = { version: '1.4.9', notes: ['Screen shares switch to lower quality when your connection is weak, so you can keep watching.'] };
const adaptiveStream = { version: '1.4.10', notes: ['Screen shares adjust picture quality as your connection changes. Sharing uses one video upload.'] };
const organizedSettings = { version: '1.5.0', notes: ['Find account and server settings in organized sections. On phones, open each section from the settings list.', 'Restoring a role’s speaking permission now lets members talk again during the call.'] };
const clearerSettings = { version: '1.5.1', notes: [
  'Assign member tags and custom roles from the same screen.',
  'Scan and edit channels in a more compact list.',
  'Preview five refreshed themes in Appearance.',
  'Find Voice input & hotkeys at the top of Audio settings.',
] };
const changes: Record<Platform, { version: string; notes: string[] }[]> = {
  Web: [
    clearerSettings,
    organizedSettings,
    adaptiveStream,
    weakStream,
    streamUpdate,
    gameRefresh,
    memberMenu,
    memberVisibility,
    { version: '1.4.3', notes: [...connectionChanges, 'The web app loads fewer files when you first open it.', 'Calls give speech priority when your connection gets weak.'] },
    { version: '1.4.1', notes: ['Open Music from the voice controls and paste an audio link right in the player.'] },
    { version: '1.4.0', notes: ['Listen to music together in voice and set your own listening volume.'] },
  ],
  Android: [
    clearerSettings,
    organizedSettings,
    adaptiveStream,
    weakStream,
    streamUpdate,
    gameRefresh,
    memberMenu,
    memberVisibility,
    { version: '1.4.3', notes: [...connectionChanges, 'Short interruptions during sign-in renewal are less likely to sign you out.', 'Screen sharing slows down when your call needs more bandwidth.'] },
    { version: '1.4.1', notes: ['Find Music in the voice controls and play a link from the player.'] },
    { version: '1.4.0', notes: ['Listen to Dorham Music with friends in a voice channel.'] },
  ],
  Windows: [
    { version: '1.5.2', notes: ['Windows screen sharing uses borderless capture and delivers frames while Dorham is in the background.'] },
    clearerSettings,
    organizedSettings,
    adaptiveStream,
    weakStream,
    { version: '1.4.8', notes: ['Share computer sound on Windows 10. The picker explains which sounds will be included before you share.'] },
    { ...streamUpdate, notes: [...streamUpdate.notes, 'The game overlay shows stream viewers and lets you change its opacity.'] },
    gameRefresh,
    memberMenu,
    memberVisibility,
    { version: '1.4.3', notes: [...connectionChanges, 'Short interruptions during sign-in renewal are less likely to sign you out.', 'Screen sharing slows down when your call needs more bandwidth.'] },
    { version: '1.4.1', notes: ['Find Music in the voice controls and play a link from the player.'] },
    { version: '1.4.0', notes: ['Listen to Dorham Music with friends in a voice channel.'] },
    { version: '1.3.1', notes: ['See live previews when choosing a window to share.'] },
  ],
};

declare const __APP_VERSION__: string;
const noticeKey = 'dorham.whats-new-seen';
const seenVersions = new Set<string>();

export function useUpdateNotice(ready: boolean, platform: Platform) {
  const [open, setOpen] = useState(false);
  const version = __APP_VERSION__;
  useEffect(() => {
    if (!ready || seenVersions.has(version)) return;
    try {
      const previous = localStorage.getItem(noticeKey);
      if (previous && previous.localeCompare(version, undefined, { numeric: true }) >= 0) return;
      localStorage.setItem(noticeKey, version);
    } catch { /* Fall back to remembering the notice until the app closes. */ }
    seenVersions.add(version);
    setOpen(true);
  }, [ready, version]);
  return { open: open && ready, close: () => setOpen(false), version, notes: changes[platform].find(release => release.version === version)?.notes ?? ['Dorham was updated.'] };
}

export function WhatsNew({ initial }: { initial: Platform }) {
  const [platform, setPlatform] = useState<Platform>(initial);
  return <section className="settings-form" aria-label={t('What’s new')}>
    <div className="settings-categories" aria-label={t('Platform')}>{platforms.map(name => <button type="button" key={name} aria-pressed={platform === name} onClick={() => setPlatform(name)}>{t(name)}</button>)}</div>
    {changes[platform].map(release => <section key={release.version}><h3>{release.version}</h3><ul>{release.notes.map(note => <li key={note}>{t(note)}</li>)}</ul></section>)}
  </section>;
}
