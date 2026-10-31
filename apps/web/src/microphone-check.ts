import { VoiceClarity } from '../../../packages/media/src/voice-clarity';
import type { AudioProcessing } from '../../../packages/media/src/audio-processing';
export type CheckState = 'idle' | 'requesting' | 'recording' | 'ready' | 'playing';
// A bounded, local recording; no socket, upload, persisted blob or call track.
export class MicrophoneCheck {
  private epoch = 0;
  private context?: AudioContext;
  private capture?: MediaStream;
  private recorder?: MediaRecorder;
  private buffer?: AudioBuffer;
  private player?: AudioBufferSourceNode;
  private gain?: GainNode;
  private source?: MediaStreamAudioSourceNode;
  private analyser?: AnalyserNode;
  private meter?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private value = 1; private clarity = true; private clarityGraph?: VoiceClarity;
  setClarity(value: boolean) { this.clarity = value; this.clarityGraph?.setEnabled(value); }
  private state: CheckState = 'idle';
  constructor(private changed: (state: CheckState) => void, private level: (rms: number, clipped: boolean) => void, private failed: (error: unknown) => void) {}
  private update(state: CheckState) { this.state = state; this.changed(state); }
  setGain(value: number) { this.value = value; if (this.gain) this.gain.gain.value = value; }
  private stopMeter() { clearInterval(this.meter); this.source?.disconnect(); this.analyser?.disconnect(); this.source = undefined; this.analyser = undefined; this.level(0, false); }
  private measure(node: AudioNode) {
    this.stopMeter(); this.analyser = this.context!.createAnalyser(); this.analyser.fftSize = 1024; node.connect(this.analyser);
    const samples = new Float32Array(1024);
    this.meter = setInterval(() => { if (document.hidden || !this.analyser) return; this.analyser.getFloatTimeDomainData(samples); let sum = 0, peak = 0; for (const x of samples) { sum += x * x; peak = Math.max(peak, Math.abs(x)); } const scale = this.state === 'recording' ? this.value : 1; this.level(Math.min(1, Math.sqrt(sum / samples.length) * scale * 3), peak * scale >= 0.98); }, 80);
  }
  async record(input: string, processing: AudioProcessing) {
    this.destroy(); const epoch = this.epoch; this.update('requesting');
    try {
      this.context = new AudioContext(); await this.context.resume(); if (epoch !== this.epoch) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...processing, ...(input ? { deviceId: { exact: input } } : {}) } });
      if (epoch !== this.epoch) { stream.getTracks().forEach(t => t.stop()); return; }
      this.capture = stream; const source = this.context!.createMediaStreamSource(stream); this.measure(source); this.source = source;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); this.recorder = recorder;
      const chunks: Blob[] = []; let bytes = 0;
      recorder.ondataavailable = e => { if (epoch === this.epoch && e.data.size) { bytes += e.data.size; if (bytes > 2 * 1024 * 1024) { this.destroy(); this.failed(new Error('Microphone test recording is too large.')); return; } chunks.push(e.data); } };
      recorder.onerror = () => { if (epoch === this.epoch) { this.destroy(); this.failed(new Error('Microphone test could not record.')); } };
      recorder.onstop = () => { void (async () => {
        if (epoch !== this.epoch) return;
        clearTimeout(this.deadline); this.capture?.getTracks().forEach(t => t.stop()); this.capture = undefined; this.stopMeter(); this.recorder = undefined;
        const buffer = await this.context!.decodeAudioData(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer());
        if (epoch !== this.epoch) return; this.buffer = buffer; this.update('ready');
      })().catch(error => { if (epoch === this.epoch) { this.destroy(); this.failed(error); } }); };
      recorder.start(250); this.update('recording'); this.deadline = setTimeout(() => this.finish(), 5000);
    } catch (error) { if (epoch === this.epoch) { this.destroy(); this.failed(error); } }
  }
  finish() { if (this.recorder?.state === 'recording') this.recorder.stop(); }
  async play(output: string) {
    if (!this.context || !this.buffer) return; this.stopPlayback(); const epoch = this.epoch;
    try {
      if (typeof (this.context as any).setSinkId === 'function') await (this.context as any).setSinkId(output || 'default');
      await this.context.resume(); if (epoch !== this.epoch) return;
      this.player = this.context.createBufferSource(); this.player.buffer = this.buffer; this.gain = this.context.createGain(); this.gain.gain.value = this.value;
      this.clarityGraph = new VoiceClarity(this.context, this.player, this.gain); this.clarityGraph.setEnabled(this.clarity); this.gain.connect(this.context.destination); this.measure(this.gain); this.update('playing');
      this.player.onended = () => { if (epoch === this.epoch) this.stopPlayback(); }; this.player.start();
    } catch (error) { if (epoch === this.epoch) { this.stopPlayback(); this.failed(error); } }
  }
  stopPlayback() { this.clarityGraph?.destroy(); this.clarityGraph = undefined; if (this.player) { this.player.onended = null; try { this.player.stop(); } catch { /* Already ended. */ } this.player.disconnect(); this.player = undefined; } this.gain?.disconnect(); this.gain = undefined; this.stopMeter(); if (this.buffer) this.update('ready'); }
  destroy() {
    this.epoch++; clearTimeout(this.deadline); this.stopPlayback();
    if (this.recorder) { this.recorder.onstop = null; this.recorder.ondataavailable = null; this.recorder.onerror = null; if (this.recorder.state !== 'inactive') this.recorder.stop(); this.recorder = undefined; }
    this.capture?.getTracks().forEach(t => t.stop()); this.capture = undefined; this.buffer = undefined;
    const context = this.context; this.context = undefined; if (context && context.state !== 'closed') void context.close().catch(() => {}); this.update('idle');
  }
}
