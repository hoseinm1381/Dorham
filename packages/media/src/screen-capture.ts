// The SDK currently omits windowAudio when translating capture options.
// Use the browser API directly so a window request never silently becomes
// a request for all system sound when the user chooses a window.
export type ScreenCaptureSettings = { width: number; height: number; fps: number };
export function captureScreen(settings: ScreenCaptureSettings, includeAudio: boolean): Promise<MediaStream> {
  const options: DisplayMediaStreamOptions & { windowAudio: 'window' | 'exclude'; systemAudio: 'include' | 'exclude'; selfBrowserSurface: 'exclude' } = {
    video: { width: { ideal: settings.width }, height: { ideal: settings.height }, frameRate: { ideal: settings.fps } },
    audio: includeAudio ? { restrictOwnAudio: true, suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints : false,
    windowAudio: includeAudio ? 'window' : 'exclude',
    systemAudio: includeAudio ? 'include' : 'exclude',
    selfBrowserSurface: 'exclude',
  };
  return navigator.mediaDevices.getDisplayMedia(options);
}
export function captureDetails(stream: MediaStream) {
  return {
    surface: stream.getVideoTracks()[0]?.getSettings().displaySurface || 'unknown',
    audioTracks: stream.getAudioTracks().map(t => ({ state: t.readyState, muted: t.muted, channelCount: t.getSettings().channelCount, sampleRate: t.getSettings().sampleRate })),
  };
}
