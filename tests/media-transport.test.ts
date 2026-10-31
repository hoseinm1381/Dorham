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
  vi.stubGlobal('navigator', { onLine: true, mediaDevices: { getUserMedia: vi.fn() } });
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
it('passes selected-window audio to native Chrome and publishes screen audio independently from the microphone', async () => {
  const f = fixture(), video = { kind: 'video', stop: vi.fn(), getSettings: () => ({ displaySurface: 'window' }) }, audio = { kind: 'audio', stop: vi.fn(), getSettings: () => ({ channelCount: 2 }) };
  try {
    const participant = (f.transport as any).media.localParticipant, published = new Map();
    participant.permissions = { canPublish: true, canPublishSources: [] };
    const capture = vi.fn(async (options: any) => ({ getVideoTracks: () => [video], getAudioTracks: () => options.audio ? [audio] : [], getTracks: () => options.audio ? [video, audio] : [video] }));
    (navigator.mediaDevices as any).getDisplayMedia = capture;
    participant.publishTrack = vi.fn(async (track: any, options: any) => { published.set(options.source, { audioTrack: track.kind === 'audio' ? track : undefined }); });
    participant.getTrackPublication = (source: string) => published.get(source);
    (f.socket as any).timeout = () => ({ emit: (_name: string, body: any, reply: any) => reply(null, { ok: true, data: { lease: { id: 'screen', policyRevision: 1, includeAudio: Boolean(body.includeAudio), maxFrameRate: 30 } } }) });
    await f.transport.startShare('720p15', { includeAudio: true });
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ windowAudio: 'window', systemAudio: 'include', audio: expect.objectContaining({ restrictOwnAudio: true }), selfBrowserSurface: 'exclude' }));
    expect(participant.publishTrack).toHaveBeenCalledWith(video, expect.objectContaining({ source: 'screen_share', screenShareEncoding: { maxBitrate: 402000, maxFramerate: 15 } }));
    expect(participant.publishTrack).toHaveBeenCalledWith(audio, expect.objectContaining({ source: 'screen_share_audio', forceStereo: true, audioPreset: { maxBitrate: 48000 } }));
    await f.transport.stopShare(); expect(video.stop).toHaveBeenCalled(); expect(audio.stop).toHaveBeenCalled();
    published.clear(); await f.transport.startShare('720p15', { includeAudio: false });
    expect(capture).toHaveBeenLastCalledWith(expect.objectContaining({ windowAudio: 'exclude', systemAudio: 'exclude', audio: false }));
  } finally { await f.transport.destroy(); }
});
it('a stream sound gesture resumes suspended playback while mute never wakes it', async () => {
  const f = fixture();
  try {
    const joining = f.transport.join('room'); f.release(); await joining;
    const media = (f.transport as any).media;
    media.startAudio = vi.fn(async () => {});
    f.transport.setStreamVolume('share', 0); expect(media.startAudio).not.toHaveBeenCalled();
    f.transport.setStreamVolume('share', 1); expect(media.startAudio).toHaveBeenCalledOnce();
  } finally { await f.transport.destroy(); }
});
it('stops native window tracks and releases the lease if publication fails', async () => {
  const f = fixture(), stop = vi.fn(), video = { kind: 'video', stop, getSettings: () => ({ displaySurface: 'window' }) };
  try {
    (navigator.mediaDevices as any).getDisplayMedia = async () => ({ getVideoTracks: () => [video], getAudioTracks: () => [], getTracks: () => [video] });
    const participant = (f.transport as any).media.localParticipant;
    participant.permissions = { canPublish: true, canPublishSources: [] };
    participant.publishTrack.mockRejectedValueOnce(new Error('SFU publication failed'));
    (f.socket as any).timeout = () => ({ emit: (_name: string, _body: any, reply: any) => reply(null, { ok: true, data: { lease: { id: 'screen', includeAudio: true, policyRevision: 1 } } }) });
    await expect(f.transport.startShare('720p15', { includeAudio: true })).rejects.toThrow('SFU publication failed');
    expect(stop).toHaveBeenCalled(); expect((f.transport as any).lease).toBeNull();
    expect(participant.setScreenShareEnabled).toHaveBeenCalledWith(false);
  } finally { await f.transport.destroy(); }
});
it('cancelling a native picker stops its late tracks without publishing them', async () => {
  const f = fixture(), stop = vi.fn(), video = { kind: 'video', stop, getSettings: () => ({}) };
  let acquired!: (stream: any) => void;
  try {
    const capture = vi.fn(() => new Promise(resolve => { acquired = resolve; }));
    (navigator.mediaDevices as any).getDisplayMedia = capture;
    const participant = (f.transport as any).media.localParticipant;
    participant.permissions = { canPublish: true, canPublishSources: [] };
    (f.socket as any).timeout = () => ({ emit: (_name: string, _body: any, reply: any) => reply(null, { ok: true, data: { lease: { id: 'screen', includeAudio: true, policyRevision: 1 } } }) });
    const pending = f.transport.startShare('720p15', { includeAudio: true }), rejected = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce()); await f.transport.stopShare();
    acquired({ getVideoTracks: () => [video], getAudioTracks: () => [], getTracks: () => [video] });
    await rejected; expect(stop).toHaveBeenCalled(); expect(participant.publishTrack).not.toHaveBeenCalled();
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

it('repairs a removed gain processor even when the microphone enabled state has not changed', async () => {
  const f = fixture();
  try {
    const joining = f.transport.join('room'); f.release(); await joining;
    let processor: any;
    const microphone = { enabled: true, readyState: 'live' };
    const track = { mediaStreamTrack: microphone, getProcessor: () => processor, setProcessor: vi.fn(async (next: any) => { processor = next; next.processedTrack = { enabled: true, stop: vi.fn() }; }) };
    (f.transport as any).media.localParticipant.getTrackPublication = () => ({ audioTrack: track });
    await f.transport.setMicrophoneGain(2.5);
    expect(track.setProcessor).toHaveBeenCalledOnce(); expect(processor.processedTrack).toBeTruthy(); expect((processor as any).value).toBe(2.5);
    await f.transport.setMuted(true); processor = undefined;
    await f.transport.setMicrophoneGain(1.5);
    expect(track.setProcessor).toHaveBeenCalledTimes(2); expect(microphone.enabled).toBe(false); expect((processor as any).enabled).toBe(false);
  } finally { await f.transport.destroy(); }
});

it('applies live screen limits and keeps the new bandwidth for later quality and SDK republish settings',async()=>{
  const f=fixture();try{
    const transport=f.transport as any,media=transport.media,lease={id:'screen',policyRevision:1,maxFrameRate:30,includeAudio:true};transport.lease=lease;transport.options.screenPolicy={maxBitrate:1500000,maxFrameRate:30};
    (f.socket as any).timeout=()=>({emit:(name:string,_body:any,reply:any)=>reply(null,{ok:true,data:{lease:{...lease,policyRevision:2}}})});
    let parameters:any={encodings:[{active:true,maxBitrate:402000,maxFramerate:15}]};
    const sender={getParameters:()=>structuredClone(parameters),setParameters:vi.fn(async(value:any)=>{parameters=value;})};
    const track={sender,mediaStreamTrack:{applyConstraints:vi.fn(async()=>{})}},publication={videoTrack:track,options:{screenShareEncoding:{maxBitrate:402000,maxFramerate:15}}};media.localParticipant.getTrackPublication=()=>publication;
    await f.transport.setShareQuality('480p30',1500000);expect(parameters.encodings[0]).toMatchObject({active:true,maxBitrate:1452000,maxFramerate:30});expect(publication.options.screenShareEncoding).toEqual({maxBitrate:1452000,maxFramerate:30});
    await f.transport.setShareQuality('720p15');expect(parameters.encodings[0]).toMatchObject({maxBitrate:1452000,maxFramerate:15});expect(track.mediaStreamTrack.applyConstraints).toHaveBeenLastCalledWith(expect.objectContaining({height:{ideal:720,max:720}}));
  }finally{await f.transport.destroy();}
});
it('stops a partly applied screen when encoder changes fail instead of displaying a false applied limit',async()=>{
  const f=fixture();try{
    const transport=f.transport as any,media=transport.media,lease={id:'screen',policyRevision:1,maxFrameRate:30};transport.lease=lease;
    (f.socket as any).timeout=()=>({emit:(name:string,_body:any,reply:any)=>reply(null,{ok:true,data:{lease:{...lease,policyRevision:2}}})});
    const sender={getParameters:()=>({encodings:[{}]}),setParameters:vi.fn(async()=>{throw Error('Encoder rejected the limit');})};media.localParticipant.getTrackPublication=()=>({videoTrack:{sender,mediaStreamTrack:{applyConstraints:async()=>{}}}});
    await expect(f.transport.setShareQuality('720p30',300000)).rejects.toThrow('Encoder rejected');expect(media.localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(false);expect(transport.lease).toBeNull();
  }finally{await f.transport.destroy();}
});
