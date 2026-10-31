// Envelope-controlled soft expander. Native audio nodes keep this off the UI
// thread with no worklet/model download. It reduces noise in pauses, not voices
// mixed with noise. The threshold is adjustable for very quiet microphones.
export class BoostNoiseFilter {
  private active = false;
  private detector?: WaveShaperNode; private envelope?: BiquadFilterNode;
  private curve?: WaveShaperNode; private gate?: GainNode;
  constructor(private context: BaseAudioContext, private input: AudioNode, private output: AudioNode, private threshold = -70) { input.connect(output); }
  configure(enabled: boolean, threshold = -70) {
    if (enabled === this.active && threshold === this.threshold) return;
    this.active = enabled;
    this.threshold = Math.max(-90, Math.min(-40, threshold));
    if (enabled && !this.gate) {
      this.input.disconnect(this.output);
      this.gate = this.context.createGain(); this.gate.gain.value = 0;
      this.detector = this.context.createWaveShaper();
      this.detector.curve = Float32Array.from({ length: 8193 }, (_, i) => Math.abs(i / 4096 - 1));
      this.envelope = this.context.createBiquadFilter(); this.envelope.type = 'lowpass'; this.envelope.frequency.value = 12; this.envelope.Q.value = 0.5;
      this.curve = this.context.createWaveShaper();
      this.input.connect(this.detector).connect(this.envelope).connect(this.curve).connect(this.gate.gain);
      this.input.connect(this.gate).connect(this.output);
    } else if (!enabled && this.gate) { this.disconnect(); this.input.connect(this.output); }
    if (this.curve) {
      const floor = 10 ** (this.threshold / 20);
      // Nonuniform input magnification avoids losing low-level envelope detail
      // in a fixed-size waveshaper table.
      this.envelope!.disconnect();
      const scale = this.context.createGain(); scale.gain.value = 1 / floor;
      this.scale?.disconnect(); this.scale = scale;
      this.envelope!.connect(scale).connect(this.curve);
      this.curve.curve = Float32Array.from({ length: 2049 }, (_, i) => {
        const x = Math.max(0, i / 1024 - 1); const amount = Math.max(0, Math.min(1, (x - 0.25) / 0.5)); return 0.01 + 0.99 * amount * amount * (3 - 2 * amount);
      });
    }
  }
  private scale?: GainNode;
  private disconnect() {
    if (this.detector) this.input.disconnect(this.detector);
    if (this.gate) this.input.disconnect(this.gate);
    this.detector?.disconnect(); this.envelope?.disconnect(); this.scale?.disconnect(); this.curve?.disconnect(); this.gate?.disconnect();
    this.detector = undefined; this.envelope = undefined; this.scale = undefined; this.curve = undefined; this.gate = undefined;
  }
  destroy() { if (this.gate) this.disconnect(); else this.input.disconnect(this.output); }
}
