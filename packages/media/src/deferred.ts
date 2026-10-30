import type { Share } from '@dorham/contracts';
import type { MediaTransport, MediaOptions } from './index';
import { browserAudioProcessing, type AudioProcessing } from './audio-processing';
import type { ScreenQuality } from './screen-quality';

// Public chat never needs to parse or instantiate the RTC SDK. One adapter is
// loaded on the first explicit voice join, and stale loads are disposed safely.
export class DeferredTransport implements MediaTransport {
  private inner: MediaTransport | null = null; private loading: Promise<MediaTransport> | null = null;
  private muted = false; private deafened = false; private generation = 0; private destroyed = false;
  constructor(private mode: 'mesh' | 'livekit' | 'native', private options: MediaOptions) {}
  get room() { return this.inner?.room || null; }
  getCapabilities() { return this.inner?.getCapabilities() || { audio: typeof navigator.mediaDevices?.getUserMedia === 'function', screenCapture: typeof navigator.mediaDevices?.getDisplayMedia === 'function', nativeVideo: this.mode === 'native', amplification: true, microphoneGain: this.mode !== 'native', sharedAudio: this.mode === 'livekit' && (!(globalThis as any).desktop || Boolean((globalThis as any).desktop.systemAudioSafe)), outputSelection: typeof (AudioContext.prototype as any).setSinkId === 'function' }; }
  private load() {
    if (this.inner) return Promise.resolve(this.inner);
    if (!this.loading) { const epoch = this.generation;
      this.loading = (async () => {
        const inner: MediaTransport = this.mode === 'livekit' ? new (await import('./livekit')).LiveKitTransport(this.options) : this.mode === 'native' ? new (await import('./native')).NativeTransport(this.options) : new (await import('./mesh')).MeshTransport(this.options);
        if (this.destroyed || epoch !== this.generation) { await inner.destroy(); throw new Error('Voice connection was cancelled.'); }
        this.inner = inner;
        await inner.setMuted(this.muted); await inner.setDeafened(this.deafened); return inner;
      })().finally(() => { this.loading = null; });
    }
    return this.loading;
  }
  async join(channelId: string) { const epoch = this.generation, inner = await this.load(); if (epoch !== this.generation || this.destroyed) return; await inner.join(channelId); }
  async leave() { this.generation++; await this.inner?.leave(); }
  async destroy() { this.destroyed = true; this.generation++; await this.inner?.destroy(); this.inner = null; }
  async reconnect() { await this.inner?.reconnect(); }
  async setMuted(value: boolean) { this.muted = value; await this.inner?.setMuted(value); }
  async setDeafened(value: boolean) { this.deafened = value; await this.inner?.setDeafened(value); }
  setVolume(user: string, value: number) { this.inner?.setVolume(user, value); }
  setStreamVolume(lease: string, value: number) { this.inner?.setStreamVolume?.(lease, value); }
  async setDevice(value: string) { await this.inner?.setDevice(value); }
  async setOutputDevice(value: string) { await this.inner?.setOutputDevice?.(value); }
  getLocalAudioStream() { return this.inner?.getLocalAudioStream?.() || null; }
  getAudioProcessing() { return this.inner?.getAudioProcessing?.() || browserAudioProcessing(this.options.audioProcessing || { noiseSuppression: true, echoCancellation: true, autoGainControl: true }); }
  async setMicrophoneGain(value: number) { this.options.microphoneGain = value; await this.inner?.setMicrophoneGain?.(value); }
  async setAudioProcessing(value: AudioProcessing) { if (this.inner) await this.inner.setAudioProcessing?.(value); this.options.audioProcessing = { ...value }; }
  async startShare(quality?: ScreenQuality, options?: { includeAudio?: boolean }) { if (!this.inner?.room) throw new Error('Join a voice channel first.'); await this.inner.startShare(quality, options); }
  async setShareQuality(quality: ScreenQuality) { await this.inner?.setShareQuality(quality); }
  async stopShare() { await this.inner?.stopShare(); }
  async subscribe(share: Share, enabled: boolean) { await this.inner?.subscribe(share, enabled); }
  async getStats() { return await this.inner?.getStats() || {}; }
}
