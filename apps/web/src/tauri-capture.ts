import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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
  let unlisten: (() => void) | undefined;
  let wake: (() => void) | undefined;
  let pending = true;
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
    unlisten?.();
    wake?.();
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
    const tagged = header.getUint32(0, true), nv12 = (tagged >>> 31) === 1;
    const width = tagged & 0x7fffffff, height = header.getUint32(4, true);
    const length = 8 + width * height * (nv12 ? 1.5 : 4);
    if (!width || !height || width > 3840 || height > 2160 || (nv12 && (width % 4 !== 0 || height % 2 !== 0)) || length > data.byteLength || (!capacity && length !== data.byteLength)) {
      throw new Error('Windows returned an invalid capture frame.');
    }
    const videoFrame = new VideoFrame(new Uint8Array(data, 8, length - 8), {
      format: nv12 ? 'NV12' : 'BGRX',
      ...(nv12 ? { colorSpace: { matrix: 'bt709' as const, primaries: 'bt709' as const, transfer: 'bt709' as const, fullRange: false } } : {}),
      codedWidth: width, codedHeight: height,
      timestamp: Math.round(performance.now() * 1000),
    });
    try { await writer.write(videoFrame); } finally { videoFrame.close(); }
    return true;
  };
  // Windows paces the producer. A hidden WebView can throttle JavaScript timers
  // while the user is interacting with the window they are sharing.
  const nextFrame = async () => {
    while (!closed) {
      if (!pending) await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
      if (closed) return;
      pending = false;
      if (await pull()) return;
    }
  };
  try {
    unlisten = await listen<number>('capture-frame-ready', event => {
      if (event.payload !== selection.id) return;
      pending = true;
      wake?.();
    });
    let startup: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([nextFrame(), new Promise<never>((_, reject) => {
        startup = setTimeout(() => reject(new Error('The selected source did not provide video. Open it and share again.')), 9000);
      })]);
    } finally { clearTimeout(startup); }
  } catch (error) {
    stop();
    throw error instanceof Error ? error : new Error(String(error));
  }
  void (async () => {
    while (!closed) await nextFrame();
  })().catch(() => {
    if (!closed) {
      stop();
      generator.dispatchEvent(new Event('ended'));
    }
  });
  return { stream, selection, stop, setQuality: settings => invoke<void>('capture_quality', { id: selection.id, settings }) };
}

type AudioSelection = { id: string; sourceName: string; audioScope: 'application' | 'system' };
type AudioPacket = { id: string; pcm?: Uint8Array; error?: string };
const audioListeners = new Set<(packet: AudioPacket) => void>();
let audioSession: { id: string; outstanding: number; stopped: AbortController } | undefined;
// The native queue contains 20 ms PCM packets. A request can deliver several
// packets so WebView2 does not need to dispatch each one separately.
const audioPollInterval = 32;
const maxAudioBatchesInFlight = 3;

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
      const started = performance.now();
      if (session.outstanding >= maxAudioBatchesInFlight) {
        await delay(audioPollInterval);
        continue;
      }
      const response = await frame('audio', session.id, session.stopped.signal);
      const data = await response.arrayBuffer();
      if (audioSession !== session) return;
      if (data.byteLength) {
        const pcm = new Uint8Array(data);
        session.outstanding++;
        for (const listener of audioListeners) listener({ id: session.id, pcm });
      }
      await delay(Math.max(0, audioPollInterval - (performance.now() - started)));
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
