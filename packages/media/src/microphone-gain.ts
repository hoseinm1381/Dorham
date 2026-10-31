import { VoiceClarity } from './voice-clarity';
import { BoostNoiseFilter } from './boost-noise-filter';
import { StrongDenoiser, type NoiseRemoval, type NoiseRemovalState } from './strong-denoiser';
// This graph feeds the outgoing track only; it never monitors the mic locally.
export const maximumMicrophoneGain = 10 ** (45 / 20);
export function clampMicrophoneGain(value: number) { return Number.isFinite(value) ? Math.max(0.5, Math.min(maximumMicrophoneGain, value)) : 1; }
export class MicrophoneGain {
  readonly name = 'dorham-microphone-gain';
  processedTrack?: MediaStreamTrack;
  private source?: MediaStreamAudioSourceNode;
  private node?: GainNode;
  private context?: AudioContext;
  private enabled = true;
  private clarity = false; private clarityGraph?: VoiceClarity;
  private noiseInput?: GainNode; private noiseFilter?: BoostNoiseFilter;
  private denoiser?: StrongDenoiser; private denoiseOutput?: GainNode;
  private noiseRemoval: NoiseRemoval = 'standard';
  getNoiseRemoval(): NoiseRemovalState { return this.denoiser?.state ?? { requested: this.noiseRemoval, active: this.noiseRemoval === 'off' ? 'off' : 'standard', status: 'inactive' }; }
  async setNoiseRemoval(mode: NoiseRemoval) { this.noiseRemoval = mode; await this.denoiser?.configure(mode); this.apply(); }
  private noiseEnabled = true; private noiseThreshold = -70;
  setNoiseFilter(enabled: boolean, threshold = -70) { this.noiseEnabled = enabled; this.noiseThreshold = threshold; this.apply(); }
  setClarity(enabled: boolean) { this.clarity = enabled; this.clarityGraph?.setEnabled(enabled); }
  private value: number;
  constructor(value = 1) { this.value = clampMicrophoneGain(value); }
  setGain(value: number) { this.value = clampMicrophoneGain(value); this.apply(); }
  setEnabled(value: boolean) { this.enabled = value; this.apply(); }
  private apply() { if (this.node) this.node.gain.value = this.enabled ? this.value : 0; this.denoiser?.setGain(this.value); this.noiseFilter?.configure(this.noiseRemoval !== 'off' && this.denoiser?.state.active !== 'strong' && this.noiseEnabled && this.value > 10, this.noiseThreshold); }
  async resume() { if (this.context?.state === 'suspended') await this.context.resume(); }
  async init({ track, audioContext }: { track: MediaStreamTrack; audioContext: AudioContext }) {
    await this.destroy();
    this.context = audioContext;
    this.source = audioContext.createMediaStreamSource(new MediaStream([track]));
    this.node = audioContext.createGain(); this.apply();
    const destination = audioContext.createMediaStreamDestination();
    this.noiseInput = audioContext.createGain();
    this.clarityGraph = new VoiceClarity(audioContext, this.source, this.noiseInput); this.clarityGraph.setEnabled(this.clarity);
    this.denoiseOutput = audioContext.createGain();
    this.denoiser = new StrongDenoiser(audioContext, this.noiseInput, this.denoiseOutput);
    this.noiseFilter = new BoostNoiseFilter(audioContext, this.denoiseOutput, this.node); this.apply();
    this.node.connect(destination);
    this.processedTrack = destination.stream.getAudioTracks()[0];
    await this.denoiser.configure(this.noiseRemoval); this.apply();
    await this.resume();
  }
  async restart(options: { track: MediaStreamTrack; audioContext: AudioContext }) { await this.init(options); }
  async destroy() {
    this.noiseFilter?.destroy(); this.noiseFilter = undefined;
    this.denoiser?.destroy(); this.denoiser = undefined; this.denoiseOutput?.disconnect(); this.denoiseOutput = undefined;
    this.noiseInput?.disconnect(); this.noiseInput = undefined;
    this.clarityGraph?.destroy(); this.clarityGraph = undefined; this.source?.disconnect(); this.node?.disconnect(); this.processedTrack?.stop();
    this.source = undefined; this.node = undefined; this.processedTrack = undefined; this.context = undefined;
  }
}
