import { invoke } from '@tauri-apps/api/core';
import type { NativeVideo, ScreenCaptureSettings } from '../../../packages/media/src/screen-capture';

type Selection = NativeVideo['selection'] & { id: number };
type VideoGenerator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
const frameGenerator = () => (window as Window & {
  MediaStreamTrackGenerator?: new (options: { kind: 'video' }) => VideoGenerator;
}).MediaStreamTrackGenerator;
const delay = (time: number) => new Promise<void>(resolve => setTimeout(resolve, time));

async function frame(kind: 'video' | 'audio', id: string | number) {
  const response = await fetch(`/__dorham_media/${kind}/${id}`, { cache: 'no-store', signal: AbortSignal.timeout(3500) });
  if (!response.ok) throw new Error(await response.text());
  return response.arrayBuffer();
}

export async function captureNativeVideo(settings: ScreenCaptureSettings, audio: boolean): Promise<NativeVideo> {
  const Generator = frameGenerator();
  if (!Generator || typeof VideoFrame !== 'function') throw new Error('Update Microsoft WebView2 to share your screen.');
  const selection = await invoke<Selection | null>('capture_video', { settings, audio });
  if (!selection) throw new DOMException('Screen sharing was cancelled.', 'NotAllowedError');
  const generator = new Generator({ kind: 'video' });
  generator.contentHint = 'detail';
  const writer = generator.writable.getWriter();
  const stream = new MediaStream([generator]);
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    void invoke('capture_stop', { id: selection.id }).catch(() => {});
    void writer.abort().catch(() => {});
    generator.stop();
  };
  const pull = async () => {
    const data = await frame('video', selection.id);
    if (closed || !data.byteLength) return false;
    const header = new DataView(data);
    const width = header.getUint32(0, true), height = header.getUint32(4, true);
    if (!width || !height || width > settings.width || height > settings.height || data.byteLength !== 8 + width * height * 4) {
      throw new Error('Windows returned an invalid capture frame.');
    }
    const videoFrame = new VideoFrame(new Uint8Array(data, 8), {
      format: 'BGRA', codedWidth: width, codedHeight: height,
      timestamp: Math.round(performance.now() * 1000),
    });
    try { await writer.write(videoFrame); } finally { videoFrame.close(); }
    return true;
  };
  const interval = 1000 / settings.fps;
  try {
    const deadline = performance.now() + 9000;
    while (!await pull()) {
      if (performance.now() >= deadline) throw new Error('The selected source did not provide video. Open it and share again.');
      await delay(interval);
    }
  } catch (error) {
    stop();
    throw error instanceof Error ? error : new Error(String(error));
  }
  void (async () => {
    while (!closed) {
      const started = performance.now();
      await pull();
      await delay(Math.max(0, interval - (performance.now() - started)));
    }
  })().catch(() => {
    if (!closed) {
      stop();
      generator.dispatchEvent(new Event('ended'));
    }
  });
  return { stream, selection, stop };
}

type AudioSelection = { id: string; sourceName: string; audioScope: 'application' | 'system' };
type AudioPacket = { id: string; pcm?: Uint8Array; error?: string };
const audioListeners = new Set<(packet: AudioPacket) => void>();
let audioSession: { id: string; outstanding: number } | undefined;

export function onCaptureAudio(listener: (packet: AudioPacket) => void) {
  audioListeners.add(listener);
  return () => { audioListeners.delete(listener); };
}

export async function startCaptureAudio(): Promise<AudioSelection> {
  const selection = await invoke<AudioSelection>('capture_audio_start');
  const session = { id: selection.id, outstanding: 0 };
  audioSession = session;
  void (async () => {
    await delay(0);
    while (audioSession === session) {
      const data = await frame('audio', session.id);
      if (audioSession !== session) return;
      if (data.byteLength && session.outstanding < 6) {
        const pcm = new Uint8Array(data);
        session.outstanding++;
        for (const listener of audioListeners) listener({ id: session.id, pcm });
      }
      await delay(16);
    }
  })().catch(error => {
    if (audioSession === session) {
      audioSession = undefined;
      for (const listener of audioListeners) listener({ id: session.id, error: String(error) });
    }
  });
  return selection;
}

export function stopCaptureAudio(id: string) {
  if (audioSession?.id === id) audioSession = undefined;
  void invoke('capture_audio_stop', { id }).catch(() => {});
}

export function acknowledgeCaptureAudio(id: string) {
  if (audioSession?.id === id && audioSession.outstanding > 0) audioSession.outstanding--;
}
