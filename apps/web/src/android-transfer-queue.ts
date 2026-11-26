import { useSyncExternalStore } from 'react';
import { downloadAttachment } from './api';
import { storageScope, subscribeStorage } from './offline-storage';

type Job = { id: string; name: string; conversation: string; gallery: boolean; state: 'waiting' | 'downloading' | 'paused' | 'saved'; progress: number; handle?: string; error?: string };
const listeners = new Set<() => void>();
let scope = '', jobs: Job[] = [];
let generation = 0;
let active: { job: Job; controller: AbortController } | null = null;

function set(next: Job[]) {
  jobs = next;
  for (const listener of listeners) listener();
}
function update(id: string, values: Partial<Job>) { set(jobs.map(job => job.id === id ? { ...job, ...values } : job)); }
subscribeStorage(() => {
  if (scope === storageScope()) return;
  scope = storageScope();
  generation++;
  active?.controller.abort();
  set([]);
});

async function pump() {
  const job = jobs.find(job => job.state === 'waiting');
  if (active || !job || !scope) return;
  const owner = generation, controller = new AbortController();
  active = { job, controller };
  update(job.id, { state: 'downloading' });
  try {
    const result = await downloadAttachment(job.id, job.name, job.conversation, progress => {
      if (generation === owner) update(job.id, { progress });
    }, controller.signal, job.gallery);
    if (generation === owner) update(job.id, { state: 'saved', progress: 1, handle: result?.handle });
  } catch (cause) {
    if (generation === owner) update(job.id, { state: 'paused', error: controller.signal.aborted ? undefined : cause instanceof Error ? cause.message : 'Download paused. Select Download to resume.' });
  } finally {
    active = null;
    setTimeout(() => { void pump(); }, 0);
  }
}
export function enqueueAndroidDownload(id: string, name: string, conversation: string, gallery: boolean) {
  if (!scope) return;
  if (jobs.some(job => job.id === id && (job.state === 'downloading' || job.state === 'waiting'))) return;
  if (jobs.filter(job => job.state !== 'saved' && job.id !== id).length >= 8) throw new Error('Pause or finish a download before adding another.');
  set([...jobs.filter(job => job.id !== id).slice(-12), { id, name, conversation, gallery, state: 'waiting', progress: 0 }]);
  void pump();
}
export function pauseAndroidDownload(id: string) {
  if (active?.job.id === id) active.controller.abort();
  else update(id, { state: 'paused' });
}
export function removeAndroidDownload(id: string) { set(jobs.filter(job => job.id !== id || job.state === 'downloading')); }

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useAndroidDownloads() { return useSyncExternalStore(subscribe, () => jobs); }
