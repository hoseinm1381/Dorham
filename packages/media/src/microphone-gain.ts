// This graph feeds the outgoing track only; it never monitors the mic locally.
export function clampMicrophoneGain(value: number) { return Number.isFinite(value) ? Math.max(0.5, Math.min(2.5, value)) : 1; }
export class MicrophoneGain {
  readonly name = 'dorham-microphone-gain';
  processedTrack?: MediaStreamTrack;
  private source?: MediaStreamAudioSourceNode;
  private node?: GainNode;
  private context?: AudioContext;
  private enabled = true;
  private value: number;
  constructor(value = 1) { this.value = clampMicrophoneGain(value); }
  setGain(value: number) { this.value = clampMicrophoneGain(value); this.apply(); }
  setEnabled(value: boolean) { this.enabled = value; this.apply(); }
  private apply() { if (this.node) this.node.gain.value = this.enabled ? this.value : 0; }
  async resume() { if (this.context?.state === 'suspended') await this.context.resume(); }
  async init({ track, audioContext }: { track: MediaStreamTrack; audioContext: AudioContext }) {
    await this.destroy();
    this.context = audioContext;
    this.source = audioContext.createMediaStreamSource(new MediaStream([track]));
    this.node = audioContext.createGain(); this.apply();
    const destination = audioContext.createMediaStreamDestination();
    this.source.connect(this.node).connect(destination);
    this.processedTrack = destination.stream.getAudioTracks()[0];
    await this.resume();
  }
  async restart(options: { track: MediaStreamTrack; audioContext: AudioContext }) { await this.init(options); }
  async destroy() {
    this.source?.disconnect(); this.node?.disconnect(); this.processedTrack?.stop();
    this.source = undefined; this.node = undefined; this.processedTrack = undefined; this.context = undefined;
  }
}
