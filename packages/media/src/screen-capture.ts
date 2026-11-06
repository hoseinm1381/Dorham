// The SDK currently omits windowAudio when translating capture options.
// Use the browser API directly so a window request never silently becomes
// a request for all system sound when the user chooses a window.
export type ScreenCaptureSettings = { width: number; height: number; fps: number };
type Selection = { sourceName: string; audioScope: 'none' | 'application' | 'system' };
type CaptureAudio = { id: string; pcm?: Uint8Array; error?: string };
type DesktopCapture = { systemAudioSafe?: boolean; getCaptureSelection?(): Promise<Selection | null>; startCaptureAudio?(): Promise<Selection & { id: string }>; stopCaptureAudio?(id: string): void; acknowledgeCaptureAudio?(id: string): void; onCaptureAudio?(listener: (packet: CaptureAudio) => void): () => void };
let desktopSound: boolean | undefined;
const desktop = () => (globalThis as typeof globalThis & { desktop?: DesktopCapture }).desktop;
export function setDesktopCaptureCapabilities(value: { sharedAudio: boolean }) { desktopSound = value.sharedAudio === true; }
export function sharedSoundSupported() { return !desktop() || (desktopSound ?? Boolean(desktop()?.systemAudioSafe)); }
const cleanups = new WeakMap<MediaStream, () => void>(), selections = new WeakMap<MediaStream, Selection>();
export function stopScreenCapture(stream?: MediaStream | null) { if (!stream) return; cleanups.get(stream)?.(); cleanups.delete(stream); stream.getTracks().forEach(track => track.stop()); }
export async function captureScreen(settings: ScreenCaptureSettings, includeAudio: boolean): Promise<MediaStream> {
  const options: DisplayMediaStreamOptions & { windowAudio: 'window' | 'exclude'; systemAudio: 'include' | 'exclude'; selfBrowserSurface: 'exclude' } = {
    video: { width: { ideal: settings.width, max: settings.width }, height: { ideal: settings.height, max: settings.height }, frameRate: { ideal: settings.fps, max: settings.fps } },
    audio: includeAudio ? { restrictOwnAudio: true, suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints : false,
    windowAudio: includeAudio ? 'window' : 'exclude',
    systemAudio: includeAudio ? 'include' : 'exclude',
    selfBrowserSurface: 'exclude',
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(options), native = desktop();
  if (!native?.getCaptureSelection) return stream;
  let context: AudioContext | undefined, node: AudioWorkletNode | undefined, remove: (() => void) | undefined, id: string | undefined, closed = false;
  const close = () => { if (closed) return; closed = true; remove?.(); if (id) native.stopCaptureAudio?.(id); node?.port.postMessage('destroy'); node?.port.close(); node?.disconnect(); void context?.close().catch(() => {}); };
  cleanups.set(stream, close);
  const video = stream.getVideoTracks()[0];
  video?.addEventListener('ended', close, { once: true });
  try {
    const selection = await native.getCaptureSelection();
    if (selection) selections.set(stream, selection);
    if (!includeAudio || !selection || selection.audioScope === 'none') return stream;
    context = new AudioContext({ sampleRate: 48000 });
    await context.audioWorklet.addModule(new URL('audio/share-audio-worklet.js', document.baseURI).href);
    node = new AudioWorkletNode(context, 'dorham-share-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const destination = context.createMediaStreamDestination(); node.connect(destination);
    node.port.onmessage = event => { if (event.data === 'ack' && id) native.acknowledgeCaptureAudio?.(id); };
    remove = native.onCaptureAudio?.(packet => {
      if (packet.id !== id || closed) { if (!id && packet.pcm) native.acknowledgeCaptureAudio?.(packet.id); return; }
      if (packet.error) { stopScreenCapture(stream); video?.dispatchEvent(new Event('ended')); return; }
      if (packet.pcm) { const bytes = new Uint8Array(packet.pcm); if (bytes.byteLength % 8 === 0 && bytes.byteLength <= 38400) { const samples = new Float32Array(bytes.buffer); node!.port.postMessage(samples, [samples.buffer]); } }
    });
    const audio = await native.startCaptureAudio!(); id = audio.id;
    if (closed || video?.readyState === 'ended') { native.stopCaptureAudio?.(id); throw Error('Screen sharing was cancelled.'); }
    selections.set(stream, audio); await context.resume();
    stream.addTrack(destination.stream.getAudioTracks()[0]);
    return stream;
  } catch (error) { stopScreenCapture(stream); throw error; }
}
export function captureDetails(stream: MediaStream) {
  return {
    ...selections.get(stream),
    surface: stream.getVideoTracks()[0]?.getSettings().displaySurface || 'unknown',
    audioTracks: stream.getAudioTracks().map(t => ({ state: t.readyState, muted: t.muted, channelCount: t.getSettings().channelCount, sampleRate: t.getSettings().sampleRate })),
  };
}
