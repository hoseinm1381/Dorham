export type NoiseRemoval = 'off' | 'standard' | 'strong';
export type NoiseRemovalState = { requested: NoiseRemoval; active: 'off' | 'standard' | 'strong'; status: 'inactive' | 'loading' | 'ready' | 'fallback'; reason?: string };
const modules = new WeakMap<AudioContext, Promise<void>>();
let binary: Promise<ArrayBuffer> | undefined;
function model() {
  if (!binary) binary = fetch(new URL('audio/rnnoise.wasm', document.baseURI), { signal: AbortSignal.timeout(5000) })
    .then(async response => { if (!response.ok) throw Error('Noise model unavailable'); const bytes = await response.arrayBuffer(); await WebAssembly.compile(bytes); return bytes; })
    .catch(error => { binary = undefined; throw error; });
  return binary;
}

// Only the outgoing microphone enters this graph. All assets are bundled locally.
export class StrongDenoiser {
  state: NoiseRemovalState = { requested: 'standard', active: 'standard', status: 'inactive' };
  private epoch = 0;
  private node?: AudioWorkletNode;
  private pre?: GainNode;
  private compensation?: GainNode;
  private gain = 1;
  private destroyed = false;
  constructor(private context: AudioContext, private input: AudioNode, private output: AudioNode) { input.connect(output); }
  setGain(value: number) { this.gain = Math.max(1, value); if (this.pre) this.pre.gain.value = this.gain; if (this.compensation) this.compensation.gain.value = 1 / this.gain; }
  private bypass() {
    this.input.disconnect(); this.pre?.disconnect(); this.compensation?.disconnect();
    if (this.node) { this.node.onprocessorerror = null; this.node.port.postMessage('destroy'); this.node.port.close(); this.node.disconnect(); }
    this.node = undefined; this.pre = undefined; this.compensation = undefined;
    if (!this.destroyed) this.input.connect(this.output);
  }
  async configure(mode: NoiseRemoval) {
    const epoch = ++this.epoch;
    this.bypass(); this.state = { requested: mode, active: mode === 'off' ? 'off' : 'standard', status: 'ready' };
    if (mode !== 'strong' || this.destroyed) return;
    this.state.status = 'loading';
    let node: AudioWorkletNode | undefined;
    try {
      if (!this.context.audioWorklet || this.context.sampleRate !== 48000) throw Error('Strong noise removal needs 48 kHz AudioWorklet support.');
      const bytes = await model();
      if (!modules.has(this.context)) modules.set(this.context, this.context.audioWorklet.addModule(new URL('audio/rnnoise-worklet.js', document.baseURI).href).catch(error => { modules.delete(this.context); throw error; }));
      await modules.get(this.context);
      if (epoch !== this.epoch || this.destroyed) return;
      node = new AudioWorkletNode(this.context, '@sapphi-red/web-noise-suppressor/rnnoise', { processorOptions: { maxChannels: 1, wasmBinary: bytes }, channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
      this.node = node;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Noise removal did not start.')), 5000);
        node!.port.onmessage = event => { clearTimeout(timer); if (event.data === 'ready') resolve(); else reject(Error('Noise removal could not load.')); };
        node!.onprocessorerror = () => { clearTimeout(timer); reject(Error('Noise removal stopped.')); };
      });
      if (epoch !== this.epoch || this.destroyed) return;
      this.input.disconnect(this.output);
      this.pre = this.context.createGain(); this.compensation = this.context.createGain(); this.setGain(this.gain);
      this.input.connect(this.pre).connect(node).connect(this.compensation).connect(this.output);
      this.state = { requested: mode, active: 'strong', status: 'ready' };
      node.onprocessorerror = () => { if (epoch === this.epoch && !this.destroyed) { this.bypass(); this.state = { requested: mode, active: 'standard', status: 'fallback', reason: 'Strong noise removal stopped; standard processing is active.' }; } };
    } catch {
      if (epoch === this.epoch && !this.destroyed) { this.bypass(); this.state = { requested: mode, active: 'standard', status: 'fallback', reason: 'Strong noise removal is unavailable; standard processing is active.' }; }
    }
  }
  destroy() { this.destroyed = true; this.epoch++; this.bypass(); }
}
