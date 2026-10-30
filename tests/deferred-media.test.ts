import { it, expect, vi, beforeEach } from 'vitest';
const state = vi.hoisted(() => ({ instances: [] as any[], gate: Promise.resolve(), release: () => {} }));
vi.mock('../packages/media/src/mesh', () => ({ MeshTransport: class {
  muted = false; room = null; destroyed = false; joinedMuted: boolean | null = null;
  constructor() { state.instances.push(this); }
  async setMuted(value: boolean) { this.muted = value; await state.gate; }
  async setDeafened() {}
  async join() { this.joinedMuted = this.muted; }
  async leave() {}
  async destroy() { this.destroyed = true; }
} }));
import { DeferredTransport } from '../packages/media/src/deferred';
beforeEach(() => { state.instances = []; state.gate = new Promise<void>(r => { state.release = r; }); });
it('PTT release during lazy loading reaches the adapter before it can join', async () => {
  const media = new DeferredTransport('mesh', {} as any), joining = media.join('room');
  await vi.waitFor(() => expect(state.instances).toHaveLength(1));
  const released = media.setMuted(true); expect(state.instances[0].muted).toBe(true);
  state.release(); await released; await joining; expect(state.instances[0].joinedMuted).toBe(true); await media.destroy();
});
it('cancelling a lazy join cannot create a late voice connection', async () => {
  const media = new DeferredTransport('mesh', {} as any), joining = media.join('room');
  await vi.waitFor(() => expect(state.instances).toHaveLength(1)); await media.leave(); state.release(); await joining;
  expect(state.instances[0].joinedMuted).toBeNull(); await media.destroy();
});
