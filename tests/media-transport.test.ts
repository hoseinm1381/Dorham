import { it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ConnectionQuality, RoomEvent, Track, VideoQuality, supportsVP9 } from 'livekit-client';
vi.mock('livekit-client', async importOriginal => {
  const { EventEmitter } = await import('node:events');
  const original = await importOriginal<typeof import('livekit-client')>();
  class Room extends EventEmitter {
    state = 'disconnected'; remoteParticipants = new Map();
    microphone: any;
    localParticipant = {
      createTracks: vi.fn(async () => [{ mute: async () => {}, setProcessor: async () => {}, stop: () => {}, mediaStreamTrack: { enabled: false } }]),
      publishTrack: vi.fn(async (track: any) => { this.microphone = track; }),
      unpublishTrack: vi.fn(async () => {}),
      setMicrophoneEnabled: vi.fn(async () => {}), getTrackPublication: () => this.microphone ? { audioTrack: this.microphone } : undefined, setScreenShareEnabled: vi.fn(async () => {})
    };
    connect = vi.fn(async () => { this.state = 'connected'; }); startAudio = async () => {};
    disconnect = async () => { this.state = 'disconnected'; };
  }
  return { ...original, Room, supportsVP9: vi.fn(() => false) };
});
import { LiveKitTransport } from '../packages/media/src/livekit';
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  vi.stubGlobal('navigator', { onLine: true, mediaDevices: { getUserMedia: vi.fn() } });
  vi.stubGlobal('AudioContext', class { resume = async () => {}; close = async () => {}; });
  const socket = Object.assign(new EventEmitter(), { connected: true }), events: string[] = []; let joined!: (error: null, result: any) => void;
  (socket as any).timeout = () => ({ emit: (name: string, _body: unknown, reply: typeof joined) => {
    events.push(name); if (name === 'voice:join') joined = reply;
    else reply(null, { ok: true, data: name === 'voice:sfu' ? { url: 'ws://fixture', token: 'fixture' } : {} });
  } });
  const transport = new LiveKitTransport({ socket: socket as any, userId: 'member', emit: vi.fn() });
  const room = { channelId: 'room', members: [{user:{id:'member'},serverMuted:false,serverDeafened:false}],shares:[],transport:'livekit' };
  return {socket,events,transport,release:()=>joined(null,{ok:true,data:{room}})};
}
it('keeps watched video enabled at low quality when connection quality is lost', async () => {
  const { transport, socket, release } = fixture();
  try {
    const joining = transport.join('room');
    release();
    await joining;
    const media = (transport as any).media;
    const publication = (source: Track.Source) => {
      const pub = { source, isDesired: false, isSubscribed: false, setSubscribed: vi.fn((wanted: boolean) => { pub.isDesired = wanted; }),
        setEnabled: vi.fn(), setVideoQuality: vi.fn(), setVideoFPS: vi.fn() };
      return pub;
    };
    const video = publication(Track.Source.ScreenShare);
    const sound = publication(Track.Source.ScreenShareAudio);
    const microphone = publication(Track.Source.Microphone);
    const trackPublications = new Map([['video', video], ['sound', sound], ['mic', microphone]]);
    media.remoteParticipants.set('friend:epoch', { identity: 'friend:epoch', trackPublications, videoTrackPublications: new Map(), setVolume: vi.fn() });
    const share = { id: 'screen', userId: 'friend', includeAudio: true } as Parameters<typeof transport.subscribe>[0];
    socket.emit('voice:room', { ...transport.room, shares: [share] });
    media.localParticipant.connectionQuality = ConnectionQuality.Lost;
    media.emit(RoomEvent.ConnectionQualityChanged, ConnectionQuality.Lost, media.localParticipant);
    await transport.subscribe(share, true);
    expect(video.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(video.setEnabled).toHaveBeenLastCalledWith(true);
    expect(video.setEnabled).not.toHaveBeenCalledWith(false);
    expect(video.setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.HIGH);
    expect(video.setVideoFPS).toHaveBeenLastCalledWith(4);
    expect(sound.setEnabled).toHaveBeenLastCalledWith(false);
    expect(microphone.setEnabled).not.toHaveBeenCalled();
    Object.assign(video, { simulcasted: false });
    media.emit(RoomEvent.TrackPublished);
    expect(video.setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.HIGH);
    expect(video.setVideoFPS).toHaveBeenLastCalledWith(4);
    await transport.subscribe(share, false);
    // A viewer may close before the SFU acknowledges the initial subscription.
    expect(video.setSubscribed).toHaveBeenLastCalledWith(false);
  } finally { await transport.destroy(); }
});
it('does not treat the socket initial connection as a second overlapping SFU join', async () => {
  const f = fixture(); try {
    const joining = f.transport.join('room'); f.socket.emit('connect'); f.release(); await joining;
    expect(f.events.filter(e => e === 'voice:join')).toHaveLength(1); expect(f.events).not.toContain('voice:leave'); expect(f.transport.room?.channelId).toBe('room');
  } finally { await f.transport.destroy(); }
});
it('simulates independent uplink and downlink congestion through the screen transport', async () => {
  const f = fixture();
  try {
    const joining = f.transport.join('room');
    f.release();
    await joining;
    const transport = f.transport as any, media = transport.media;
    const share = { id: 'remote', userId: 'friend', includeAudio: true } as Parameters<typeof f.transport.subscribe>[0];
    let uplink = 700000, received = 0, lost = 0;
    const baseline = { maxBitrate: 450000, maxFramerate: 30, scaleResolutionDownBy: 1, active: true };
    let encoding = { ...baseline };
    const sender = {
      getParameters: () => ({ encodings: [{ ...encoding }] }),
      setParameters: vi.fn(async ({ encodings }: { encodings: typeof baseline[] }) => {
        expect(encodings).toHaveLength(1);
        encoding = encodings[0];
      }),
    };
    transport.lease = { id: 'local' };
    const localPublication = {
      options: { screenShareEncoding: { maxBitrate: 450000, maxFramerate: 30 } },
      videoTrack: {
        sender,
        mediaStreamTrack: { getSettings: () => ({ width: 1280, height: 720 }) },
        getRTCStatsReport: async () => new Map<string, unknown>([
          ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
          ['selected', { type: 'candidate-pair', availableOutgoingBitrate: uplink }],
          ['unused', { type: 'candidate-pair', availableOutgoingBitrate: 9000000 }],
        ]),
      },
    };
    media.localParticipant.getTrackPublication = (source: Track.Source) =>
      source === Track.Source.ScreenShare ? localPublication : undefined;
    const remote = (source: Track.Source) => ({
      source, trackSid: source, isDesired: false,
      setSubscribed(wanted: boolean) { this.isDesired = wanted; },
      setVideoQuality: vi.fn(), setVideoFPS: vi.fn(), setEnabled: vi.fn(),
      track: source === Track.Source.ScreenShare ? {
        getRTCStatsReport: async () => new Map([['incoming', {
          id: 'incoming', type: 'inbound-rtp', kind: 'video', packetsReceived: received, packetsLost: lost,
        }]]),
      } : undefined,
    });
    const video = remote(Track.Source.ScreenShare), sound = remote(Track.Source.ScreenShareAudio);
    const mic = remote(Track.Source.Microphone);
    media.remoteParticipants.set('friend:epoch', { identity: 'friend:epoch', setVolume: vi.fn(),
      trackPublications: new Map([['video', video], ['sound', sound], ['mic', mic]]),
      audioTrackPublications: new Map([['mic', mic], ['sound', sound]]), videoTrackPublications: new Map([['video', video]]),
    });
    f.socket.emit('voice:room', { ...f.transport.room, shares: [share, { id: 'local', userId: 'member' }] });
    await f.transport.subscribe(share, true);
    const sample = async (packets = 100, drops = 0) => {
      received += packets;
      lost += drops;
      await transport.sampleVoicePriority();
    };
    await sample();
    expect(encoding).toEqual(baseline);
    expect(video.setVideoFPS).toHaveBeenLastCalledWith(0);
    uplink = 262000;
    await sample();
    expect(encoding).toMatchObject({ maxBitrate: 160000, maxFramerate: 14, scaleResolutionDownBy: 720 / 432 });
    expect(video.setVideoFPS).toHaveBeenLastCalledWith(0);
    uplink = 149000;
    await sample();
    expect(encoding).toMatchObject({ maxBitrate: 40000, maxFramerate: 6, scaleResolutionDownBy: 3 });
    uplink = 700000;
    await sample();
    expect(encoding.maxBitrate).toBeGreaterThan(40000);
    expect(encoding.maxBitrate).toBeLessThan(baseline.maxBitrate);
    for (let i = 0; i < 10; i++) await sample();
    expect(encoding).toEqual(baseline);
    const writesBeforeViewerLoss = sender.setParameters.mock.calls.length;
    await sample(95, 5);
    expect(video.setVideoFPS).toHaveBeenLastCalledWith(10);
    await sample(80, 20);
    expect(video.setVideoFPS).toHaveBeenLastCalledWith(4);
    expect(sound.setEnabled).toHaveBeenLastCalledWith(false);
    expect(video.setEnabled).not.toHaveBeenCalledWith(false);
    expect(mic.setEnabled).not.toHaveBeenCalled();
    expect(sender.setParameters).toHaveBeenCalledTimes(writesBeforeViewerLoss);
    await sample();
    await sample();
    expect(sound.setEnabled).toHaveBeenLastCalledWith(false);
    await sample();
    expect(video.setVideoFPS).toHaveBeenLastCalledWith(0);
    expect(sound.setEnabled).toHaveBeenLastCalledWith(true);
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
  const f = fixture();
  const videoClone = { kind: 'video', stop: vi.fn() }, audioClone = { kind: 'audio', stop: vi.fn() };
  const video = { kind: 'video', readyState: 'live', clone: vi.fn(() => videoClone), stop: vi.fn(), getSettings: () => ({ displaySurface: 'window' }) };
  const audio = { kind: 'audio', clone: vi.fn(() => audioClone), stop: vi.fn(), getSettings: () => ({ channelCount: 2 }) };
  try {
    const participant = (f.transport as any).media.localParticipant, published = new Map();
    participant.permissions = { canPublish: true, canPublishSources: [] };
    const capture = vi.fn(async (options: any) => ({ getVideoTracks: () => [video], getAudioTracks: () => options.audio ? [audio] : [], getTracks: () => options.audio ? [video, audio] : [video] }));
    (navigator.mediaDevices as any).getDisplayMedia = capture;
    participant.publishTrack = vi.fn(async (track: any, options: any) => {
      const publication = { audioTrack: track.kind === 'audio' ? track : undefined };
      published.set(options.source, publication);
      return publication;
    });
    participant.getTrackPublication = (source: string) => published.get(source);
    (f.socket as any).timeout = () => ({ emit: (_name: string, body: any, reply: any) => reply(null, { ok: true, data: { lease: { id: 'screen', policyRevision: 1, includeAudio: Boolean(body.includeAudio), maxFrameRate: 30 } } }) });
    await f.transport.startShare('720p15', { includeAudio: true });
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ windowAudio: 'window', systemAudio: 'include', audio: expect.objectContaining({ restrictOwnAudio: true }), selfBrowserSurface: 'exclude' }));
    expect(participant.publishTrack).toHaveBeenCalledWith(videoClone, expect.objectContaining({
      source: 'screen_share', videoCodec: 'vp8', simulcast: false, backupCodec: false,
      screenShareEncoding: { maxBitrate: 402000, maxFramerate: 15, priority: 'low' },
    }));
    expect(participant.publishTrack).toHaveBeenCalledWith(audioClone, expect.objectContaining({ source: 'screen_share_audio', forceStereo: true, audioPreset: { maxBitrate: 48000 } }));
    await f.transport.stopShare(); expect(video.stop).toHaveBeenCalled(); expect(audio.stop).toHaveBeenCalled();
    published.clear(); await f.transport.startShare('720p15', { includeAudio: false });
    expect(capture).toHaveBeenLastCalledWith(expect.objectContaining({ windowAudio: 'exclude', systemAudio: 'exclude', audio: false }));
    await f.transport.stopShare();
    published.clear();
    vi.stubGlobal('RTCRtpSender', {});
    vi.mocked(supportsVP9).mockReturnValueOnce(true);
    await f.transport.startShare('720p15', { includeAudio: false });
    expect(participant.publishTrack).toHaveBeenLastCalledWith(videoClone, expect.objectContaining({
      videoCodec: 'vp9', simulcast: false, backupCodec: false,
    }));
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
  const f = fixture(), stop = vi.fn(), stopClone = vi.fn();
  const video = { kind: 'video', readyState: 'live', stop, clone: () => ({ stop: stopClone }), getSettings: () => ({ displaySurface: 'window' }) };
  try {
    (navigator.mediaDevices as any).getDisplayMedia = async () => ({ getVideoTracks: () => [video], getAudioTracks: () => [], getTracks: () => [video] });
    const participant = (f.transport as any).media.localParticipant;
    participant.permissions = { canPublish: true, canPublishSources: [] };
    participant.publishTrack.mockRejectedValueOnce(new Error('SFU publication failed'));
    (f.socket as any).timeout = () => ({ emit: (_name: string, _body: any, reply: any) => reply(null, { ok: true, data: { lease: { id: 'screen', includeAudio: true, policyRevision: 1 } } }) });
    await expect(f.transport.startShare('720p15', { includeAudio: true })).rejects.toThrow('SFU publication failed');
    expect(stop).toHaveBeenCalled(); expect(stopClone).toHaveBeenCalled(); expect((f.transport as any).lease).toBeNull();
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
    await f.transport.setShareQuality('480p30',1500000);
    expect(parameters.encodings).toEqual([{active:true,maxBitrate:1452000,maxFramerate:30,scaleResolutionDownBy:1}]);
    expect(publication.options.screenShareEncoding).toEqual({maxBitrate:1452000,maxFramerate:30,priority:'low'});
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
