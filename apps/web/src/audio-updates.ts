import type { MediaTransport } from '@dorham/media';
const devicePreferences = {};
const updates = new WeakMap<object, Promise<unknown>>();
// Keep delayed model loads and capture changes ordered even if Settings is
// closed and reopened before an earlier operation completes.
export function updateAudio<T>(transport: MediaTransport | null, operation: () => Promise<T>): Promise<T> {
  const key = transport ?? devicePreferences;
  const task = (updates.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  updates.set(key, task);
  const release = () => { if (updates.get(key) === task) updates.delete(key); };
  void task.then(release, release);
  return task;
}
