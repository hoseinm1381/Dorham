export type ScreenPlayback = 'full' | 'reduced' | 'paused';

export class VoicePriority {
  level: ScreenPlayback = 'full';
  private stableSamples = 0;

  observe(pressure: ScreenPlayback, sampled: boolean) {
    const levels: ScreenPlayback[] = ['full', 'reduced', 'paused'];
    const current = levels.indexOf(this.level);
    const wanted = levels.indexOf(pressure);
    if (wanted > current) {
      this.level = pressure;
      this.stableSamples = 0;
    } else if (wanted === current) {
      this.stableSamples = 0;
    } else if (sampled && ++this.stableSamples === 3) {
      this.level = levels[current - 1]!;
      this.stableSamples = 0;
    }
    return this.level;
  }
}

// Keep both encodings inside the configured screen video bandwidth budget.
export function screenEncodingBudget(bitrate: number) {
  const fallback = Math.min(100000, Math.floor(bitrate / 4));
  return { fallback, full: bitrate - fallback };
}

export function bufferMusic(receiver: RTCRtpReceiver | undefined) {
  if (receiver && 'jitterBufferTarget' in receiver) {
    // Spoken audio keeps the browser's ordinary real-time playout settings.
    receiver.jitterBufferTarget = 1500;
  }
}
