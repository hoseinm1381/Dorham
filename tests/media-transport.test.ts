import { it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
vi.mock('livekit-client', async importOriginal => {
  const { EventEmitter } = await import('node:events');
  const original = await importOriginal<typeof import('livekit-client')>();
  class Room extends EventEmitter {
    state = 'disconnected'; remoteParticipants = new Map();
    localParticipant = { setMicrophoneEnabled: vi.fn(async () => {}), getTrackPublication: () => undefined, setScreenShareEnabled: vi.fn(async () => {}) };
    connect = vi.fn(async () => { this.state = 'connected'; }); startAudio = async () => {};
    disconnect = async () => { this.state = 'disconnected'; };
  }
  return { ...original, Room };
});
import { LiveKitTransport } from '../packages/media/src/livekit';
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('AudioContext', class { resume = async () => {}; close = async () => {}; });
  const socket = new EventEmitter(), events: string[] = []; let joined!: (error: null, result: any) => void;
  (socket as any).timeout = () => ({ emit: (name: string, _body: unknown, reply: typeof joined) => {
    events.push(name); if (name === 'voice:join') joined = reply;
    else reply(null, { ok: true, data: name === 'voice:sfu' ? { url: 'ws://fixture', token: 'fixture' } : {} });
  } });
  const transport = new LiveKitTransport({ socket: socket as any, userId: 'member', emit: vi.fn() });
  const room = { channelId: 'room', members: [{user:{id:'member'},serverMuted:false,serverDeafened:false}],shares:[],transport:'livekit' };
  return {socket,events,transport,release:()=>joined(null,{ok:true,data:{room}})};
}
it('does not treat the socket initial connection as a second overlapping SFU join', async () => {
  const f = fixture(); try {
    const joining = f.transport.join('room'); f.socket.emit('connect'); f.release(); await joining;
    expect(f.events.filter(e => e === 'voice:join')).toHaveLength(1); expect(f.events).not.toContain('voice:leave'); expect(f.transport.room?.channelId).toBe('room');
  } finally { await f.transport.destroy(); }
});
it('a cancelled pending join cannot resurrect a voice room or start its heartbeat', async () => {
  const f = fixture(); const joining = f.transport.join('room'); const rejected = expect(joining).rejects.toThrow('cancelled');
  await f.transport.leave(); f.release(); await rejected; expect(f.transport.room).toBeNull(); expect(f.events).not.toContain('voice:sfu'); await f.transport.destroy();
});
