import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { harness, event } from './helpers';
const native = vi.hoisted(() => ({
  prepare: vi.fn(), join: vi.fn(), setState: vi.fn(), leave: vi.fn(), stopShare: vi.fn(),
  updateRoom: vi.fn(), addListener: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => native }));
import { NativeTransport } from '../packages/media/src/native';
import { DeferredTransport } from '../packages/media/src/deferred';

beforeEach(() => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.clearAllMocks();
  native.prepare.mockResolvedValue({ microphoneAvailable: true }); native.join.mockResolvedValue({ listenOnly: false });
  native.setState.mockResolvedValue(undefined); native.addListener.mockResolvedValue({ remove: async () => {} });
  native.leave.mockResolvedValue(undefined); native.stopShare.mockResolvedValue(undefined); native.updateRoom.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const h = await harness(), user = await h.register('native_join');
  await h.api(user, '/servers', { name: 'Native join regression' });
  const channel = (await h.api(user, '/bootstrap')).json().channels.find((c: any) => c.kind === 'voice');
  const socket = await h.connect(user), emit = vi.fn(), outgoing: string[] = [];
  socket.onAnyOutgoing(name => outgoing.push(name));
  return { h, user, channel, socket, emit, outgoing };
}
it('lazy Android startup stores mute/deafen before join without sending NOT_IN_VOICE state requests', async () => {
  const f = await fixture(), media = new DeferredTransport('native', { socket: f.socket, userId: f.user.id, emit: f.emit });
  try {
    await media.setMuted(true); await media.setDeafened(true); await media.join(f.channel.id);
    expect(f.outgoing.indexOf('voice:join')).toBeLessThan(f.outgoing.indexOf('voice:state'));
    expect(native.join).toHaveBeenCalledWith(expect.objectContaining({ muted: true, deafened: true }));
    expect(native.prepare).toHaveBeenCalledTimes(1); expect(media.room?.channelId).toBe(f.channel.id);
    expect(native.setState).toHaveBeenCalledWith({ muted: true, deafened: true });
  } finally { await media.destroy(); await f.h.close(); }
});
it('joins Android listen-only after denied/missing microphone and preserves reception and server mute', async () => {
  const f = await fixture(), media = new NativeTransport({ socket: f.socket, userId: f.user.id, emit: f.emit });
  native.prepare.mockResolvedValue({ microphoneAvailable: false });
  try {
    await media.setMuted(false); await media.setDeafened(false);
    expect(f.outgoing).toEqual([]); expect(native.setState).not.toHaveBeenCalled();
    await media.join(f.channel.id); await media.setMuted(false);
    expect(native.join).toHaveBeenCalledWith(expect.objectContaining({ muted: true, deafened: false }));
    const room = (await event(f.socket, 'voice:heartbeat', { eligible: true })).room;
    expect(room.members.find((m: any) => m.user.id === f.user.id)).toMatchObject({ muted: true, deafened: false });
    expect(f.emit).toHaveBeenCalledWith('listenOnly', true);
    await media.leave(); native.prepare.mockResolvedValue({ microphoneAvailable: true }); await media.join(f.channel.id);
    expect(native.join).toHaveBeenLastCalledWith(expect.objectContaining({ muted: false, deafened: false }));
  } finally { await media.destroy(); await f.h.close(); }
});
it('a native capture failure after connection falls back to listening, while actual connection failure cleans membership', async () => {
  const f = await fixture(), media = new NativeTransport({ socket: f.socket, userId: f.user.id, emit: f.emit });
  try {
    native.join.mockResolvedValueOnce({ listenOnly: true }); await media.join(f.channel.id);
    expect(native.setState).toHaveBeenLastCalledWith({ muted: true, deafened: false });
    await media.leave(); native.join.mockRejectedValueOnce(new Error('SFU connection failed: unreachable'));
    await expect(media.join(f.channel.id)).rejects.toThrow('unreachable'); expect(media.room).toBeNull();
    await expect(event(f.socket, 'voice:heartbeat', { eligible: true })).rejects.toThrow('NOT_IN_VOICE');
  } finally { await media.destroy(); await f.h.close(); }
});
