import { screenSettings, type ScreenQuality } from './screen-quality';
import { Room, RoomEvent, Track, type RemoteTrack, type RemoteParticipant, type RemoteTrackPublication } from 'livekit-client';
import type { VoiceRoom, Share } from '@dorham/contracts';
import { ack, type MediaOptions, type MediaTransport } from './index';
import { defaultAudioProcessing, browserAudioProcessing, type AudioProcessing } from './audio-processing';

export class LiveKitTransport implements MediaTransport {
  getCapabilities() { return { audio: typeof navigator.mediaDevices?.getUserMedia === 'function', screenCapture: typeof navigator.mediaDevices?.getDisplayMedia === 'function', nativeVideo: false, amplification: true }; }
  async reconnect() { const channel = this.channelId; if (channel) { await this.leave(); await this.join(channel); } }
  room: VoiceRoom | null = null; private media = new Room({ adaptiveStream: true, dynacast: true, publishDefaults: { audioPreset: { maxBitrate: 24000 }, dtx: true, forceStereo: false } });
  private heartbeat?: ReturnType<typeof setInterval>; private channelId: string | null = null; private muted = false; private deafened = false;
  private volumes = new Map<string, number>(); private elements = new Map<string, HTMLMediaElement>(); private lease: Share | null = null;
  private context: AudioContext | null = null; private audio = new Map<string, { source: MediaElementAudioSourceNode; gain: GainNode }>();
  private audioProcessing: AudioProcessing = { ...defaultAudioProcessing };
  private captureProcessing: AudioProcessing = { ...defaultAudioProcessing };
  private onRoom = (r: VoiceRoom) => {
    if (r.channelId !== this.channelId) return; this.room = r; this.options.emit('room', r); this.applyVolumes();
    const self = r.members.find(m => m.user.id === this.options.userId);
    if (self && this.media.state === 'connected') void this.media.localParticipant.setMicrophoneEnabled(!this.muted && !this.deafened && !self.serverMuted && !self.serverDeafened, { ...this.captureProcessing, autoGainControl: true }).catch(e => this.options.emit('error', e.message));
    if (this.lease && !r.shares.some(s => s.id === this.lease!.id)) void this.stopShare();
  };
  private onMoved = (move: { channelId: string }) => { void this.leave().then(() => this.join(move.channelId)).catch(e => this.options.emit('error', e.message)); };
  private onRemoved = () => { void this.leave(); };
  private onConnect = () => { if (this.channelId) { const channel = this.channelId; void this.leave().then(() => this.join(channel)).catch(e => this.options.emit('error', e.message)); } };
  constructor(private options: MediaOptions) {
    this.audioProcessing = { ...defaultAudioProcessing, ...options.audioProcessing };
    options.socket.on('voice:move', this.onMoved); options.socket.on('voice:room', this.onRoom); options.socket.on('voice:removed', this.onRemoved); options.socket.on('connect', this.onConnect);
    this.media.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      const userId = participant.identity.split(':')[0];
      if (track.kind === Track.Kind.Audio && this.context) {
        const element = track.attach(); element.hidden = true; document.body.appendChild(element);
        const source = this.context.createMediaElementSource(element), gain = this.context.createGain();
        gain.gain.value = (this.deafened || this.room?.members.find(m => m.user.id === this.options.userId)?.serverDeafened) ? 0 : this.volumes.get(userId) ?? 1; source.connect(gain); gain.connect(this.context.destination);
        this.elements.set(publication.trackSid, element); this.audio.set(publication.trackSid, { source, gain });
        void element.play().catch(e => this.options.emit('error', e.message));
      }
      if (track.source === Track.Source.ScreenShare) { const share = this.room?.shares.find(s => s.userId === userId); if (share) this.options.emit('screen', { userId, leaseId: share.id, stream: new MediaStream([track.mediaStreamTrack]) }); }
    });
    this.media.on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => { track.detach().forEach(e => e.remove()); const nodes = this.audio.get(pub.trackSid); nodes?.source.disconnect(); nodes?.gain.disconnect(); this.audio.delete(pub.trackSid); this.elements.delete(pub.trackSid); if (track.source === Track.Source.ScreenShare) { const share = this.room?.shares.find(s => s.userId === participant.identity.split(':')[0]); if (share) this.options.emit('screenRemoved', share.id); } });
    this.media.on(RoomEvent.ActiveSpeakersChanged, speakers => { for (const m of this.room?.members || []) this.options.emit('speaking', { userId: m.user.id, speaking: speakers.some(p => p.identity.split(':')[0] === m.user.id) }); });
    this.media.on(RoomEvent.LocalTrackPublished, publication => { if (publication.source === Track.Source.ScreenShare) this.emitLocalScreen(); });
    this.media.on(RoomEvent.LocalTrackUnpublished, publication => { if (publication.source === Track.Source.ScreenShare && this.lease) void this.stopShare().catch(e => options.emit('error', e.message)); });
    this.media.on(RoomEvent.Reconnecting, () => options.emit('status', 'Reconnecting SFU…'));
    this.media.on(RoomEvent.Reconnected, () => options.emit('status', 'Voice connected through SFU'));
  }
  async join(channelId: string) {
    if (this.channelId) await this.leave(); this.channelId = channelId; this.captureProcessing = { ...this.audioProcessing };
    try {
      const result = await ack(this.options.socket, 'voice:join', { channelId, eligible: navigator.onLine }); this.room = result.room;
      this.context = new AudioContext(); await this.context.resume();
      const credentials = await ack(this.options.socket, 'voice:sfu', { channelId }); await this.media.connect(credentials.url, credentials.token);
      await this.media.startAudio(); await this.state();
      this.heartbeat = setInterval(() => { void ack(this.options.socket, 'voice:heartbeat', { eligible: true }).catch(e => this.options.emit('error', e.message)); }, 5000);
      this.options.emit('room', this.room); this.options.emit('status', 'Voice connected through SFU');
    } catch (e) { await this.leave(); throw e; }
  }
  private async state() { await this.media.localParticipant.setMicrophoneEnabled(!this.muted && !this.deafened && !this.room?.members.find(m => m.user.id === this.options.userId)?.serverMuted && !this.room?.members.find(m => m.user.id === this.options.userId)?.serverDeafened, { ...this.captureProcessing, autoGainControl: true }); await ack(this.options.socket, 'voice:state', { muted: this.muted, deafened: this.deafened, requestId: crypto.randomUUID() }); }
  async setMuted(value: boolean) { this.muted = value; await this.state(); }
  private applyVolumes() { for (const p of this.media.remoteParticipants.values()) for (const publication of p.audioTrackPublications.values()) { const node = this.audio.get(publication.trackSid); if (node) node.gain.gain.value = (this.deafened || this.room?.members.find(m => m.user.id === this.options.userId)?.serverDeafened) ? 0 : this.volumes.get(p.identity.split(':')[0]) ?? 1; } }
  async setDeafened(value: boolean) { this.deafened = value; await this.state(); this.applyVolumes(); }
  setVolume(userId: string, value: number) { this.volumes.set(userId, Math.max(0, Math.min(2, value))); this.applyVolumes(); }
  async setDevice(deviceId: string) { await this.media.switchActiveDevice('audioinput', deviceId); }
  getAudioProcessing() { return browserAudioProcessing(this.audioProcessing, this.media.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack?.mediaStreamTrack, this.captureProcessing); }
  async setAudioProcessing(settings: AudioProcessing) {
    this.audioProcessing = { ...settings };
  }
  private emitLocalScreen() { const track = this.media.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack; if (track && this.lease) this.options.emit('localScreen', { userId: this.options.userId, leaseId: this.lease.id, stream: new MediaStream([track.mediaStreamTrack]) }); }
  async startShare(quality: ScreenQuality = '720p15') {
    const result = await ack(this.options.socket, 'share:start', { requestId: crypto.randomUUID() }); this.lease = result.lease;
    const settings = screenSettings(quality, this.options.screenPolicy), maxFramerate = settings.fps, maxBitrate = settings.bitrate;
    try { await this.media.localParticipant.setScreenShareEnabled(true, { audio: false, resolution: { width: settings.width, height: settings.height, frameRate: maxFramerate } }, { videoCodec: 'vp8', simulcast: false, screenShareEncoding: { maxBitrate, maxFramerate } }); this.emitLocalScreen(); } catch (e) { await this.stopShare(); throw e; }
  }
  async setShareQuality(quality: ScreenQuality) {
    const settings = screenSettings(quality, this.options.screenPolicy), track = this.media.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
    if (!track) return;
    await track.mediaStreamTrack.applyConstraints({ width: { ideal: settings.width, max: settings.width }, height: { ideal: settings.height, max: settings.height }, frameRate: { ideal: settings.fps, max: settings.fps } });
    if (track.sender) { const params = track.sender.getParameters(); for (const encoding of params.encodings || []) { encoding.maxBitrate = settings.bitrate; encoding.maxFramerate = settings.fps; } await track.sender.setParameters(params); }
  }
  async stopShare() { const lease = this.lease; this.lease = null; this.options.emit('localScreen', null); await this.media.localParticipant.setScreenShareEnabled(false); if (lease) await ack(this.options.socket, 'share:stop', { requestId: crypto.randomUUID() }).catch(() => {}); }
  async subscribe(share: Share, enabled: boolean) { for (const p of this.media.remoteParticipants.values()) if (p.identity.split(':')[0] === share.userId) for (const publication of p.videoTrackPublications.values()) if (publication.source === Track.Source.ScreenShare) publication.setSubscribed(enabled); if (!enabled) this.options.emit('screenRemoved', share.id); }
  async getStats() { const participants: Record<string, any> = { audioProcessing: this.getAudioProcessing() }; for (const p of this.media.remoteParticipants.values()) { const tracks = []; for (const t of p.trackPublications.values()) if (t.track) tracks.push(await t.track.getRTCStatsReport()); participants[p.identity] = { quality: p.connectionQuality, tracks }; } return participants; }
  async leave() { const was = this.channelId; this.channelId = null; clearInterval(this.heartbeat); await this.stopShare().catch(() => {}); await this.media.disconnect(); for (const e of this.elements.values()) e.remove(); this.elements.clear(); for (const node of this.audio.values()) { node.source.disconnect(); node.gain.disconnect(); } this.audio.clear(); await this.context?.close(); this.context = null; if (was && this.options.socket.connected) await ack(this.options.socket, 'voice:leave', { requestId: crypto.randomUUID() }).catch(() => {}); this.room = null; this.options.emit('room', null); }
  async destroy() { await this.leave(); this.options.socket.off('voice:move', this.onMoved); this.options.socket.off('voice:room', this.onRoom); this.options.socket.off('voice:removed', this.onRemoved); this.options.socket.off('connect', this.onConnect); }
}
