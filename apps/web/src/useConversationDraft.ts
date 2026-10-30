import { useEffect, useRef, useState, type SetStateAction } from 'react';
import { DraftStore, type Draft } from './drafts';
import { request } from './api';
let store: DraftStore;
export function draftStore() { if (!store) { let storage: Storage | undefined; try { storage = localStorage; } catch { /* unavailable */ } store = new DraftStore(storage); } return store; }
export function useConversationDraft(account: string | undefined, origin: string, conversation: string | null) {
  const cache = draftStore(), key = cache.key(account || '', origin, conversation || '');
  const [, render] = useState(0), timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const value = cache.get(key);
  function update<K extends keyof Draft>(field: K, next: SetStateAction<Draft[K]>) {
    const old = cache.get(key), result = typeof next === 'function' ? (next as (old: Draft[K]) => Draft[K])(old[field]) : next;
    cache.set(key, { ...old, [field]: result }); render(n => n + 1);
    clearTimeout(timer.current); timer.current = setTimeout(() => cache.flush(), 250);
  }
  useEffect(() => { const flush = () => cache.flush(); window.addEventListener('pagehide', flush); return () => { clearTimeout(timer.current); flush(); window.removeEventListener('pagehide', flush); }; }, []);
  useEffect(() => {
    if (!account || !conversation) return;
    let active = true; const files = cache.get(key).files;
    if (files.length) void Promise.all(files.map(async file => { try { return await request(`/attachments/${file.id}/status`); } catch { return null; } })).then(values => {
      if (!active) return; const valid = values.filter(Boolean) as Draft['files']; const current = cache.get(key);
      cache.set(key, { ...current, files: current.files.filter(f => !files.some(old => old.id === f.id) || valid.some(v => v.id === f.id)) }); render(n => n + 1); cache.flush();
    });
    return () => { active = false; };
  }, [key]);
  return { draft: value.text, setDraft: (v: SetStateAction<string>) => update('text', v), reply: value.reply, setReply: (v: SetStateAction<Draft['reply']>) => update('reply', v), editing: value.editing, setEditing: (v: SetStateAction<Draft['editing']>) => update('editing', v), pendingFiles: value.files, setPendingFiles: (v: SetStateAction<Draft['files']>) => update('files', v), pendingSend: value.pending, setPendingSend: (v: SetStateAction<Draft['pending']>) => update('pending', v) };
}
