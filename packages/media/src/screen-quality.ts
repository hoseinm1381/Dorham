export const screenQualities = ['480p15', '480p30', '720p15', '720p30'] as const;
export type ScreenQuality = typeof screenQualities[number];
export function screenSettings(quality: ScreenQuality, policy?: { maxBitrate: number; maxFrameRate: number }, share?: { maxFrameRate?: number; includeAudio?: boolean }) {
  const mode = screenQualities.includes(quality) ? quality : '720p15';
  const height = mode.startsWith('480') ? 480 : 720, fps = mode.endsWith('15') ? 15 : 30;
  const bitrate = height === 480 ? (fps === 15 ? 400000 : 650000) : (fps === 15 ? 800000 : 1200000);
  const budget = policy?.maxBitrate ?? 450000, audioBitrate = share?.includeAudio ? Math.min(48000, Math.floor(budget / 4)) : 0;
  return { width: height === 480 ? 854 : 1280, height, fps: Math.min(fps, policy?.maxFrameRate ?? 30, share?.maxFrameRate ?? 30), bitrate: Math.min(bitrate, budget - audioBitrate), audioBitrate };
}
