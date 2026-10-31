import { it, expect, vi, beforeEach } from 'vitest';
const state = vi.hoisted(() => ({ instances: [] as any[], gate: Promise.resolve(), release: () => {} }));
vi.mock('../packages/media/src/mesh', () => ({ MeshTransport: class {
  muted = false; deafened = false; room = null; destroyed = false; joinedMuted: boolean | null = null;
  constructor() { state.instances.push(this); }
  async setMuted(value: boolean) { this.muted = value; await state.gate; }
  async setDeafened(value: boolean) { this.deafened = value; }
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
it('isolates overlapping audio tests from hotkeys, restores selected state and ignores duplicate release', async () => {
  vi.stubGlobal('window', { dispatchEvent: vi.fn() }); state.release();
  try {
    const media = new DeferredTransport('mesh', {} as any); await media.join('room'); const inner = state.instances[0];
    const end = await media.beginAudioTest(), endOther = await media.beginAudioTest();
    expect(inner.muted && inner.deafened).toBe(true);
    await media.setMuted(false); await media.setDeafened(false); expect(inner.muted && inner.deafened).toBe(true);
    await end(); await end(); expect(inner.muted && inner.deafened).toBe(true);
    await media.setMuted(true); await endOther(); expect(inner.muted).toBe(true); expect(inner.deafened).toBe(false);
    await media.setMuted(false); const again = await media.beginAudioTest(); await media.setDeafened(true); await again();
    expect(inner.muted).toBe(false); expect(inner.deafened).toBe(true); await media.destroy();
  } finally { vi.unstubAllGlobals(); }
});
