import type { Socket } from 'socket.io-client';
import type { VoiceRoom, Signal, Result, Share } from '@dorham/contracts';
export type RemoteScreen = { userId: string; leaseId: string; stream: MediaStream };
export type MediaEvents = { room: VoiceRoom | null; screen: RemoteScreen; screenRemoved: string; speaking: { userId: string; speaking: boolean }; error: string; status: string; stats: Record<string, any>; nativeVideo: { userId: string } };
export type MediaOptions = { socket: Socket; userId: string; emit: <K extends keyof MediaEvents>(kind: K, payload: MediaEvents[K]) => void };
export type MediaCapabilities = { audio: boolean; screenCapture: boolean; nativeVideo: boolean; amplification: boolean };
export interface MediaTransport {
  room: VoiceRoom | null;
  getCapabilities(): MediaCapabilities; reconnect(): Promise<void>;
  join(channelId: string): Promise<void>; leave(): Promise<void>;
  setMuted(value: boolean): Promise<void>; setDeafened(value: boolean): Promise<void>;
  setVolume(userId: string, value: number): void; setDevice(deviceId: string): Promise<void>;
  startShare(quality?: '720p15' | '720p30' | '1080p30'): Promise<void>; stopShare(): Promise<void>;
  subscribe(share: Share, enabled: boolean): Promise<void>;
  getStats(): Promise<Record<string, any>>; destroy(): Promise<void>;
}
export function ack<T = any>(socket: Socket, event: string, body: unknown): Promise<T> {
  const payload = body && typeof body === 'object' ? { requestId: crypto.randomUUID(), ...body } : body;
  return new Promise((resolve, reject) => socket.timeout(10000).emit(event, payload, (err: Error | null, result: Result<T>) => {
    if (err) reject(new Error('Connection timed out. Retry after reconnecting.'));
    else if (!result?.ok) reject(new Error(result?.error.message || 'Action failed.'));
    else resolve(result.data);
  }));
}
export { MeshTransport } from './mesh';
export { LiveKitTransport } from './livekit';
export { NativeTransport, NativeMedia } from './native';
export type { Signal };
