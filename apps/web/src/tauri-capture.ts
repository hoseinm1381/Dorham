import { invoke } from '@tauri-apps/api/core';
import type { NativeVideo, ScreenCaptureSettings } from '../../../packages/media/src/screen-capture';

type Selection = NativeVideo['selection'] & { id: number };
type VideoGenerator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type SharedVideoEvent = Event & { additionalData?: { dorhamVideoId?: number; capacity?: number }; getBuffer(): ArrayBuffer };
type WebView = EventTarget & { releaseBuffer?: (buffer: ArrayBuffer) => void };
const frameGenerator = () => (window as Window & {
  MediaStreamTrackGenerator?: new (options: { kind: 'video' }) => VideoGenerator;
}).MediaStreamTrackGenerator;
const delay = (time: number) => new Promise<void>(resolve => setTimeout(resolve, time));

async function frame(kind: 'video' | 'audio', id: string | number, stopped: AbortSignal, shared = false) {
  const timeout = AbortSignal.timeout(3500);
  const response = await fetch(`/__dorham_media/${kind}/${id}${shared ? '?shared=1' : ''}`, {
    cache: 'no-store', signal: AbortSignal.any?.([stopped, timeout]) ?? timeout,
  });
  if (!response.ok) throw new Error(await response.text());
  return response;
}

const webview = (window as Window & { chrome?: { webview?: WebView } }).chrome?.webview;
let receiveVideoBuffer: ((event: SharedVideoEvent, buffer: ArrayBuffer) => boolean) | undefined;
webview?.addEventListener('sharedbufferreceived', event => {
  const shared = event as SharedVideoEvent;
  if (typeof shared.additionalData?.dorhamVideoId !== 'number') return;
  const buffer = shared.getBuffer();
  if (!receiveVideoBuffer?.(shared, buffer)) webview.releaseBuffer?.(buffer);
});

export async function captureNativeVideo(settings: ScreenCaptureSettings, audio: boolean): Promise<NativeVideo> {
  const Generator = frameGenerator();
  if (!Generator || typeof VideoFrame !== 'function') throw new Error('Update Microsoft WebView2 to share your screen.');
  const selection = await invoke<Selection | null>('capture_video', { settings, audio });
  if (!selection) throw new DOMException('Screen sharing was cancelled.', 'NotAllowedError');
  let generator: VideoGenerator;
  try { generator = new Generator({ kind: 'video' }); }
  catch (error) {
    await invoke('capture_stop', { id: selection.id }).catch(() => {});
    throw error;
  }
  generator.contentHint = 'detail';
  const writer = generator.writable.getWriter();
  const stream = new MediaStream([generator]);
  const stopped = new AbortController();
  let useShared = typeof webview?.releaseBuffer === 'function';
  let sharedBuffer: ArrayBuffer | undefined;
  let bufferArrived: (() => void) | undefined;
  let closed = false;
  const onBuffer = (event: SharedVideoEvent, buffer: ArrayBuffer) => {
    if (closed || !useShared || event.additionalData?.dorhamVideoId !== selection.id || event.additionalData.capacity !== buffer.byteLength) return false;
    if (sharedBuffer) webview?.releaseBuffer?.(sharedBuffer);
    sharedBuffer = buffer;
    bufferArrived?.();
    return true;
  };
  if (useShared) receiveVideoBuffer = onBuffer;
  const releaseShared = () => {
    if (receiveVideoBuffer === onBuffer) receiveVideoBuffer = undefined;
    if (sharedBuffer) webview?.releaseBuffer?.(sharedBuffer);
    sharedBuffer = undefined;
    bufferArrived?.();
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    stopped.abort();
    releaseShared();
    void invoke('capture_stop', { id: selection.id }).catch(() => {});
    void writer.abort().catch(() => {}).finally(() => writer.releaseLock());
    generator.stop();
  };
  const pull = async () => {
    const response = await frame('video', selection.id, stopped.signal, useShared);
    const capacity = Number(response.headers.get('X-Dorham-Video-Buffer'));
    if (capacity && sharedBuffer?.byteLength !== capacity) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>(resolve => {
        bufferArrived = resolve;
        timeout = setTimeout(resolve, 500);
      });
      clearTimeout(timeout);
      bufferArrived = undefined;
      if (closed) return false;
      if (sharedBuffer?.byteLength !== capacity) {
        useShared = false;
        releaseShared();
        return false;
      }
    }
    const data = capacity ? sharedBuffer! : await response.arrayBuffer();
    if (closed || !data.byteLength) return false;
    const header = new DataView(data);
    const width = header.getUint32(0, true), height = header.getUint32(4, true);
    const length = 8 + width * height * 4;
    if (!width || !height || width > settings.width || height > settings.height || length > data.byteLength || (!capacity && length !== data.byteLength)) {
      throw new Error('Windows returned an invalid capture frame.');
    }
    const videoFrame = new VideoFrame(new Uint8Array(data, 8, length - 8), {
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
let audioSession: { id: string; outstanding: number; stopped: AbortController } | undefined;

export function onCaptureAudio(listener: (packet: AudioPacket) => void) {
  audioListeners.add(listener);
  return () => { audioListeners.delete(listener); };
}

export async function startCaptureAudio(): Promise<AudioSelection> {
  const selection = await invoke<AudioSelection>('capture_audio_start');
  const session = { id: selection.id, outstanding: 0, stopped: new AbortController() };
  audioSession = session;
  void (async () => {
    await delay(0);
    while (audioSession === session) {
      const response = await frame('audio', session.id, session.stopped.signal);
      const data = await response.arrayBuffer();
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
      stopCaptureAudio(session.id);
      for (const listener of audioListeners) listener({ id: session.id, error: String(error) });
    }
  });
  return selection;
}

export function stopCaptureAudio(id: string) {
  if (audioSession?.id === id) {
    audioSession.stopped.abort();
    audioSession = undefined;
  }
  void invoke('capture_audio_stop', { id }).catch(() => {});
}

export function acknowledgeCaptureAudio(id: string) {
  if (audioSession?.id === id && audioSession.outstanding > 0) audioSession.outstanding--;
}
