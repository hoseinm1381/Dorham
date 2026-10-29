// Meter incoming audio before playback volume, with a short tail so quiet speech
// remains visible between syllables. This detects activity, not speech content.
export class AudioActivityMeter {
  private samples: Float32Array<ArrayBuffer>;
  private activeUntil = 0;
  constructor(private analyser: AnalyserNode) {
    analyser.fftSize = 1024;
    this.samples = new Float32Array(analyser.fftSize);
  }
  speaking(allowed = true, now = performance.now()) {
    if (!allowed) { this.activeUntil = 0; return false; }
    this.analyser.getFloatTimeDomainData(this.samples);
    const rms = Math.sqrt(this.samples.reduce((sum, value) => sum + value * value, 0) / this.samples.length);
    if (rms >= 0.006) this.activeUntil = now + 300;
    return now < this.activeUntil;
  }
}
