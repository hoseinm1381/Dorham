import type { Message } from '@dorham/contracts';
import { Capacitor, registerPlugin } from '@capacitor/core';

type MediaKind = 'image' | 'video' | 'file';
type Kind = 'history' | 'media' | 'session' | 'upload' | 'outbox' | 'preference';
type Entry<T = unknown> = { key: string; scope: string; kind: Kind; id: string; data: T; bytes: number; touched: number; conversation?: string; mediaKind?: MediaKind };
export type OfflineHistory = { messages: Message[]; sequence: number; hasMore: boolean };
const maxHistories = 40, maxMessages = 100;
const mib = 1024 * 1024;
const defaults = { limit: 100, dataSaver: false };
const nativeTransfers = registerPlugin<{ localSize(options: { scope: string }): Promise<{ bytes: number }>; clearLocal(options: { scope: string }): Promise<void>; trimLocal(options: { scope: string; limit: number }): Promise<void> }>('DorhamFiles');
let currentScope = '';
const listeners = new Set<() => void>();
let database: Promise<IDBDatabase> | undefined;
let writes = Promise.resolve();
const revisions = new Map<string, number>();
const changes = () => { for (const listener of listeners) listener(); };
export const storageScope = () => currentScope;
export const subscribeStorage = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const marker = (origin: string) => `dorham-account:${origin}`;
const key = (scope: string, kind: Kind, id: string) => JSON.stringify([scope, kind, id]);
const settingKey = (scope: string) => `dorham-storage:${scope}`;
const revision = (scope: string, kind: Kind) => `${scope}:${kind}`;

export function rememberedAccount(origin: string) {
  try { return localStorage.getItem(marker(origin)); } catch { return null; }
}
export function storageAccountChanged(event: StorageEvent, origin: string, activeAccount: string) {
  return event.key === marker(origin) && event.oldValue === activeAccount && event.newValue !== activeAccount;
}
export function activateStorage(origin: string, account: string) {
  const scope = JSON.stringify([origin, account]);
  try { localStorage.setItem(marker(origin), account); } catch { /* Private browser storage can be disabled. */ }
  if (currentScope !== scope) { currentScope = scope; changes(); }
  return scope;
}
export function detachStorage() { currentScope = ''; changes(); }
export function signOutStorage(origin: string, account: string) {
  try { if (rememberedAccount(origin) === account) localStorage.removeItem(marker(origin)); } catch { /* Storage is optional. */ }
  const scope = JSON.stringify([origin, account]);
  if (scope === currentScope) detachStorage();
  return clearStorage(scope, 'history', 'media', 'session', 'upload', 'outbox');
}
export function storageSettings(scope = currentScope): typeof defaults {
  try {
    const value = JSON.parse(localStorage.getItem(settingKey(scope)) || 'null');
    return { limit: [25, 50, 100, 250, 500].includes(value?.limit) ? value.limit : defaults.limit, dataSaver: value?.dataSaver === true };
  } catch { return defaults; }
}
export function saveStorageSettings(value: typeof defaults) {
  const scope = currentScope;
  localStorage.setItem(settingKey(scope), JSON.stringify(value));
  changes();
  return enqueue(async () => {
    const bytes = value.limit * mib;
    await trim(scope, 'media', bytes);
    if (Capacitor.getPlatform() === 'android') await nativeTransfers.trimLocal({ scope, limit: Math.max(0, bytes - await localMediaBytes(scope)) });
  });
}
function openStorage() {
  database ??= new Promise((resolve, reject) => {
    const opening = indexedDB.open('dorham-local-content', 1);
    opening.onupgradeneeded = () => {
      const store = opening.result.createObjectStore('content', { keyPath: 'key' });
      store.createIndex('scopeKind', ['scope', 'kind']);
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  return database;
}
function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function write(change: (store: IDBObjectStore) => void) {
  const transaction = (await openStorage()).transaction('content', 'readwrite');
  const finished = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });
  change(transaction.objectStore('content'));
  await finished;
}
function enqueue(work: () => Promise<void>) {
  const next = writes.then(work);
  writes = next.catch(() => {});
  return next;
}
const downloadFolderKey = key('device', 'preference', 'download-folder');
export async function readDownloadFolder<T>() {
  const row = await result<Entry<T> | undefined>((await openStorage()).transaction('content').objectStore('content').get(downloadFolderKey));
  return row?.data;
}
export function storeDownloadFolder<T>(data?: T) {
  return enqueue(() => write(store => {
    if (data) store.put({ key: downloadFolderKey, scope: 'device', kind: 'preference', id: 'download-folder', data, bytes: 0, touched: Date.now() });
    else store.delete(downloadFolderKey);
  }));
}
async function entries(scope: string, kind: Kind): Promise<Entry[]> {
  return result((await openStorage()).transaction('content').objectStore('content').index('scopeKind').getAll([scope, kind]));
}
async function trim(scope: string, kind: Kind, bytes: number, count = Infinity) {
  const rows = (await entries(scope, kind)).sort((a, b) => b.touched - a.touched);
  let total = 0;
  const excess = rows.filter((row, index) => (total += row.bytes) > bytes || index >= count);
  if (excess.length) await write(store => { for (const row of excess) store.delete(row.key); });
}
export async function localMediaBytes(scope: string) {
  if (!scope) return 0;
  return (await entries(scope, 'media')).reduce((sum, row) => sum + row.bytes, 0);
}
export async function readLocal<T>(scope: string, kind: Kind, id: string): Promise<T | undefined> {
  if (!scope) return;
  try {
    const row: Entry<T> | undefined = await result((await openStorage()).transaction('content').objectStore('content').get(key(scope, kind, id)));
    return row?.data;
  } catch { return undefined; }
}
function keep<T>(scope: string, kind: Kind, id: string, data: T, bytes: number, conversation?: string, mediaKind?: MediaKind) {
  if (!scope) return Promise.resolve();
  const generation = revisions.get(revision(scope, kind)) || 0;
  return enqueue(async () => {
    if ((revisions.get(revision(scope, kind)) || 0) !== generation) return;
    await write(store => store.put({ key: key(scope, kind, id), scope, kind, id, data, bytes, conversation, mediaKind, touched: Date.now() } satisfies Entry<T>));
    if (kind === 'media') {
      const native = Capacitor.getPlatform() === 'android' ? (await nativeTransfers.localSize({ scope }).catch(() => ({ bytes: 0 }))).bytes : 0;
      await trim(scope, kind, Math.max(0, storageSettings(scope).limit * mib - native));
    }
    if (kind === 'history') await trim(scope, kind, 8 * mib, maxHistories);
  });
}
export function saveLocalSession<T>(scope: string, value: T) { return keep(scope, 'session', 'bootstrap', value, 0); }
export function saveHistory(scope: string, conversation: string, value: OfflineHistory) {
  const copy = { ...value, messages: value.messages.slice(-maxMessages) };
  return keep(scope, 'history', conversation, copy, new TextEncoder().encode(JSON.stringify(copy)).length, conversation);
}
export function saveMedia(scope: string, id: string, blob: Blob, conversation?: string, kind: MediaKind = 'file') {
  if (blob.size > storageSettings(scope).limit * mib) return Promise.resolve();
  return keep(scope, 'media', id, blob, blob.size, conversation, kind);
}
export function savePartialMedia(scope: string, id: string, blob: Blob, etag: string, conversation?: string) {
  if (blob.size > storageSettings(scope).limit * mib) return Promise.resolve();
  return keep(scope, 'media', id, { blob, etag }, blob.size, conversation, 'file');
}
export function saveUpload<T>(scope: string, conversation: string, value: T) { return keep(scope, 'upload', conversation, value, 0, conversation); }
export async function updateOutbox<T>(scope: string, update: (previous: T[]) => T[]) {
  let next: T[] = [];
  let error: unknown;
  const id = key(scope, 'outbox', 'messages');
  const generation = revisions.get(revision(scope, 'outbox')) || 0;
  await enqueue(async () => {
    if (scope !== currentScope || (revisions.get(revision(scope, 'outbox')) || 0) !== generation) return;
    await write(store => {
      const get = store.get(id);
      get.onsuccess = () => {
        try { next = update(Array.isArray(get.result?.data) ? get.result.data : []); }
        catch (cause) { error = cause; return; }
        store.put({ key: id, scope, kind: 'outbox', id: 'messages', data: next, bytes: 0, touched: Date.now() });
      };
    });
  });
  if (error) throw error;
  return next;
}
export function removeLocal(scope: string, kind: Kind, id: string) { return enqueue(() => write(store => store.delete(key(scope, kind, id)))); }
export function retainLocalConversations(scope: string, allowed: Set<string>) {
  return enqueue(async () => {
    const rows = (await Promise.all((['history', 'media', 'upload'] as const).map(kind => entries(scope, kind)))).flat();
    await write(store => { for (const row of rows) if (row.conversation && !allowed.has(row.conversation)) store.delete(row.key); });
  });
}
export function clearStorage(scope: string, ...kinds: Kind[]) {
  for (const kind of kinds) { const k = revision(scope, kind); revisions.set(k, (revisions.get(k) || 0) + 1); }
  return enqueue(async () => {
    const rows = (await Promise.all(kinds.map(kind => entries(scope, kind)))).flat();
    await write(store => { for (const row of rows) store.delete(row.key); });
    if (kinds.includes('media') && Capacitor.getPlatform() === 'android') await nativeTransfers.clearLocal({ scope });
    changes();
  });
}
export async function storageUsage(scope: string) {
  const totals = { messages: 0, image: 0, video: 0, file: 0 };
  if (!scope) return totals;
  const [history, media] = await Promise.all([entries(scope, 'history'), entries(scope, 'media')]);
  for (const row of history) totals.messages += row.bytes;
  for (const row of media) totals[row.mediaKind || 'file'] += row.bytes;
  if (Capacitor.getPlatform() === 'android') totals.file += (await nativeTransfers.localSize({ scope }).catch(() => ({ bytes: 0 }))).bytes;
  return totals;
}
