export type ScreenPlayback = 'full' | 'reduced';

export class VoicePriority {
  level: ScreenPlayback = 'full';
  private stableSamples = 0;

  observe(pressure: ScreenPlayback, sampled: boolean) {
    if (pressure === 'reduced') {
      this.level = 'reduced';
      this.stableSamples = 0;
    } else if (this.level === 'reduced' && sampled && ++this.stableSamples === 3) {
      this.level = 'full';
      this.stableSamples = 0;
    }
    return this.level;
  }
}

export function availableScreenBitrate(stats: RTCStatsReport | undefined) {
  for (const stat of stats?.values() ?? []) {
    if (stat.type !== 'transport' || !stat.selectedCandidatePairId) continue;
    const estimate = stats?.get(stat.selectedCandidatePairId)?.availableOutgoingBitrate;
    if (typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= 0) {
      return Math.max(0, estimate - 100000);
    }
  }
}

export function outgoingScreenShare(maxBitrate: number, available: number | undefined, poor: boolean) {
  return Math.max(0, Math.min(poor ? .55 : 1, (available ?? maxBitrate) / maxBitrate));
}

export function screenEncodingTarget(ratio: number, bitrate: number, fps: number, shortEdge: number) {
  if (ratio >= 1) return { bitrate, fps, scale: 1 };
  // Drop motion more quickly than detail. Round the size to 16-pixel steps
  // to avoid resizing the decoder for every small fluctuation.
  const edge = Math.min(shortEdge, Math.max(240, Math.round(shortEdge * Math.sqrt(ratio) / 16) * 16));
  return {
    bitrate: Math.min(bitrate, Math.max(32000, Math.floor(bitrate * ratio / 10000) * 10000)),
    fps: Math.min(fps, Math.max(4, Math.round(fps * Math.pow(ratio, .75)))),
    scale: shortEdge / edge,
  };
}

export function receivingScreenFps(speechLoss: number, connectionFactor: number) {
  const factor = Math.min(connectionFactor, Math.max(0, 1 - speechLoss * 8));
  return Math.max(4, Math.round(16 * factor));
}

export function bufferMusic(receiver: RTCRtpReceiver | undefined) {
  if (receiver && 'jitterBufferTarget' in receiver) {
    // Spoken audio keeps the browser's ordinary real-time playout settings.
    receiver.jitterBufferTarget = 1500;
  }
}
