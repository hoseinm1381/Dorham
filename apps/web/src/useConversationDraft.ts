import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type SetStateAction } from 'react';
import { DraftStore, type Draft } from './drafts';
import { request } from './api';
let store: DraftStore;
export function draftStore() { if (!store) { let storage: Storage | undefined; try { storage = localStorage; } catch { /* unavailable */ } store = new DraftStore(storage); } return store; }
export function useConversationDraftActions(account: string | undefined, origin: string, conversation: string | null) {
  const cache = draftStore(), key = cache.key(account || '', origin, conversation || '');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => { const flush = () => cache.flush(); window.addEventListener('pagehide', flush); return () => { clearTimeout(timer.current); flush(); window.removeEventListener('pagehide', flush); }; }, [cache]);
  // Actions retain the original account/conversation across an async send.
  return useMemo(() => {
    function update<K extends keyof Draft>(field: K, next: SetStateAction<Draft[K]>) {
      const old = cache.get(key), result = typeof next === 'function' ? (next as (old: Draft[K]) => Draft[K])(old[field]) : next;
      cache.set(key, { ...old, [field]: result });
      clearTimeout(timer.current); timer.current = setTimeout(() => cache.flush(), 250);
    }
    return { read: () => cache.get(key), setDraft: (v: SetStateAction<string>) => update('text', v), setReply: (v: SetStateAction<Draft['reply']>) => update('reply', v), setEditing: (v: SetStateAction<Draft['editing']>) => update('editing', v), setPendingFiles: (v: SetStateAction<Draft['files']>) => update('files', v), setPendingSend: (v: SetStateAction<Draft['pending']>) => update('pending', v) };
  }, [cache, key]);
}
export function useConversationDraft(account: string | undefined, origin: string, conversation: string | null) {
  const cache = draftStore(), key = cache.key(account || '', origin, conversation || '');
  const value = useSyncExternalStore(useCallback(notify => cache.subscribe(key, notify), [cache, key]), useCallback(() => cache.get(key), [cache, key]));
  const actions = useConversationDraftActions(account, origin, conversation);
  useEffect(() => {
    if (!account || !conversation) return;
    let active = true; const files = cache.get(key).files;
    if (files.length) void Promise.all(files.map(async file => { try { return await request(`/attachments/${file.id}/status`); } catch { return null; } })).then(values => {
      if (!active) return; const valid = values.filter(Boolean) as Draft['files']; const current = cache.get(key);
      cache.set(key, { ...current, files: current.files.filter(f => !files.some(old => old.id === f.id) || valid.some(v => v.id === f.id)) }); cache.flush();
    });
    return () => { active = false; };
  }, [cache, key, account, conversation]);
  return { draft: value.text, reply: value.reply, editing: value.editing, pendingFiles: value.files, pendingSend: value.pending, ...actions };
}
