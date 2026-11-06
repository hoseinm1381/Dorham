import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, Smile, X } from 'lucide-react';
import { emojiCategories, emojiParts, findEmoji, searchEmojis, type Emoji } from './emojis';
import { t, currentLanguage } from './i18n';
import { useFeatures, type CatalogItem } from './Features';
import { assetUrl } from './api';
import './emojis.css';

const catalogEmoji = (item: CatalogItem): Emoji => ({ id: 'dx-' + item.id, src: assetUrl(item.url)!, label: item.label, tags: item.pack ? [item.pack] : [], category: item.kind });

export function EmojiGlyph({ value }: { value: string }) {
  const { byId, shortcodes } = useFeatures();
  const id = value.startsWith(':dx-') ? value.slice(4, -1) : value.startsWith('dx-') ? value.slice(3) : '';
  const catalog = byId.get(id);
  const emoji = catalog ? catalogEmoji(catalog) : findEmoji(value), [failed, setFailed] = useState('');
  return emoji && failed !== emoji.id ? <img className={catalog?.kind === 'sticker' ? 'custom-emoji catalog-sticker' : 'custom-emoji'} src={emoji.src} width="28" height="28" alt={shortcodes.code(emoji.id)} aria-label={t(emoji.label)} title={t(emoji.label)} loading="lazy" draggable={false} onError={() => setFailed(emoji.id)}/> : <>{emoji ? shortcodes.code(emoji.id) : value}</>;
}
export function EmojiText({ text }: { text: string }) {
  const { byId } = useFeatures();
  return <>{emojiParts(text, id => {
    if (!id.startsWith('dx-')) return findEmoji(id);
    const item = byId.get(id.slice(3));
    return item ? catalogEmoji(item) : undefined;
  }).map((part, index) => part.emoji ? <EmojiGlyph key={index} value={part.emoji.id}/> : part.text)}</>;
}
export function EmojiPicker({ disabled, pick, reaction = false, selected = [], serverId = '' }: { disabled: boolean; pick: (emoji: Emoji) => boolean | Promise<boolean>; reaction?: boolean; selected?: string[]; serverId?: string }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [category, setCategory] = useState('all'), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [keepOpen, setKeepOpen] = useState(() => { try { return localStorage.getItem('dorham-emoji-keep-open') !== 'false'; } catch { return true; } }), [position, setPosition] = useState({ x: 12, y: 12 });
  const root = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null), id = useId();
  function close(focus = false) { setOpen(false); if (focus) trigger.current?.focus(); }
  function place() {
    if (!reaction || !panel.current || !trigger.current) return;
    const anchor = trigger.current.getBoundingClientRect(), box = panel.current.getBoundingClientRect();
    const x = Math.max(12, Math.min(anchor.right - box.width, innerWidth - box.width - 12)), y = Math.max(12, Math.min(anchor.top - box.height - 6, innerHeight - box.height - 12));
    setPosition(previous => previous.x === x && previous.y === y ? previous : { x, y });
  }
  useLayoutEffect(() => { if (open) place(); }, [open, reaction, query, category, notice]);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node) && !panel.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, reaction]);
  async function choose(emoji: Emoji) {
    if (busy) return; setBusy(true); setNotice('');
    try {
      if (await pick(emoji)) { if (!keepOpen) { close(); setQuery(''); } }
      else setNotice(reaction ? 'Reaction could not be saved. Try again.' : 'Not enough room in this message.');
    } catch { setNotice(reaction ? 'Reaction could not be saved. Try again.' : 'Not enough room in this message.'); }
    finally { setBusy(false); }
  }
  const language = currentLanguage();
  const { catalog, shortcodes } = useFeatures();
  const custom = useMemo(() => catalog.filter(item => item.active &&
    (item.kind === 'emoji' || !reaction && item.kind === 'sticker' && item.usable) &&
    (!item.serverId || item.serverId === serverId)), [catalog, reaction, serverId]);
  const matches = useMemo(() => {
    if (!open || disabled) return [];
    const builtIn = category === 'catalog' ? [] : searchEmojis(query, category, t).map(emoji => ({ emoji, locked: false }));
    if (!['all', 'catalog'].includes(category)) return builtIn;
    const needle = query.trim().toLocaleLowerCase(language);
    return [...builtIn, ...custom.filter(item => (item.label + ' ' + (item.pack || '') + ' ' + shortcodes.code('dx-' + item.id)).toLocaleLowerCase(language).includes(needle)).map(item => ({ emoji: catalogEmoji(item), locked: !item.usable }))];
  }, [open, disabled, query, category, language, custom, shortcodes]);
  const popup = open && !disabled && <div ref={panel} className={`emoji-picker${reaction ? ' reaction-picker' : ''}`} style={reaction ? { left: position.x, top: position.y } : undefined} id={id} role="dialog" aria-label={t(reaction ? 'Choose reactions' : 'Emojis')} onKeyDown={e => { if (e.key === 'Enter' && e.target === search.current) e.preventDefault(); if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } }}>
      <header><strong>{t(reaction ? 'Choose reactions' : 'Emojis')}</strong><button type="button" aria-label={t('Close emoji picker')} onClick={() => close(true)}><X size={18}/></button></header>
      <input ref={search} type="search" aria-label={t('Search emojis')} placeholder={t('Search emojis')} value={query} onChange={e => setQuery(e.target.value)}/>
      <div className="emoji-categories">{(custom.length ? [...emojiCategories, ['catalog', 'Custom packs']] : emojiCategories).map(([value, label]) => <button type="button" key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>{t(label)}</button>)}</div>
      <div className="emoji-grid" aria-busy={busy}>{matches.map(({ emoji, locked }) => {
        const label = t(emoji.label), state = locked ? ` · ${t('Locked')}` : '';
        return <button type="button" key={emoji.id} disabled={busy} aria-disabled={locked || undefined} aria-pressed={reaction ? selected.includes(emoji.id) : undefined} title={`${label} · ${shortcodes.code(emoji.id)}${state}`} aria-label={locked ? label + state : t(reaction ? 'React with {emoji}' : 'Insert {emoji}', { emoji: label })} onClick={() => { if (!locked) void choose(emoji); }}><img src={emoji.src} alt="" width="38" height="38" loading="lazy" draggable={false}/>{locked && <span className="emoji-lock" aria-hidden="true"><Lock size={10}/></span>}</button>;
      })}</div>
      {!matches.length && <p>{t('No emojis found.')}</p>}
      <label className="emoji-keep-open"><input type="checkbox" checked={keepOpen} onChange={e => { const checked = e.target.checked; setKeepOpen(checked); try { localStorage.setItem('dorham-emoji-keep-open', String(checked)); } catch { /* Session preference still works. */ } }}/>{t('Keep picker open')}</label>
      <small role="status">{notice ? t(notice) : t('{count} emojis', { count: matches.length })}</small>
    </div>;
  return <div className="emoji-control" ref={root}>
    <button ref={trigger} type="button" className={`emoji-trigger${reaction ? ' icon-button' : ''}`} title={t(reaction ? 'Add reaction' : 'Add emoji')} aria-label={t(reaction ? 'Add reaction' : 'Add emoji')} aria-expanded={open && !disabled} aria-controls={id} disabled={disabled} onClick={() => { if (!open) { try { setKeepOpen(localStorage.getItem('dorham-emoji-keep-open') !== 'false'); } catch { /* session preference */ } } setOpen(!open); setNotice(''); }}><Smile size={21}/></button>
    {reaction && popup ? createPortal(popup, document.body) : popup}
  </div>;
}
