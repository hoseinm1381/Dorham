import { useEffect, useId, useRef, useState } from 'react';
import { Smile, X } from 'lucide-react';
import { emojiCategories, emojiCode, emojiParts, findEmoji, searchEmojis, type Emoji } from './emojis';
import { t } from './i18n';
import './emojis.css';

export function EmojiGlyph({ value }: { value: string }) {
  const emoji = findEmoji(value), [failed, setFailed] = useState('');
  return emoji && failed !== emoji.id ? <img className="custom-emoji" src={emoji.src} width="28" height="28" alt={emojiCode(emoji.id)} aria-label={t(emoji.label)} title={t(emoji.label)} loading="lazy" draggable={false} onError={() => setFailed(emoji.id)}/> : <>{emoji?.id === value ? emojiCode(value) : value}</>;
}
export function EmojiText({ text }: { text: string }) {
  return <>{emojiParts(text).map((part, index) => part.emoji ? <EmojiGlyph key={index} value={part.emoji.id}/> : part.text)}</>;
}
export function EmojiPicker({ disabled, pick }: { disabled: boolean; pick: (emoji: Emoji) => boolean }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [category, setCategory] = useState('all'), [notice, setNotice] = useState('');
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null), id = useId();
  function close(focus = false) { setOpen(false); if (focus) trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const matches = searchEmojis(query, category, t);
  return <div className="emoji-control" ref={root}>
    <button ref={trigger} type="button" className="emoji-trigger" title={t('Add emoji')} aria-label={t('Add emoji')} aria-expanded={open && !disabled} aria-controls={id} disabled={disabled} onClick={() => { setOpen(!open); setNotice(''); }}><Smile size={21}/></button>
    {open && !disabled && <div className="emoji-picker" id={id} role="dialog" aria-label={t('Emojis')} onKeyDown={e => { if (e.key === 'Enter' && e.target === search.current) e.preventDefault(); if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } }}>
      <header><strong>{t('Emojis')}</strong><button type="button" aria-label={t('Close emoji picker')} onClick={() => close(true)}><X size={18}/></button></header>
      <input ref={search} type="search" aria-label={t('Search emojis')} placeholder={t('Search emojis')} value={query} onChange={e => setQuery(e.target.value)}/>
      <div className="emoji-categories">{emojiCategories.map(([value, label]) => <button type="button" key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>{t(label)}</button>)}</div>
      <div className="emoji-grid">{matches.map(emoji => <button type="button" key={emoji.id} title={`${t(emoji.label)} · ${emojiCode(emoji.id)}`} aria-label={t('Insert {emoji}', { emoji: t(emoji.label) })} onClick={() => { if (pick(emoji)) { close(); setQuery(''); } else setNotice('Not enough room in this message.'); }}><img src={emoji.src} alt="" width="38" height="38" draggable={false}/></button>)}</div>
      {!matches.length && <p>{t('No emojis found.')}</p>}
      <small role="status">{notice ? t(notice) : t('{count} emojis', { count: matches.length })}</small>
    </div>}
  </div>;
}
