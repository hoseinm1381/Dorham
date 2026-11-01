import { useId, useState, type RefObject } from 'react';
import type { PublicUser } from '@dorham/contracts';
import { mentionQuery } from '../../../packages/contracts/src/mentions';
import { normalizePeopleSearch } from '../../../packages/contracts/src/persian';
import { Avatar } from './UserAvatar';
import { t as tr } from './i18n';
import './mentions.css';

export function MentionInput({ inputRef, value, members, disabled, placeholder, change, send }: { inputRef: RefObject<HTMLTextAreaElement | null>; value: string; members: PublicUser[]; disabled: boolean; placeholder: string; change: (text: string) => void; send: () => void }) {
  const id = useId(), [caret, setCaret] = useState(0), [focused, setFocused] = useState(false), [dismissed, setDismissed] = useState(''), [selection, setSelection] = useState({ key: '', index: 0 });
  const query = mentionQuery(value, caret), key = `${value}:${caret}`, term = normalizePeopleSearch(query?.query || '');
  const choices = !disabled && focused && query && dismissed !== key ? members.filter(u => !u.banned && (normalizePeopleSearch(u.username).includes(term) || normalizePeopleSearch(u.displayName).includes(term))).sort((a, b) => a.username.localeCompare(b.username)).slice(0, 8) : [];
  const active = selection.key === key ? Math.min(selection.index, choices.length - 1) : 0;
  function pick(user: PublicUser) {
    if (!query) return;
    const tag = `@${user.username} `, next = value.slice(0, query.start) + tag + value.slice(query.end);
    if (next.length > 4000) return;
    change(next); const position = query.start + tag.length; setCaret(position);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(position, position); });
  }
  return <div className="mention-input">
    {choices.length > 0 && <div className="mention-picker" id={id} role="listbox" aria-label={tr('Tag a member')}><small>{tr('Tag a member')}</small>{choices.map((u, i) => <button type="button" role="option" id={`${id}-${i}`} key={u.id} aria-selected={i === active} className={i === active ? 'active' : ''} onPointerDown={e => e.preventDefault()} onClick={() => pick(u)}><Avatar user={u}/><span><strong dir="auto">{u.displayName}</strong><small dir="ltr">@{u.username}</small></span></button>)}<small>{tr('↑ ↓ to choose · Enter to select · Esc to close')}</small></div>}
    <textarea ref={inputRef} dir="auto" aria-label={tr('Message')} aria-autocomplete="list" aria-haspopup="listbox" aria-controls={choices.length ? id : undefined} aria-activedescendant={choices.length ? `${id}-${active}` : undefined} maxLength={4000} value={value} disabled={disabled} placeholder={placeholder}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onSelect={e => setCaret(e.currentTarget.selectionStart)}
      onChange={e => { change(e.target.value); setCaret(e.target.selectionStart); setDismissed(''); }}
      onKeyDown={e => {
        if (e.nativeEvent.isComposing) return;
        if (choices.length) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSelection({ key, index: (active + (e.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length }); return; }
          if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) { e.preventDefault(); pick(choices[active]); return; }
          if (e.key === 'Escape') { e.preventDefault(); setDismissed(key); return; }
        }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      }}/>
  </div>;
}
