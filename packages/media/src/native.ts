import { screenSettings, type ScreenQuality } from './screen-quality';
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Share, VoiceRoom, Signal } from '@dorham/contracts';
import { ack, type MediaOptions, type MediaTransport } from './index';
export const NativeMedia = registerPlugin<any>('DorhamMedia');
export class NativeTransport implements MediaTransport {
  getCapabilities() { return { audio: true, screenCapture: true, nativeVideo: true, amplification: true }; }
  async reconnect() { const channel = this.channelId; if (channel) { await this.leave(); await this.join(channel); } }
  room: VoiceRoom | null = null; private channelId: string | null = null; private epoch = ''; private muted = false; private deafened = false;
  private heartbeat?: ReturnType<typeof setInterval>; private handles: PluginListenerHandle[] = []; private lease: Share | null = null;
  private onRoom = (r: VoiceRoom) => { if (r.channelId === this.channelId) { this.room = r; void NativeMedia.updateRoom({ room: r, selfId: this.options.userId }); this.options.emit('room', r); if (this.lease && !r.shares.some(s => s.id === this.lease!.id)) void this.stopShare(); } };
  private onSignal = (s: Signal) => { if (s.channelId === this.channelId) void NativeMedia.signal({ signal: s }); };
  private onMoved = (move: { channelId: string }) => { void this.leave().then(() => this.join(move.channelId)).catch(e => this.options.emit('error', e.message)); };
  private onRemoved = () => { void this.leave(); };
  private onPulse = () => { if (this.channelId && this.options.socket.connected) void ack(this.options.socket, 'voice:heartbeat', { eligible: true }).catch(e => this.options.emit('error', e.message)); };
  private onConnect = () => { if (this.channelId) { const channel = this.channelId; void this.leave().then(() => this.join(channel)).catch(e => this.options.emit('error', e.message)); } };
  constructor(private options: MediaOptions) { options.socket.on('voice:move', this.onMoved); options.socket.on('voice:room', this.onRoom); options.socket.on('voice:signal', this.onSignal); options.socket.on('voice:removed', this.onRemoved); options.socket.on('connect', this.onConnect); window.addEventListener('dorham-native-pulse', this.onPulse); }
  async join(channelId: string) {
    if (this.channelId) await this.leave(); this.channelId = channelId;
    try {
      this.handles.push(await NativeMedia.addListener('signal', (s: any) => { void ack(this.options.socket, 'voice:signal', { ...s, channelId, epoch: this.epoch }).catch(e => this.options.emit('error', e.message)); }));
      this.handles.push(await NativeMedia.addListener('error', (e: any) => this.options.emit('error', e.message)));
      this.handles.push(await NativeMedia.addListener('speaking', (e: any) => this.options.emit('speaking', e)));
      this.handles.push(await NativeMedia.addListener('captureStopped', () => { void this.stopShare(); }));
      this.handles.push(await NativeMedia.addListener('voiceStopped', () => { void this.leave(); }));
      this.handles.push(await NativeMedia.addListener('video', (e: any) => this.options.emit('nativeVideo', e)));
      await NativeMedia.prepare();
      const result = await ack(this.options.socket, 'voice:join', { channelId, eligible: true }); this.epoch = result.epoch; this.room = result.room;
      const credentials = result.room.transport === 'livekit' ? await ack(this.options.socket, 'voice:sfu', { channelId }) : null;
      await NativeMedia.join({ selfId: this.options.userId, epoch: this.epoch, iceServers: result.iceServers, room: this.room, credentials });
      await this.state();
      this.heartbeat = setInterval(() => { void ack(this.options.socket, 'voice:heartbeat', { eligible: true }).catch(e => this.options.emit('error', e.message)); }, 5000);
      this.options.emit('room', this.room); this.options.emit('status', 'Native voice connected');
    } catch (e) { await this.leave(); throw e; }
  }
  private async state() { await NativeMedia.setState({ muted: this.muted, deafened: this.deafened }); await ack(this.options.socket, 'voice:state', { muted: this.muted, deafened: this.deafened, requestId: crypto.randomUUID() }); }
  async setMuted(value: boolean) { this.muted = value; await this.state(); }
  async setDeafened(value: boolean) { this.deafened = value; await this.state(); }
  setVolume(userId: string, value: number) { void NativeMedia.setVolume({ userId, volume: value }); }
  async setDevice(deviceId: string) { await NativeMedia.setDevice({ deviceId }); }
  async startShare(quality: ScreenQuality = '720p15') {
    const result = await ack(this.options.socket, 'share:start', { requestId: crypto.randomUUID() }); this.lease = result.lease;
    try { await NativeMedia.startShare({ leaseId: this.lease!.id, quality, ...screenSettings(quality, this.options.screenPolicy) }); } catch (e) { await this.stopShare(); throw e; }
  }
  async setShareQuality(quality: ScreenQuality) { await NativeMedia.setShareQuality({ quality, ...screenSettings(quality, this.options.screenPolicy) }); }
  async stopShare() { const lease = this.lease; this.lease = null; await NativeMedia.stopShare(); if (lease && this.options.socket.connected) await ack(this.options.socket, 'share:stop', { requestId: crypto.randomUUID() }).catch(() => {}); }
  async subscribe(share: Share, enabled: boolean) { await NativeMedia.subscribe({ userId: share.userId, leaseId: share.id, enabled }); }
  async getStats() { return NativeMedia.getStats(); }
  async leave() { const was = this.channelId; this.channelId = null; clearInterval(this.heartbeat); await this.stopShare().catch(() => {}); await NativeMedia.leave().catch(() => {}); for (const h of this.handles) await h.remove(); this.handles = []; if (was && this.options.socket.connected) await ack(this.options.socket, 'voice:leave', { requestId: crypto.randomUUID() }).catch(() => {}); this.room = null; this.options.emit('room', null); }
  async destroy() { await this.leave(); this.options.socket.off('voice:move', this.onMoved); window.removeEventListener('dorham-native-pulse', this.onPulse); this.options.socket.off('voice:room', this.onRoom); this.options.socket.off('voice:signal', this.onSignal); this.options.socket.off('voice:removed', this.onRemoved); this.options.socket.off('connect', this.onConnect); }
}
