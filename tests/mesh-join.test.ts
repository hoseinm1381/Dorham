import { it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { MeshTransport } from '../packages/media/src/mesh';
afterEach(() => vi.unstubAllGlobals());
it('uses one initial offerer while allowing either peer to negotiate later changes', async () => {
  class Peer { connectionState = 'new'; signalingState = 'stable'; remoteDescription: object | null = null; localDescription = { toJSON: () => ({ type: 'offer' }) }; setLocalDescription = vi.fn(async () => {}); close() { this.connectionState = 'closed'; } }
  vi.stubGlobal('RTCPeerConnection', Peer);
  const first: any = new MeshTransport({ socket: new EventEmitter() as any, userId: 'a', emit: vi.fn() }), second: any = new MeshTransport({ socket: new EventEmitter() as any, userId: 'z', emit: vi.fn() }); first.signal = vi.fn(); second.signal = vi.fn();
  try { const a = first.createPeer('z', 'peer-epoch').pc, z = second.createPeer('a', 'peer-epoch').pc; await a.onnegotiationneeded(); await z.onnegotiationneeded(); expect(a.setLocalDescription).toHaveBeenCalledOnce(); expect(z.setLocalDescription).not.toHaveBeenCalled(); z.remoteDescription = {}; await z.onnegotiationneeded(); expect(z.setLocalDescription).toHaveBeenCalledOnce(); }
  finally { await first.destroy(); await second.destroy(); }
});
it('buffers offer and ICE received before the join epoch is acknowledged', async () => {
  vi.stubGlobal('navigator', { onLine: true });
  const socket = new EventEmitter(); let acknowledge!: () => void;
  (socket as any).timeout = () => ({ emit: (event: string, _body: unknown, callback: any) => { if (event === 'voice:join') acknowledge = () => callback(null, { ok: true, data: { epoch: 'new-epoch', room: { members: [], shares: [] }, iceServers: [] } }); else callback(null, { ok: true, data: {} }); } });
  const media: any = new MeshTransport({ socket: socket as any, userId: 'self', emit: vi.fn() }); media.channelId = 'room'; media.mic = { active: true }; media.updateRoom = vi.fn(async () => {}); media.publishState = vi.fn(async () => {}); media.receive = vi.fn(async () => {});
  const joining = media.rejoin(); const offer = { channelId: 'room', from: 'peer', description: { type: 'offer' } }, candidate = { channelId: 'room', from: 'peer', candidate: { candidate: 'fixture' } };
  socket.emit('voice:signal', offer); socket.emit('voice:signal', candidate); expect(media.receive).not.toHaveBeenCalled(); acknowledge(); await joining; await media.signalQueue;
  expect(media.receive.mock.calls.map((c: any) => c[0])).toEqual([offer, candidate]); expect(media.earlySignals).toHaveLength(0);
});
it('stops a microphone that arrives after leave cancelled a permission request', async () => {
  let acquired!: (value: any) => void; const stop = vi.fn(); vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise(resolve => { acquired = resolve; }) } });
  const socket = new EventEmitter(), media = new MeshTransport({ socket: socket as any, userId: 'self', emit: vi.fn() });
  const joining = media.join('room'), cancelled = expect(joining).rejects.toThrow('cancelled'); await media.leave(); acquired({ getTracks: () => [{ stop }] }); await cancelled; expect(stop).toHaveBeenCalledOnce(); expect(media.room).toBeNull(); await media.destroy();
});
