import type { NoiseRemoval } from './strong-denoiser';
import { clampScreenBandwidth, screenSettings, type ScreenQuality } from './screen-quality';
import { Room, RoomEvent, ParticipantEvent, Track, type LocalAudioTrack, type RemoteTrack, type RemoteParticipant, type RemoteTrackPublication } from 'livekit-client';
import { MicrophoneGain, clampMicrophoneGain } from './microphone-gain';
import { waitForCondition } from './wait-condition';
import type { VoiceRoom, Share } from '@dorham/contracts';
import { ack } from './signaling';
import type { MediaOptions, MediaTransport } from './index';
import { defaultAudioProcessing, browserAudioProcessing, processingMismatch, type AudioProcessing } from './audio-processing';

export class LiveKitTransport implements MediaTransport {
  getCapabilities() { return { audio: typeof navigator.mediaDevices?.getUserMedia === 'function', screenCapture: typeof navigator.mediaDevices?.getDisplayMedia === 'function', nativeVideo: false, amplification: true, microphoneGain: true, sharedAudio: !(globalThis as any).desktop || Boolean((globalThis as any).desktop.systemAudioSafe), outputSelection: typeof (AudioContext.prototype as any).setSinkId === 'function' || (typeof HTMLMediaElement !== 'undefined' && typeof HTMLMediaElement.prototype.setSinkId === 'function') }; }
  async reconnect() { const channel = this.channelId; if (channel) { await this.leave(); await this.join(channel); } }
  private screenBandwidth?:number;
  private playbackContext = new AudioContext({ sampleRate: 48000 });
  room: VoiceRoom | null = null; private media = new Room({ webAudioMix: { audioContext: this.playbackContext }, adaptiveStream: true, dynacast: true, publishDefaults: { audioPreset: { maxBitrate: 24000 }, dtx: true, forceStereo: false } });
  private heartbeat?: ReturnType<typeof setInterval>; private channelId: string | null = null; private muted = false; private deafened = false;
  private volumes = new Map<string, number>(); private elements = new Map<string, HTMLMediaElement>(); private lease: Share | null = null;
  private playbackTask: Promise<void> | null = null;
  private inputGain = new MicrophoneGain(); private gainValue = 1;
  private microphoneTask: Promise<void> | null = null; private appliedMicrophone: boolean | undefined;
  private deliveredScreens = new Set<string>(); private hiddenScreens = new Set<string>();
  private watchedShares = new Set<string>(); private streamVolumes = new Map<string, number>();
  private sharePermissionWait: AbortController | null = null;
  private joining = false; private generation = 0;
  private audioProcessing: AudioProcessing = { ...defaultAudioProcessing };
  private captureProcessing: AudioProcessing = { ...defaultAudioProcessing };
  private onRoom = (r: VoiceRoom) => {
    if (r.channelId !== this.channelId) return; this.room = r; this.options.emit('room', r); this.applyVolumes(); this.updateSubscriptions();
    const own = r.shares.find(s => s.userId === this.options.userId);
    if (this.lease && own) { if (this.lease.tier === 'fallback' && own.tier === 'standard') this.options.emit('notice', '30fps is now available for your screen.'); this.lease = own; }
    for (const id of this.watchedShares) if (!r.shares.some(s => s.id === id)) this.watchedShares.delete(id);
    for (const id of this.deliveredScreens) if (!r.shares.some(s => s.id === id)) this.deliveredScreens.delete(id);
    for (const id of this.hiddenScreens) if (!r.shares.some(s => s.id === id)) this.hiddenScreens.delete(id);
    const self = r.members.find(m => m.user.id === this.options.userId);
    if (self && this.media.state === 'connected') void this.applyMicrophone().catch(e => this.options.emit('error', e.message));
    for (const participant of this.media.remoteParticipants.values()) for (const publication of participant.videoTrackPublications.values()) if (publication.track?.source === Track.Source.ScreenShare) this.deliverScreen(participant, publication.track);
    if (this.lease && !r.shares.some(s => s.id === this.lease!.id)) void this.stopShare();
  };
  private onMoved = (move: { channelId: string }) => { void this.leave().then(() => this.join(move.channelId)).catch(e => this.options.emit('error', e.message)); };
  private onRemoved = () => { void this.leave(); };
  private onConnect = () => { if (this.channelId && !this.joining) { const channel = this.channelId; void this.leave().then(() => this.join(channel)).catch(e => this.options.emit('error', e.message)); } };
  constructor(private options: MediaOptions) {
    this.audioProcessing = { ...defaultAudioProcessing, ...options.audioProcessing };
    this.gainValue = clampMicrophoneGain(options.microphoneGain ?? 1); void this.inputGain.setNoiseRemoval(this.options.noiseRemoval ?? 'standard'); this.inputGain.setGain(this.gainValue); this.inputGain.setClarity(this.options.voiceClarity !== false); this.inputGain.setNoiseFilter(this.options.boostNoise?.enabled !== false, this.options.boostNoise?.threshold);
    options.socket.on('voice:move', this.onMoved); options.socket.on('voice:room', this.onRoom); options.socket.on('voice:removed', this.onRemoved); options.socket.on('connect', this.onConnect);
    this.media.on(RoomEvent.TrackPublished, () => this.updateSubscriptions());
    this.media.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind === Track.Kind.Audio) {
        // The SDK owns the only audible graph. Wrapping a MediaStream-backed
        // element in createMediaElementSource can leave Chromium playback
        // outside that graph, bypassing our gain and deafen controls.
        const element = track.attach(); element.hidden = true; document.body.appendChild(element);
        this.elements.set(publication.trackSid, element);
        this.applyVolumes();
        void element.play().catch(e => this.options.emit('error', e.message));
      }
      if (track.source === Track.Source.ScreenShare) this.deliverScreen(participant, track);
    });
    this.media.on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => { track.detach().forEach(e => e.remove()); this.elements.delete(pub.trackSid); if (track.source === Track.Source.ScreenShare) { const share = this.room?.shares.find(s => s.userId === participant.identity.split(':')[0]); if (share) { this.deliveredScreens.delete(share.id); this.options.emit('screenRemoved', share.id); } } });
    this.media.on(RoomEvent.ActiveSpeakersChanged, speakers => { for (const m of this.room?.members || []) this.options.emit('speaking', { userId: m.user.id, speaking: speakers.some(p => p.identity.split(':')[0] === m.user.id) }); });
    this.media.on(RoomEvent.LocalTrackPublished, publication => { if (publication.source === Track.Source.ScreenShare) this.emitLocalScreen(); });
    this.media.on(RoomEvent.LocalTrackUnpublished, publication => { if (publication.source === Track.Source.ScreenShare && this.lease) void this.stopShare().catch(e => options.emit('error', e.message)); });
    this.media.on(RoomEvent.Reconnecting, () => options.emit('status', 'Reconnecting SFU…'));
    this.media.on(RoomEvent.Reconnected, () => { this.appliedMicrophone = undefined; this.applyVolumes(); this.updateSubscriptions(); void this.applyMicrophone().catch(e => options.emit('error', e.message)); options.emit('status', 'Voice connected through SFU'); });
  }
  async join(channelId: string) {
    if (this.channelId) await this.leave(); this.channelId = channelId; this.captureProcessing = { ...this.audioProcessing }; this.joining = true;
    const generation = ++this.generation, current = () => { if (generation !== this.generation) throw new Error('Voice connection was cancelled.'); };
    try {
      const result = await ack(this.options.socket, 'voice:join', { channelId, eligible: navigator.onLine }); current(); this.room = result.room;
      // Renew membership during slow ICE/signaling, before connect() completes.
      this.heartbeat = setInterval(() => { if (generation === this.generation) void ack(this.options.socket, 'voice:heartbeat', { eligible: true }).catch(e => this.options.emit('error', e.message)); }, 5000);
      const credentials = await ack(this.options.socket, 'voice:sfu', { channelId }); current(); await this.media.connect(credentials.url, credentials.token, { autoSubscribe: false }); current(); this.updateSubscriptions();
      await this.media.startAudio(); await this.state();
      this.options.emit('room', this.room); this.options.emit('status', 'Voice connected through SFU');
    } catch (e) { if (generation === this.generation) await this.leave(); throw e; } finally { if (generation === this.generation) this.joining = false; }
  }
  private microphoneEnabled() { const self = this.room?.members.find(m => m.user.id === this.options.userId); return !this.muted && !this.deafened && !self?.serverMuted && !self?.serverDeafened; }
  private async createMicrophone() {
    const generation = this.generation;
    const [track] = await this.media.localParticipant.createTracks({ audio: { ...this.captureProcessing }, video: false }) as LocalAudioTrack[];
    if (generation !== this.generation || !this.channelId) { track.stop(); throw new Error('Voice connection was cancelled.'); }
    const gain = new MicrophoneGain(this.gainValue); void gain.setNoiseRemoval(this.options.noiseRemoval ?? 'standard'); gain.setClarity(this.options.voiceClarity !== false); gain.setNoiseFilter(this.options.boostNoise?.enabled !== false, this.options.boostNoise?.threshold); gain.setEnabled(false); this.inputGain = gain;
    try {
      await track.mute(); await track.setProcessor(gain);
      if (generation !== this.generation || !this.channelId) throw new Error('Voice connection was cancelled.');
      await this.media.localParticipant.publishTrack(track, { source: Track.Source.Microphone });
    } catch (error) { track.stop(); await gain.destroy(); throw error; }
  }
  getNoiseRemoval() { return this.inputGain.getNoiseRemoval(); }
  async setNoiseRemoval(mode: NoiseRemoval) { this.options.noiseRemoval = mode; await this.inputGain.setNoiseRemoval(mode); await this.inputGain.resume(); }
  async setBoostNoise(value: { enabled: boolean; threshold: number }) { this.options.boostNoise = value; this.inputGain.setNoiseFilter(value.enabled, value.threshold); await this.inputGain.resume(); }
  async setVoiceClarity(enabled: boolean) { this.options.voiceClarity = enabled; this.inputGain.setClarity(enabled); await this.inputGain.resume(); }
  async setMicrophoneGain(value: number) {
    this.gainValue = clampMicrophoneGain(value); this.inputGain.setGain(this.gainValue); this.inputGain.setClarity(this.options.voiceClarity !== false); this.inputGain.setNoiseFilter(this.options.boostNoise?.enabled !== false, this.options.boostNoise?.threshold);
    if (this.channelId && this.media.state === 'connected') await this.applyMicrophone();
    this.inputGain.setGain(this.gainValue); this.inputGain.setClarity(this.options.voiceClarity !== false); this.inputGain.setNoiseFilter(this.options.boostNoise?.enabled !== false, this.options.boostNoise?.threshold);
    await this.inputGain.resume();
  }
  private gainProcessorMissing() {
    const track = this.media.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
    return Boolean(track?.getProcessor && (!track.getProcessor()?.processedTrack || track.getProcessor() !== this.inputGain));
  }
  private applyMicrophone(): Promise<void> {
    const track = this.media.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
    this.inputGain.setEnabled(this.microphoneEnabled());
    if (track && !this.microphoneEnabled()) track.mediaStreamTrack.enabled = false;
    if (!this.microphoneTask) this.microphoneTask = Promise.resolve().then(async () => {
      while (this.appliedMicrophone !== this.microphoneEnabled() || this.gainProcessorMissing()) {
        const self = this.room?.members.find(m => m.user.id === this.options.userId);
        if (!self?.serverMuted && !self?.serverDeafened && !this.media.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack) await this.createMicrophone();
        const existing = this.media.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
        if (existing?.getProcessor && (!existing.getProcessor()?.processedTrack || existing.getProcessor() !== this.inputGain)) {
          const gain = new MicrophoneGain(this.gainValue); void gain.setNoiseRemoval(this.options.noiseRemoval ?? 'standard'); gain.setClarity(this.options.voiceClarity !== false); gain.setNoiseFilter(this.options.boostNoise?.enabled !== false, this.options.boostNoise?.threshold); gain.setEnabled(false); this.inputGain = gain; await existing.setProcessor(gain);
        }
        const enabled = this.microphoneEnabled();
        await this.media.localParticipant.setMicrophoneEnabled(enabled, { ...this.captureProcessing });
        this.inputGain.setEnabled(this.microphoneEnabled());
        const current = this.media.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
        if (current) current.mediaStreamTrack.enabled = this.microphoneEnabled();
        this.appliedMicrophone = enabled;
      }
    }).finally(() => { this.microphoneTask = null; });
    return this.microphoneTask;
  }
  private deliverScreen(participant: RemoteParticipant, track: RemoteTrack) {
    const userId = participant.identity.split(':')[0], share = this.room?.shares.find(s => s.userId === userId);
    if (share && this.watchedShares.has(share.id) && !this.deliveredScreens.has(share.id) && !this.hiddenScreens.has(share.id)) { this.deliveredScreens.add(share.id); this.options.emit('screen', { userId, leaseId: share.id, stream: new MediaStream([track.mediaStreamTrack]), attach: element => { track.attach(element); return () => { track.detach(element); }; } }); }
  }
  private publishedState = ''; private stateTask: Promise<void> | null = null;
  private async state() {
    await this.applyMicrophone();
    if (!this.stateTask) this.stateTask = Promise.resolve().then(async () => {
      while (this.channelId && this.media.state === 'connected') {
        const key = JSON.stringify([this.channelId, this.generation, this.muted, this.deafened]);
        if (key === this.publishedState) break;
        await ack(this.options.socket, 'voice:state', { muted: this.muted, deafened: this.deafened, requestId: crypto.randomUUID() }); this.publishedState = key;
      }
    }).finally(() => { this.stateTask = null; });
    await this.stateTask;
  }
  async setMuted(value: boolean) { if (this.muted === value) return; this.muted = value; if (this.channelId && this.media.state === 'connected') await this.state(); }
  private applyVolumes() {
    const silent = this.deafened || this.room?.members.find(m => m.user.id === this.options.userId)?.serverDeafened;
    for (const p of this.media.remoteParticipants.values()) {
      const volume = silent ? 0 : this.volumes.get(p.identity.split(':')[0]) ?? 1;
      p.setVolume(volume, Track.Source.Microphone);
      const share = this.room?.shares.find(s => s.userId === p.identity.split(':')[0]);
      p.setVolume(silent || !share || !this.watchedShares.has(share.id) ? 0 : this.streamVolumes.get(share.id) ?? 1, Track.Source.ScreenShareAudio);
    }
  }
  async setDeafened(value: boolean) { this.deafened = value; this.applyVolumes(); if (this.channelId && this.media.state === 'connected') await this.state(); }
  private resumePlayback() {
    if (this.media.state !== 'connected' || this.playbackTask) return;
    // A volume gesture must also wake Chrome's suspended playback context.
    // Invoke the SDK immediately while the browser still has user activation.
    this.playbackTask = this.media.startAudio().then(() => this.applyVolumes())
      .catch(error => this.options.emit('error', error.message))
      .finally(() => { this.playbackTask = null; });
  }
  setVolume(userId: string, value: number) {
    this.volumes.set(userId, Math.max(0, Math.min(2, value))); this.applyVolumes();
    if (value > 0) this.resumePlayback();
  }
  setStreamVolume(leaseId: string, value: number) { this.streamVolumes.set(leaseId, Math.max(0, Math.min(2, value))); this.applyVolumes(); }
  async setOutputDevice(deviceId: string) { await this.media.switchActiveDevice('audiooutput', deviceId || 'default'); }
  getLocalAudioStream() { const track = this.media.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack?.mediaStreamTrack; return track ? new MediaStream([track]) : null; }
  async setDevice(deviceId: string) { await this.media.switchActiveDevice('audioinput', deviceId || 'default'); await this.setAudioProcessing(this.audioProcessing); }
  getAudioProcessing() { const track = this.media.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack; return browserAudioProcessing(this.audioProcessing, track?.mediaStreamTrack, this.captureProcessing, track?.getSourceTrackSettings()); }
  async setAudioProcessing(settings: AudioProcessing) {
    const track = this.media.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
    // Use the SDK's locked operation so its saved capture constraints also
    // survive device switches, track restarts and reconnects.
    if (track?.mediaStreamTrack.readyState === 'live') {
      await track.applyConstraints(settings);
      // Chromium can resolve applyConstraints while leaving processing active.
      // Restart only in that reported mismatch case; the SDK preserves isMuted.
      if (processingMismatch(track.mediaStreamTrack, settings, track.getSourceTrackSettings?.())) {
        if (!this.microphoneEnabled()) await track.mute();
        await track.restartTrack({ ...track.constraints, ...settings });
        if (!this.microphoneEnabled()) await track.mute();
      }
    }
    this.audioProcessing = { ...settings };
    this.captureProcessing = { ...settings };
  }
  private emitLocalScreen() { const track = this.media.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack; if (track && this.lease) this.options.emit('localScreen', { userId: this.options.userId, leaseId: this.lease.id, stream: new MediaStream([track.mediaStreamTrack]) }); }
  async startShare(quality: ScreenQuality = '720p15', options: { includeAudio?: boolean; bandwidth?:number } = {}) {
    const includeAudio = Boolean(options.includeAudio && this.getCapabilities().sharedAudio);
    const result = await ack(this.options.socket, 'share:start', { requestId: crypto.randomUUID(), protocolVersion: 2, includeAudio }); this.lease = result.lease;
    const wait = new AbortController(); this.sharePermissionWait = wait;
    try {
    if(quality.endsWith('30')&&(this.lease!.maxFrameRate||15)>=30){const updated=await ack(this.options.socket,'share:update',{requestId:crypto.randomUUID(),leaseId:this.lease!.id,expectedRevision:this.lease!.policyRevision,frameRate:30});this.lease=updated.lease;}
    this.screenBandwidth=options.bandwidth===undefined?undefined:clampScreenBandwidth(options.bandwidth);
    const settings = screenSettings(quality, this.options.screenPolicy, this.lease!, options.bandwidth), maxFramerate = settings.fps, maxBitrate = settings.bitrate;
      // The control-plane acknowledgement and SFU signaling are separate
      // connections. A committed lease does not mean the SDK has its grant yet.
      const participant = this.media.localParticipant;
      await waitForCondition(() => { const p = participant.permissions; return Boolean(p?.canPublish && (!p.canPublishSources.length || p.canPublishSources.includes(Track.sourceToProto(Track.Source.ScreenShare)))); }, check => { participant.on(ParticipantEvent.ParticipantPermissionsChanged, check); return () => participant.off(ParticipantEvent.ParticipantPermissionsChanged, check); }, wait.signal);
      await participant.setScreenShareEnabled(true, { audio: includeAudio ? { restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false, systemAudio: (globalThis as any).desktop ? 'include' : 'exclude', selfBrowserSurface: 'exclude', resolution: { width: settings.width, height: settings.height, frameRate: maxFramerate } }, { videoCodec: 'vp8', simulcast: false, screenShareEncoding: { maxBitrate, maxFramerate }, audioPreset: { maxBitrate: settings.audioBitrate || 48000 }, forceStereo: true });
      const audioSender = participant.getTrackPublication(Track.Source.ScreenShareAudio)?.audioTrack?.sender;
      if (audioSender) { const parameters = audioSender.getParameters(); for (const encoding of parameters.encodings || []) encoding.maxBitrate = settings.audioBitrate || 48000; await audioSender.setParameters(parameters); }
      if (includeAudio && !participant.getTrackPublication(Track.Source.ScreenShareAudio)) {
        const applied = await ack(this.options.socket, 'share:update', { requestId: crypto.randomUUID(), leaseId: this.lease!.id, expectedRevision: this.lease!.policyRevision, includeAudio: false }); this.lease = applied.lease;
        this.options.emit('notice', 'This capture source did not provide sound. Video sharing continues.');
      }
      this.emitLocalScreen();
    } catch (e) { await this.stopShare(); throw e; } finally { if (this.sharePermissionWait === wait) this.sharePermissionWait = null; }
  }
  async setShareQuality(quality: ScreenQuality, bandwidth?:number) {
    if (!this.lease) return;
    const frameRate = quality.endsWith('30') ? 30 : 15;
    const result = await ack(this.options.socket, 'share:update', { requestId: crypto.randomUUID(), leaseId: this.lease.id, expectedRevision: this.lease.policyRevision, frameRate }); this.lease = result.lease;
    try {
    const settings = screenSettings(quality, this.options.screenPolicy, this.lease!, bandwidth??this.screenBandwidth), track = this.media.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
    if (!track) return;
    await track.mediaStreamTrack.applyConstraints({ width: { ideal: settings.width, max: settings.width }, height: { ideal: settings.height, max: settings.height }, frameRate: { ideal: settings.fps, max: settings.fps } });
    if (track.sender) { const params = track.sender.getParameters(); for (const encoding of params.encodings || []) { encoding.maxBitrate = settings.bitrate; encoding.maxFramerate = settings.fps; } await track.sender.setParameters(params); }
    this.screenBandwidth=bandwidth??this.screenBandwidth;
    const publication=this.media.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    if(publication?.options)publication.options.screenShareEncoding={maxBitrate:settings.bitrate,maxFramerate:settings.fps};
    }catch(e){await this.stopShare();throw e;}
  }
  async stopShare() { this.sharePermissionWait?.abort(); this.sharePermissionWait = null; const lease = this.lease; this.lease = null; this.options.emit('localScreen', null); await this.media.localParticipant.setScreenShareEnabled(false); if (lease) await ack(this.options.socket, 'share:stop', { requestId: crypto.randomUUID() }).catch(() => {}); }
  private updateSubscriptions() {
    for (const participant of this.media.remoteParticipants.values()) {
      const share = this.room?.shares.find(s => s.userId === participant.identity.split(':')[0]);
      for (const publication of participant.trackPublications.values()) {
        const wanted = publication.source === Track.Source.Microphone || Boolean(share && this.watchedShares.has(share.id) && (publication.source === Track.Source.ScreenShare || (publication.source === Track.Source.ScreenShareAudio && share.includeAudio)));
        if (publication.isSubscribed !== wanted) publication.setSubscribed(wanted);
      }
    }
  }
  async subscribe(share: Share, enabled: boolean) { if (enabled) { this.hiddenScreens.delete(share.id); this.watchedShares.add(share.id); } else { this.hiddenScreens.add(share.id); this.watchedShares.delete(share.id); } this.updateSubscriptions(); this.applyVolumes(); if (!enabled) { this.deliveredScreens.delete(share.id); this.options.emit('screenRemoved', share.id); } }
  async getStats() { const participants: Record<string, any> = { audioProcessing: this.getAudioProcessing(), noiseRemoval: this.getNoiseRemoval() }; for (const p of this.media.remoteParticipants.values()) { const tracks = []; for (const t of p.trackPublications.values()) if (t.track) tracks.push(await t.track.getRTCStatsReport()); participants[p.identity] = { quality: p.connectionQuality, tracks }; } return participants; }
  async leave() { this.generation++; this.joining = false; const was = this.channelId; this.channelId = null; clearInterval(this.heartbeat); await this.stopShare().catch(() => {}); await this.microphoneTask?.catch(() => {}); await this.media.disconnect(); await this.inputGain.destroy(); this.appliedMicrophone = undefined; this.deliveredScreens.clear(); this.watchedShares.clear(); this.hiddenScreens.clear(); this.streamVolumes.clear(); for (const e of this.elements.values()) e.remove(); this.elements.clear(); if (was && this.options.socket.connected) await ack(this.options.socket, 'voice:leave', { requestId: crypto.randomUUID() }).catch(() => {}); this.room = null; this.options.emit('room', null); }
  async destroy() { await this.leave(); if (this.playbackContext.state !== 'closed') await this.playbackContext.close(); this.options.socket.off('voice:move', this.onMoved); this.options.socket.off('voice:room', this.onRoom); this.options.socket.off('voice:removed', this.onRemoved); this.options.socket.off('connect', this.onConnect); }
}
