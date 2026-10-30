export type AudioProcessing = { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean };
export type AudioProcessingState = { requested: AudioProcessing; supported: AudioProcessing; effective: Partial<AudioProcessing>; active: boolean; pending: boolean };
export const defaultAudioProcessing: Readonly<AudioProcessing> = Object.freeze({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
export function processingMismatch(track: MediaStreamTrack, requested: AudioProcessing, reported?: MediaTrackSettings) {
  const settings = reported ?? track.getSettings();
  return (Object.keys(requested) as (keyof AudioProcessing)[]).some(key => typeof settings[key] === 'boolean' && settings[key] !== requested[key]);
}
export function browserAudioProcessing(requested: AudioProcessing, track?: MediaStreamTrack, capture = requested, reported?: MediaTrackSettings): AudioProcessingState {
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() || {}, settings = reported ?? track?.getSettings();
  const active = track?.readyState === 'live';
  return { requested: { ...requested }, supported: { echoCancellation: supported.echoCancellation === true, noiseSuppression: supported.noiseSuppression === true, autoGainControl: supported.autoGainControl === true }, active, pending: active && (Object.keys(requested) as (keyof AudioProcessing)[]).some(key => requested[key] !== capture[key]), effective: {
    ...(typeof settings?.echoCancellation === 'boolean' ? { echoCancellation: settings.echoCancellation } : {}),
    ...(typeof settings?.noiseSuppression === 'boolean' ? { noiseSuppression: settings.noiseSuppression } : {}),
    ...(typeof settings?.autoGainControl === 'boolean' ? { autoGainControl: settings.autoGainControl } : {})
  } };
}
