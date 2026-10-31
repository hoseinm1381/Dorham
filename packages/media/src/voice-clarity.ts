// Two native Web Audio filters: no model download, worklet, timer or server DSP.
// The bypass disconnects both filters so low-power devices do not process them.
export class VoiceClarity {
  private filters: BiquadFilterNode[] = [];
  private enabled?: boolean;
  constructor(private context: BaseAudioContext, private source: AudioNode, private destination: AudioNode) {}
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.source.disconnect(); this.filters.forEach(node => node.disconnect()); this.filters = [];
    if (enabled) {
      const rumble = this.context.createBiquadFilter(); rumble.type = 'highpass'; rumble.frequency.value = 80; rumble.Q.value = Math.SQRT1_2;
      const presence = this.context.createBiquadFilter(); presence.type = 'peaking'; presence.frequency.value = 2500; presence.Q.value = 0.8; presence.gain.value = 2;
      this.filters = [rumble, presence]; this.source.connect(rumble).connect(presence).connect(this.destination);
    } else this.source.connect(this.destination);
  }
  destroy() { this.source.disconnect(); this.filters.forEach(node => node.disconnect()); this.filters = []; }
}
