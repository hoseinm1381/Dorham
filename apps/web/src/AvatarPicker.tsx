import { useState } from 'react';
import { Lock } from 'lucide-react';
import { assetUrl, request } from './api';
import { prepareAvatar } from './avatar';
import { useFeatures, type CatalogItem } from './Features';
import { t } from './i18n';
export const defaultAvatars = [
  ['fox', 'Fox'], ['cat', 'Cat'], ['panda', 'Panda'], ['owl', 'Owl'],
  ['frog', 'Frog'], ['bear', 'Bear'], ['rabbit', 'Rabbit'], ['penguin', 'Penguin'],
  ['robot', 'Robot'], ['bot', 'Little bot'], ['cyborg', 'Cyborg'], ['retro', 'Retro robot'],
  ['astronaut', 'Astronaut'], ['alien', 'Alien'], ['planet', 'Ringed planet'], ['comet', 'Comet'],
  ['duck', 'Duck'], ['tiger', 'Tiger'], ['koala', 'Koala'], ['otter', 'Otter'],
  ['red-panda', 'Red panda'], ['axolotl', 'Axolotl'], ['dragon', 'Dragon'], ['jellyfish', 'Jellyfish'],
] as const;
export function AvatarPicker({ avatar, saved, error }: { avatar?: string | null; saved: () => Promise<void>; error: (e: unknown) => void }) {
  const { catalog } = useFeatures();
  const [busy, setBusy] = useState(false), [selected, setSelected] = useState(''), [notice, setNotice] = useState('');
  const catalogAvatar = avatar?.startsWith('/catalog/');
  const packs = new Map<string, CatalogItem[]>();
  for (const item of catalog) {
    if (item.kind !== 'avatar' || !item.active || item.serverId) continue;
    const pack = item.pack || t('Profile catalog');
    const items = packs.get(pack) ?? [];
    if (!items.length) packs.set(pack, items);
    items.push(item);
  }
  async function save(action: () => Promise<unknown>, choice = '') {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      await action();
      await saved();
      setSelected(choice);
      setNotice('Profile picture saved.');
    } catch (e) { error(e); }
    finally { setBusy(false); }
  }
  function selectCatalog(value: string) {
    return request('/features/profile', { kind: 'avatar', value }, 'PUT');
  }
  async function uploadPicture(file: File) {
    const form = new FormData();
    form.set('avatar', file);
    await request('/profile/avatar', form);
    if (catalogAvatar) await selectCatalog('');
  }
  async function upload(file: File, choice = '') {
    await save(async () => uploadPicture(await prepareAvatar(file)), choice);
  }
  async function choose(id: string) {
    // Bundled first-party pictures use the existing validated upload API, so
    // custom and preset avatars share the same permissions and storage rules.
    await save(async () => {
      const response = await fetch(`./profile-pictures/${id}.webp`); if (!response.ok) throw Error('Profile picture could not be loaded.');
      await uploadPicture(new File([await response.blob()], `${id}.webp`, { type: 'image/webp' }));
    }, id);
  }
  return <fieldset className="avatar-picker" disabled={busy} aria-busy={busy}><legend>{t('Choose your profile picture')}</legend>
    <div className="avatar-grid">{defaultAvatars.map(([id, name]) => <button key={id} type="button" aria-label={t(name)} aria-pressed={!catalogAvatar && selected === id} onClick={() => { void choose(id); }}><img src={`./profile-pictures/${id}.webp`} alt="" width="80" height="80" loading="lazy"/><span>{t(name)}</span></button>)}</div>
    {[...packs].map(([pack, items]) => <section className="avatar-pack" key={pack}>
      <h4>{pack}</h4>
      <div className="avatar-grid">{items.map(item => {
        const label = item.usable ? item.label : `${item.label} · ${t('Locked')}`;
        return <button type="button" key={item.id} title={label} aria-label={label} aria-disabled={!item.usable || undefined} aria-pressed={avatar === item.url} onClick={() => { if (item.usable) void save(() => selectCatalog(item.id)); }}>
          <img src={assetUrl(item.url)} alt="" width="80" height="80" loading="lazy"/>
          <span>{item.label}</span>
          {!item.usable && <span className="avatar-lock" aria-hidden="true"><Lock size={12}/></span>}
        </button>;
      })}</div>
    </section>)}
    {catalogAvatar && <button className="secondary avatar-previous" type="button" onClick={() => void save(() => selectCatalog(''))}>{t('Use previous picture')}</button>}
    <label className="secondary avatar-custom">{t('Upload your own')}<input aria-label={t('Change avatar')} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(file); }}/></label>
    <small>{t('PNG, JPG or WebP · up to 25 MB · resized automatically')}</small><p role="status">{t(busy ? 'Saving picture…' : notice)}</p>
  </fieldset>;
}
