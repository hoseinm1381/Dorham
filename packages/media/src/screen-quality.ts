export const screenQualities = ['480p15', '480p30', '720p15', '720p30'] as const;
export type ScreenQuality = typeof screenQualities[number];
export const screenBandwidths = [300000,450000,600000,750000,900000,1050000,1200000,1350000,1500000] as const;
export function clampScreenBandwidth(value:number){return Number.isFinite(value)?Math.max(300000,Math.min(1500000,Math.round(value/1000)*1000)):450000;}
export function screenSettings(quality: ScreenQuality, policy?: { maxBitrate: number; maxFrameRate: number }, share?: { maxFrameRate?: number; includeAudio?: boolean }, requestedBandwidth?:number) {
  const mode = screenQualities.includes(quality) ? quality : '720p15';
  const height = mode.startsWith('480') ? 480 : 720, fps = mode.endsWith('15') ? 15 : 30;
  const bitrate = height === 480 ? (fps === 15 ? 400000 : 650000) : (fps === 15 ? 800000 : 1200000);
  const budget = Math.min(policy?.maxBitrate ?? 450000,requestedBandwidth===undefined?Infinity:clampScreenBandwidth(requestedBandwidth)), audioBitrate = share?.includeAudio ? Math.min(48000, Math.floor(budget / 4)) : 0;
  return { width: height === 480 ? 854 : 1280, height, fps: Math.min(fps, policy?.maxFrameRate ?? 30, share?.maxFrameRate ?? 30), bitrate: Math.min(requestedBandwidth===undefined?bitrate:Infinity, budget - audioBitrate), audioBitrate };
}
