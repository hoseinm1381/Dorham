import { screenSettings, shareHeight, type ScreenQuality } from './screen-quality';
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Share, VoiceRoom, Signal } from '@dorham/contracts';
import { ack } from './signaling';
import type { MediaOptions, MediaTransport, RemoteScreen } from './index';
import { listenOnlyNotice } from './microphone-access';
import { VoiceRecovery } from './voice-recovery';
export const NativeMedia = registerPlugin<any>('DorhamMedia');
export class NativeTransport implements MediaTransport {
  getCapabilities() { return { audio: true, screenCapture: true, nativeVideo: true, amplification: true, sharedAudio: this.audioSupported && this.auxiliaryAudioSupported && this.room?.transport === 'livekit' }; }
  async reconnect() { const channel = this.channelId; if (channel && !this.recovery.request()) { await this.leave(); await this.join(channel); } }
  room: VoiceRoom | null = null; private channelId: string | null = null; private epoch = ''; private muted = false; private deafened = false;
  private auxiliaryAudioSupported = false; private audioSupported = false; private captureActive = false; private captureGeneration = 0; private delivered = new Set<string>(); private localLeaseId: string | null = null;
  private connected = false; private listenOnly = false; private joining = false; private generation = 0;
  private recovery: VoiceRecovery;
  private iceServers: unknown[] = [];
  private heartbeatAt = -Infinity;
  private nativePulseAt = -Infinity;
  private heartbeatBusy = false;
  private leaving?: Promise<void>;
  private setListenOnly(value: boolean) { if (this.listenOnly === value) return; this.listenOnly = value; this.options.emit('listenOnly', value); if (value) this.options.emit('notice', listenOnlyNotice); }
  private heartbeat?: ReturnType<typeof setInterval>; private handles: PluginListenerHandle[] = []; private lease: Share | null = null;
  private onRoom = (r: VoiceRoom) => { if (r.channelId === this.channelId) { this.room = r;const own=r.shares.find(s=>s.userId===this.options.userId);if (this.lease && own) { const previous = this.lease; this.lease = own; if (!this.updatingScreenQuality && previous.maxHeight === 1080 && (own.maxHeight !== 1080 || previous.maxBitrate !== own.maxBitrate)) void this.applyScreenQuality(own.maxHeight === 1080 ? '1080p15' : '720p15').catch(error => this.options.emit('error', error.message)); } void NativeMedia.updateRoom({ room: r, selfId: this.options.userId }).catch((error: Error) => this.options.emit('error', error.message)); this.publishScreens(); this.options.emit('room', r); if (this.lease && !r.shares.some(s => s.id === this.lease!.id)) void this.stopShare(); } };
  private onSignal = (s: Signal) => { if (s.channelId === this.channelId) void NativeMedia.signal({ signal: s }); };
  private onMoved = (move: { channelId: string }) => { void this.leave().then(() => this.join(move.channelId)).catch(e => this.options.emit('error', e.message)); };
  private onRemoved = (event?: { epoch?: string }) => { if (this.channelId && (!event?.epoch || event.epoch === this.epoch)) void this.leave(false); };
  private onPulse = () => {
    this.nativePulseAt = performance.now();
    this.sendHeartbeat();
  };
  private sendHeartbeat() {
    const now = performance.now(), generation = this.generation;
    if (!this.epoch || !this.channelId || !this.options.socket.connected || this.recovery.pending || this.heartbeatBusy || now - this.heartbeatAt < 5000) return;
    this.heartbeatAt = now;
    this.heartbeatBusy = true;
    void ack(this.options.socket, 'voice:heartbeat', { eligible: true })
      .catch(error => { if (generation === this.generation && !this.recovery.request()) this.options.emit('error', error.message); })
      .finally(() => { if (generation === this.generation) this.heartbeatBusy = false; });
  }
  private onConnect = () => { if (this.channelId && !this.joining && !this.recovery.supported) void this.reconnect().catch(e => this.options.emit('error', e.message)); };
  private endRecovery() {
    this.options.emit('notice', 'Voice disconnected. Rejoin to reconnect.');
    void this.leave(false);
  }
  private async connectMedia(room: VoiceRoom, current: () => boolean, recovering = false) {
    const credentials = room.transport === 'livekit' ? await ack(this.options.socket, 'voice:sfu', { channelId: room.channelId }) : null;
    if (!current()) return;
    this.auxiliaryAudioSupported = credentials?.nativeScreenAudio === true;
    const joined = await NativeMedia.join({
      selfId: this.options.userId, epoch: this.epoch, iceServers: this.iceServers, room, credentials,
      muted: this.muted || this.listenOnly, deafened: this.deafened, recovering,
      language: globalThis.document?.documentElement.lang || 'en-US', channelName: this.options.channelName?.(room.channelId) || 'Voice channel',
    });
    if (!current()) return;
    this.setListenOnly(this.listenOnly || joined?.listenOnly === true);
    this.connected = true;
  }
  private async restoreVoice(room: VoiceRoom, current: () => boolean) {
    if (!this.connected) {
      await this.stopShare().catch(() => {});
      if (!current()) return;
      await this.connectMedia(room, current, true);
    }
    if (!current()) return;
    this.onRoom(room);
    await this.state();
    if (current() && !this.connected) throw new Error('Voice media disconnected during recovery.');
    if (current() && this.connected) this.options.emit('status', 'Native voice connected');
  }
  constructor(private options: MediaOptions) {
    this.recovery = new VoiceRecovery(options.socket, {
      waiting: () => options.emit('status', 'Reconnecting voice…'),
      restore: ({ room }, current) => this.restoreVoice(room, current),
      ended: () => this.endRecovery(),
    });
    options.socket.on('voice:move', this.onMoved);
    options.socket.on('voice:room', this.onRoom);
    options.socket.on('voice:signal', this.onSignal);
    options.socket.on('voice:removed', this.onRemoved);
    options.socket.on('connect', this.onConnect);
    window.addEventListener('dorham-native-pulse', this.onPulse);
  }
  async join(channelId: string) {
    if (this.leaving) await this.leaving;
    if (this.channelId) await this.leave();
    this.channelId = channelId;
    this.joining = true;
    this.setListenOnly(false);
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    const checkCurrent = () => { if (!current()) throw new Error('Voice connection was cancelled.'); };
    const listen = async (name: string, handler: (event: any) => void) => {
      const handle = await NativeMedia.addListener(name, (event: any) => { if (current()) handler(event); });
      if (!current()) { await handle.remove(); checkCurrent(); }
      this.handles.push(handle);
    };
    try {
      await listen('signal', s => { if (this.options.socket.connected) void ack(this.options.socket, 'voice:signal', { ...s, channelId, epoch: this.epoch }).catch(e => this.options.emit('error', e.message)); });
      await listen('error', e => this.options.emit('error', e.message));
      await listen('listenOnly', () => { this.setListenOnly(true); void this.state().catch(e => this.options.emit('error', e.message)); });
      await listen('speaking', e => this.options.emit('speaking', e));
      await listen('captureStopped', () => { void this.stopShare(); });
      await listen('voiceStopped', () => { void this.leave(); });
      await listen('voiceMediaDisconnected', event => {
        if (this.joining) return;
        this.connected = false;
        if (event.terminal || !this.recovery.request()) this.endRecovery();
      });
      await listen('video', () => this.publishScreens());
      await listen('status', event => { if (!this.recovery.pending) this.options.emit('status', event.message); });
      await listen('nativeMuted', event => { window.dispatchEvent(new CustomEvent('dorham-native-mute', { detail: event.muted })); });
      const prepared = await NativeMedia.prepare();
      checkCurrent();
      this.setListenOnly(prepared?.microphoneAvailable === false);
      this.audioSupported = prepared?.sharedAudio === true;
      const result = await ack(this.options.socket, 'voice:join', { channelId, eligible: true, recoverable: true });
      checkCurrent();
      this.epoch = result.epoch;
      this.room = result.room;
      this.iceServers = result.iceServers;
      this.heartbeatAt = performance.now();
      this.heartbeat = setInterval(() => {
        if (performance.now() - this.nativePulseAt >= 7500) this.sendHeartbeat();
      }, 5000);
      await this.connectMedia(result.room, current);
      checkCurrent();
      await this.state();
      checkCurrent();
      this.recovery.remember(channelId, result);
      this.options.emit('room', this.room); this.options.emit('status', 'Native voice connected');
      if (!this.options.socket.connected) this.recovery.request();
    } catch (e) { if (current()) await this.leave(); throw e; } finally { if (current()) this.joining = false; }
  }
  private async state() { if (!this.connected || !this.channelId) return; const generation = this.generation, muted = this.muted || this.listenOnly, deafened = this.deafened; await NativeMedia.setState({ muted, deafened }); if (generation === this.generation && this.options.socket.connected) await ack(this.options.socket, 'voice:state', { muted, deafened }); }
  async setMuted(value: boolean) { this.muted = value; await this.state(); }
  async setDeafened(value: boolean) { this.deafened = value; await this.state(); }
  setVolume(userId: string, value: number) { void NativeMedia.setVolume({ userId, volume: value }); }
  setStreamVolume(leaseId: string, volume: number) { void NativeMedia.setStreamVolume({ leaseId, volume }).catch((error: Error) => this.options.emit('error', error.message)); }
  async setDevice(deviceId: string) { await NativeMedia.setDevice({ deviceId }); }
  async startShare(quality: ScreenQuality = '720p15', options:{includeAudio?:boolean; bandwidth?:number}={}) {
    const generation = ++this.captureGeneration; const includeAudio = Boolean(options.includeAudio && this.getCapabilities().sharedAudio);
    const result = await ack(this.options.socket, 'share:start', { requestId: crypto.randomUUID(),protocolVersion:2, includeAudio, ...shareHeight(quality) }); this.lease = result.lease;
    try { if(quality.endsWith('30')&&(this.lease!.maxFrameRate||15)>=30){const updated=await ack(this.options.socket,'share:update',{requestId:crypto.randomUUID(),leaseId:this.lease!.id,expectedRevision:this.lease!.policyRevision,frameRate:30});this.lease=updated.lease;}const audioCredentials = includeAudio ? await ack(this.options.socket, 'voice:sfu', { channelId: this.channelId, purpose: 'screenAudio', leaseId: this.lease!.id }) : null;
      if (includeAudio && audioCredentials?.identity !== `${this.options.userId}:${this.epoch}:screen:${this.lease!.id}`) throw new Error('Sound sharing requires the updated server.');
      await NativeMedia.startShare({ leaseId: this.lease!.id, quality: quality === '1080p15' && this.lease?.maxHeight !== 1080 ? '720p15' : quality, includeAudio, audioCredentials, ...screenSettings(quality, this.options.screenPolicy,this.lease!,options.bandwidth) }); if (generation !== this.captureGeneration || !this.channelId) { await NativeMedia.stopShare(); return; } this.captureActive = true; this.publishScreens(); } catch (e) { await this.stopShare(); throw e; }
  }
  private updatingScreenQuality = false;
  async setShareQuality(quality: ScreenQuality, bandwidth?: number) {
    if (!this.lease) return;
    this.updatingScreenQuality = true;
    try {
      const result = await ack(this.options.socket, 'share:update', { requestId: crypto.randomUUID(), leaseId: this.lease.id, expectedRevision: this.lease.policyRevision, frameRate: quality.endsWith('30') ? 30 : 15, ...shareHeight(quality, this.lease.maxHeight) });
      this.lease = result.lease;
      await this.applyScreenQuality(quality, bandwidth);
    } finally { this.updatingScreenQuality = false; }
  }
  private async applyScreenQuality(requested: ScreenQuality, bandwidth?: number) {
    if (!this.captureActive || !this.lease) return;
    const quality = requested === '1080p15' && this.lease.maxHeight !== 1080 ? '720p15' : requested;
    await NativeMedia.setShareQuality({ quality, ...screenSettings(quality, this.options.screenPolicy, this.lease, bandwidth) });
  }
  private publishScreens() {
    const active = new Set(this.room?.shares.filter(share => share.userId !== this.options.userId).map(share => share.id) || []);
    for (const id of this.delivered) if (!active.has(id)) { this.delivered.delete(id); this.options.emit('screenRemoved', id); }
    for (const share of this.room?.shares || []) {
      const local = share.userId === this.options.userId; if (local && (!this.captureActive || this.localLeaseId === share.id)) continue; if (!local && this.delivered.has(share.id)) continue;
      const screen: RemoteScreen = { userId: share.userId, leaseId: share.id, stream: new MediaStream(), native: { local }, ...(local ? { sourceName: 'Phone screen', audioScope: share.includeAudio ? 'system' as const : 'none' as const } : {}) };
      if (local) { this.localLeaseId = share.id; this.options.emit('localScreen', screen); } else { this.delivered.add(share.id); this.options.emit('screen', screen); }
    }
  }
  async stopShare() { this.captureGeneration++; this.captureActive = false; this.localLeaseId = null; this.options.emit('localScreen', null); const lease = this.lease; this.lease = null; await NativeMedia.stopShare(); if (lease && this.options.socket.connected) await ack(this.options.socket, 'share:stop', { requestId: crypto.randomUUID() }).catch(() => {}); }
  async subscribe(share: Share, enabled: boolean) { await NativeMedia.subscribe({ userId: share.userId, leaseId: share.id, enabled }); }
  async getStats() { return NativeMedia.getStats(); }
  leave(notifyServer = true) {
    this.leaving ??= this.finishLeave(notifyServer).finally(() => { this.leaving = undefined; });
    return this.leaving;
  }
  private async finishLeave(notifyServer: boolean) {
    const was = this.channelId, ticket = this.recovery.cancel(), handles = this.handles;
    this.generation++;
    this.handles = [];
    this.joining = false;
    this.connected = false;
    this.channelId = null;
    this.epoch = '';
    this.setListenOnly(false);
    clearInterval(this.heartbeat);
    this.heartbeatBusy = false;
    this.nativePulseAt = -Infinity;
    const notify = notifyServer && was && this.options.socket.connected ? ack(this.options.socket, 'voice:leave', ticket ?? {}).catch(() => {}) : undefined;
    await this.stopShare().catch(() => {});
    await NativeMedia.leave().catch(() => {});
    for (const handle of handles) await handle.remove().catch(() => {});
    this.room = null;
    this.delivered.clear();
    this.options.emit('room', null);
    await notify;
  }
  async destroy() { await this.leave(); this.recovery.destroy(); this.options.socket.off('voice:move', this.onMoved); window.removeEventListener('dorham-native-pulse', this.onPulse); this.options.socket.off('voice:room', this.onRoom); this.options.socket.off('voice:signal', this.onSignal); this.options.socket.off('voice:removed', this.onRemoved); this.options.socket.off('connect', this.onConnect); }
}
