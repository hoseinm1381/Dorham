import { it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
vi.mock('livekit-client', async importOriginal => {
  const { EventEmitter } = await import('node:events');
  const original = await importOriginal<typeof import('livekit-client')>();
  class Room extends EventEmitter {
    state = 'disconnected'; remoteParticipants = new Map();
    microphone: any;
    localParticipant = {
      createTracks: vi.fn(async () => [{ mute: async () => {}, setProcessor: async () => {}, stop: () => {}, mediaStreamTrack: { enabled: false } }]),
      publishTrack: vi.fn(async (track: any) => { this.microphone = track; }),
      setMicrophoneEnabled: vi.fn(async () => {}), getTrackPublication: () => this.microphone ? { audioTrack: this.microphone } : undefined, setScreenShareEnabled: vi.fn(async () => {})
    };
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
it('a positive volume gesture resumes playback and reapplies the latest amplification after readiness', async () => {
  const f = fixture();
  try {
    const joining = f.transport.join('room'); f.release(); await joining;
    const media = (f.transport as any).media, participant = { identity: 'friend:epoch', setVolume: vi.fn() }; media.remoteParticipants.set(participant.identity, participant);
    let resume!: () => void; media.startAudio = vi.fn(() => new Promise<void>(resolve => { resume = resolve; }));
    f.transport.setVolume('friend', 1.5); f.transport.setVolume('friend', 2);
    expect(media.startAudio).toHaveBeenCalledTimes(1); expect(participant.setVolume).toHaveBeenCalledWith(2, 'microphone');
    participant.setVolume.mockClear(); resume(); await Promise.resolve();
    expect(participant.setVolume).toHaveBeenCalledWith(2, 'microphone');
  } finally { await f.transport.destroy(); }
});
it('coalesces overlapping microphone state acknowledgements without losing the final mute', async () => {
  const f = fixture();
  try {
    const joining = f.transport.join('room'); f.release(); await joining;
    const writes: { muted: boolean; reply: () => void }[] = [];
    (f.socket as any).timeout = () => ({ emit: (name: string, body: any, reply: any) => {
      if (name === 'voice:state') writes.push({ muted: body.muted, reply: () => reply(null, { ok: true, data: {} }) });
      else reply(null, { ok: true, data: {} });
    } });
    const muted = f.transport.setMuted(true); await vi.waitFor(() => expect(writes).toHaveLength(1));
    const open = f.transport.setMuted(false), final = f.transport.setMuted(true);
    writes[0].reply(); await Promise.all([muted, open, final]); expect(writes.map(w => w.muted)).toEqual([true]);
  } finally { await f.transport.destroy(); }
});

it('SFU deafen silences every audio source before waiting for control-plane acknowledgement', async () => {
  const f = fixture();
  try {
    const join = f.transport.join('room'); f.release(); await join;
    const media = (f.transport as any).media;
    const participant = { identity: 'friend:epoch', setVolume: vi.fn() }; media.remoteParticipants.set('friend:epoch', participant);
    f.transport.setVolume('friend', 0.5); expect(participant.setVolume).toHaveBeenCalledWith(0.5, 'microphone');
    let release!: () => void;
    (f.socket as any).timeout = () => ({ emit: (_event: string, _body: unknown, reply: any) => { release = () => reply(null, { ok: true, data: {} }); } });
    const pending = f.transport.setDeafened(true);
    expect(participant.setVolume).toHaveBeenLastCalledWith(0, 'screen_share_audio');
    f.transport.setVolume('friend', 2); expect(participant.setVolume).toHaveBeenLastCalledWith(0, 'screen_share_audio');
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); release(); await pending;
    const previousReply = release;
    const restore = f.transport.setDeafened(false); expect(participant.setVolume).toHaveBeenCalledWith(2, 'microphone'); expect(participant.setVolume).toHaveBeenLastCalledWith(0, 'screen_share_audio');
    await vi.waitFor(() => expect(release).not.toBe(previousReply)); release(); await restore;
  } finally { (f.socket as any).connected = false; await f.transport.destroy(); }
});

it('live processing changes preserve microphone mute and commit preferences only after constraints succeed', async () => {
  const f = fixture();
  try {
    const microphone = { readyState: 'live', enabled: false, getSettings: () => ({}), getConstraints: () => ({ deviceId: { exact: 'selected-microphone' } }), applyConstraints: vi.fn(async () => {}) };
    (f.transport as any).media.localParticipant.getTrackPublication = () => ({ audioTrack: { mediaStreamTrack: microphone, applyConstraints: microphone.applyConstraints } });
    const settings = { noiseSuppression: false, echoCancellation: false, autoGainControl: false };
    await f.transport.setAudioProcessing(settings);
    expect(microphone.enabled).toBe(false); expect(microphone.applyConstraints).toHaveBeenCalledWith(settings);
    microphone.applyConstraints.mockRejectedValueOnce(new Error('device rejected constraints'));
    await expect(f.transport.setAudioProcessing({ ...settings, noiseSuppression: true })).rejects.toThrow('device rejected');
    expect((f.transport as any).audioProcessing).toEqual(settings);
  } finally { await f.transport.destroy(); }
});

it('restarts capture when Chromium reports unchanged processing, retaining SDK mute and device constraints', async () => {
  const f = fixture();
  try {
    await f.transport.setMuted(true);
    const microphone = { readyState: 'live', enabled: false, getSettings: () => ({ noiseSuppression: true, echoCancellation: true, autoGainControl: true }) };
    const track = { mediaStreamTrack: microphone, constraints: { deviceId: 'selected-device' }, applyConstraints: vi.fn(async () => {}), mute: vi.fn(async () => { microphone.enabled = false; }), restartTrack: vi.fn(async () => { expect(microphone.enabled).toBe(false); }) };
    (f.transport as any).media.localParticipant.getTrackPublication = () => ({ audioTrack: track });
    await f.transport.setAudioProcessing({ noiseSuppression: false, echoCancellation: true, autoGainControl: false });
    expect(track.restartTrack).toHaveBeenCalledWith({ deviceId: 'selected-device', noiseSuppression: false, echoCancellation: true, autoGainControl: false });
    expect(track.mute).toHaveBeenCalledTimes(2); expect(microphone.enabled).toBe(false);
  } finally { await f.transport.destroy(); }
});
