import { useState } from 'react';
import { request } from './api';
import { prepareAvatar } from './avatar';
import { t } from './i18n';
export const defaultAvatars = [
  ['fox', 'Fox'], ['cat', 'Cat'], ['panda', 'Panda'], ['owl', 'Owl'],
  ['frog', 'Frog'], ['bear', 'Bear'], ['rabbit', 'Rabbit'], ['penguin', 'Penguin'],
  ['robot', 'Robot'], ['bot', 'Little bot'], ['cyborg', 'Cyborg'], ['retro', 'Retro robot'],
  ['astronaut', 'Astronaut'], ['alien', 'Alien'], ['planet', 'Ringed planet'], ['comet', 'Comet'],
] as const;
export function AvatarPicker({ saved, error }: { saved: () => Promise<void>; error: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false), [selected, setSelected] = useState(''), [notice, setNotice] = useState('');
  async function upload(file: File, choice = '') {
    if (busy) return; setBusy(true); setNotice('');
    try { const image = await prepareAvatar(file), form = new FormData(); form.set('avatar', image); await request('/profile/avatar', form); await saved(); setSelected(choice); setNotice('Profile picture saved.'); }
    catch (e) { error(e); } finally { setBusy(false); }
  }
  async function choose(id: string) {
    if (busy) return;
    // Bundled first-party pictures use the existing validated upload API, so
    // custom and preset avatars share the same permissions and storage rules.
    setBusy(true); setNotice('');
    try {
      const response = await fetch(`./profile-pictures/${id}.webp`); if (!response.ok) throw Error('Profile picture could not be loaded.');
      const blob = await response.blob(), form = new FormData(); form.set('avatar', new File([blob], `${id}.webp`, { type: 'image/webp' }));
      await request('/profile/avatar', form); await saved(); setSelected(id); setNotice('Profile picture saved.');
    } catch (e) { error(e); } finally { setBusy(false); }
  }
  return <fieldset className="avatar-picker" disabled={busy} aria-busy={busy}><legend>{t('Choose your profile picture')}</legend>
    <div className="avatar-grid">{defaultAvatars.map(([id, name]) => <button key={id} type="button" aria-label={t(name)} aria-pressed={selected === id} onClick={() => { void choose(id); }}><img src={`./profile-pictures/${id}.webp`} alt="" width="80" height="80"/><span>{t(name)}</span></button>)}</div>
    <label className="secondary avatar-custom">{t('Upload your own')}<input aria-label={t('Change avatar')} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(file); }}/></label>
    <small>{t('PNG, JPG or WebP · up to 25 MB · resized automatically')}</small><p role="status">{t(busy ? 'Saving picture…' : notice)}</p>
  </fieldset>;
}
