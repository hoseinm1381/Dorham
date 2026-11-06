import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io-client';

const bridge = vi.hoisted(() => ({
  prepare: vi.fn(), join: vi.fn(), leave: vi.fn(), setState: vi.fn(),
  updateRoom: vi.fn(), stopShare: vi.fn(), startShare: vi.fn(), addListener: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => bridge }));
import { NativeTransport } from '../packages/media/src/native';

const room = { channelId: 'voice', transport: 'livekit', shares: [], members: [] };
const ticket = { epoch: 'epoch', resumeToken: 'resume-token' };
const accepted = (data: unknown = {}) => ({ ok: true, data });
type Reply = (err: Error | null, result?: unknown) => void;
class FakeSocket {
  connected = true;
  events = new EventEmitter();
  sent: { event: string; payload: any }[] = [];
  replyResume?: (reply: Reply) => void;
  on = (event: string, handler: (...args: any[]) => void) => this.events.on(event, handler);
  off = (event: string, handler: (...args: any[]) => void) => this.events.off(event, handler);
  timeout() {
    return { emit: (event: string, payload: any, reply: Reply) => {
      this.sent.push({ event, payload });
      if (event === 'voice:resume' && this.replyResume) return this.replyResume(reply);
      if (event === 'voice:join' || event === 'voice:resume') return reply(null, accepted({ ...ticket, room, iceServers: [] }));
      if (event === 'voice:sfu') return reply(null, accepted({ url: 'ws://local', token: 'local' }));
      reply(null, accepted());
    } };
  }
  disconnect() { this.connected = false; this.events.emit('disconnect', 'transport close'); }
  connect() { this.connected = true; this.events.emit('connect'); }
  count(event: string) { return this.sent.filter(message => message.event === event).length; }
}
const listeners = new Map<string, (event: any) => void>();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  vi.stubGlobal('window', new EventTarget());
  vi.resetAllMocks();
  listeners.clear();
  bridge.addListener.mockImplementation(async (name, handler) => {
    listeners.set(name, handler);
    return { remove: async () => { listeners.delete(name); } };
  });
  bridge.prepare.mockResolvedValue({ microphoneAvailable: true });
  bridge.join.mockResolvedValue({ listenOnly: false });
  for (const method of [bridge.leave, bridge.setState, bridge.updateRoom, bridge.stopShare]) method.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture() {
  const socket = new FakeSocket(), emit = vi.fn();
  const transport = new NativeTransport({ socket: socket as unknown as Socket, userId: 'self', emit });
  return { socket, emit, transport };
}

it('recovers control after a retry while keeping Android media connected', async () => {
  const { socket, transport, emit } = fixture();
  try {
    await transport.join('voice');
    socket.disconnect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.count('voice:heartbeat')).toBe(0);
    socket.replyResume = reply => {
      if (socket.count('voice:resume') === 1) return reply(new Error('timeout'));
      reply(null, accepted({ room, epoch: ticket.epoch }));
    };
    socket.connect();
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.count('voice:resume')).toBe(2);
    expect(socket.sent.find(entry => entry.event === 'voice:resume')?.payload).toMatchObject({ channelId: 'voice', ...ticket });
    expect(bridge.join).toHaveBeenCalledTimes(1);
    expect(bridge.leave).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('status', 'Reconnecting voice…');
    expect(emit).toHaveBeenLastCalledWith('status', 'Native voice connected');
  } finally { await transport.destroy(); }
});

it('reopens ended Android media without prompting again or clearing mute and deafen', async () => {
  const { socket, transport } = fixture();
  try {
    await transport.setMuted(true);
    await transport.setDeafened(true);
    await transport.join('voice');
    listeners.get('voiceMediaDisconnected')?.({ terminal: false });
    await vi.advanceTimersByTimeAsync(20);
    expect(socket.count('voice:resume')).toBe(1);
    expect(bridge.prepare).toHaveBeenCalledTimes(1);
    expect(bridge.join).toHaveBeenCalledTimes(2);
    expect(bridge.join).toHaveBeenLastCalledWith(expect.objectContaining({ recovering: true, muted: true, deafened: true }));
    expect(bridge.startShare).not.toHaveBeenCalled();
  } finally { await transport.destroy(); }
});

it('uses one heartbeat when the Android pulse and WebView fallback overlap', async () => {
  const { socket, transport } = fixture();
  try {
    await transport.join('voice');
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      window.dispatchEvent(new Event('dorham-native-pulse'));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(socket.count('voice:heartbeat')).toBe(4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.count('voice:heartbeat')).toBe(5);
  } finally { await transport.destroy(); }
});

it('ignores an in-flight resume result after explicit leave and stops on authoritative removal', async () => {
  const { socket, transport } = fixture();
  try {
    await transport.join('voice');
    let delayedReply: Reply | undefined;
    socket.replyResume = reply => { delayedReply = reply; };
    listeners.get('voiceMediaDisconnected')?.({ terminal: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(delayedReply).toBeDefined();
    await transport.leave();
    delayedReply?.(null, accepted({ room, epoch: ticket.epoch }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket.count('voice:resume')).toBe(1);
    expect(bridge.join).toHaveBeenCalledTimes(1);
    expect(transport.room).toBeNull();

    await transport.join('voice');
    socket.replyResume = reply => reply(null, { ok: false, error: { code: 'VOICE_SESSION_ENDED', message: 'Removed' } });
    listeners.get('voiceMediaDisconnected')?.({ terminal: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.count('voice:resume')).toBe(2);
    expect(transport.room).toBeNull();
  } finally { await transport.destroy(); }
});
