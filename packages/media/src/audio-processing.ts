export type AudioProcessing = { echoCancellation: boolean; noiseSuppression: boolean };
export type AudioProcessingState = { requested: AudioProcessing; supported: AudioProcessing; effective: Partial<AudioProcessing>; active: boolean; pending: boolean };
export const defaultAudioProcessing: Readonly<AudioProcessing> = Object.freeze({ echoCancellation: true, noiseSuppression: true });
export function browserAudioProcessing(requested: AudioProcessing, track?: MediaStreamTrack, capture = requested): AudioProcessingState {
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() || {}, settings = track?.getSettings();
  const active = track?.readyState === 'live';
  return { requested: { ...requested }, supported: { echoCancellation: supported.echoCancellation === true, noiseSuppression: supported.noiseSuppression === true }, active, pending: active && (requested.echoCancellation !== capture.echoCancellation || requested.noiseSuppression !== capture.noiseSuppression), effective: {
    ...(typeof settings?.echoCancellation === 'boolean' ? { echoCancellation: settings.echoCancellation } : {}),
    ...(typeof settings?.noiseSuppression === 'boolean' ? { noiseSuppression: settings.noiseSuppression } : {})
  } };
}
