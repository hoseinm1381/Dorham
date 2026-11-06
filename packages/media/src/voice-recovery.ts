import type { Socket } from 'socket.io-client';
import type { VoiceRoom } from '@dorham/contracts';
import { ack } from './signaling';

type VoiceTicket = { channelId: string; epoch: string; resumeToken: string };
type ResumedVoice = { room: VoiceRoom; epoch: string };
const recoveryLimit = 30_000;
const terminalCodes = new Set(['VOICE_SESSION_ENDED', 'NOT_IN_VOICE', 'UNAUTHENTICATED', 'FORBIDDEN', 'TIMED_OUT', 'NOT_FOUND', 'BANNED']);

// Keep intent and retry state separate from media. An unsuccessful attempt
// must not turn a transient outage into an explicit leave.
export class VoiceRecovery {
  private ticket?: VoiceTicket;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline = 0;
  private attempts = 0;
  private revision = 0;
  private flight?: VoiceTicket;

  constructor(private socket: Socket, private callbacks: {
    waiting(): void;
    restore(result: ResumedVoice, current: () => boolean): Promise<void>;
    ended(): void;
  }) {
    socket.on('disconnect', this.disconnected);
    socket.on('connect', this.connected);
  }

  get supported() { return Boolean(this.ticket); }
  get pending() { return this.deadline !== 0; }

  remember(channelId: string, result: { epoch: string; resumeToken?: string }) {
    if (result.resumeToken) this.ticket = { channelId, epoch: result.epoch, resumeToken: result.resumeToken };
  }

  request() {
    if (!this.ticket) return false;
    if (!this.pending) {
      this.deadline = Date.now() + recoveryLimit;
      this.attempts = 0;
      this.callbacks.waiting();
      this.schedule(0);
    }
    return true;
  }

  cancel() {
    const ticket = this.ticket;
    this.ticket = undefined;
    this.revision++;
    this.deadline = 0;
    clearTimeout(this.timer);
    return ticket;
  }

  destroy() {
    this.cancel();
    this.socket.off('disconnect', this.disconnected);
    this.socket.off('connect', this.connected);
  }

  private disconnected = (reason: string) => {
    this.revision++;
    if (reason === 'io client disconnect' || reason === 'io server disconnect') {
      if (this.ticket) this.callbacks.ended();
    } else if (this.request()) this.schedule(this.deadline - Date.now());
  };

  private connected = () => { if (this.pending) this.schedule(0); };

  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (!this.pending) return;
    const remaining = this.deadline - Date.now();
    this.timer = setTimeout(() => { void this.attempt(); }, Math.max(0, Math.min(delay, remaining)));
  }

  private async attempt() {
    const ticket = this.ticket;
    if (!ticket || !this.pending) return;
    if (Date.now() >= this.deadline) { this.callbacks.ended(); return; }
    if (!this.socket.connected || this.flight === ticket) { this.schedule(this.deadline - Date.now()); return; }
    const revision = this.revision;
    const current = () => this.ticket === ticket && this.revision === revision && this.socket.connected && Date.now() < this.deadline;
    this.flight = ticket;
    this.schedule(this.deadline - Date.now());
    this.attempts++;
    try {
      const result = await ack<ResumedVoice>(this.socket, 'voice:resume', ticket);
      if (!current()) return;
      await this.callbacks.restore(result, current);
      if (current()) {
        this.deadline = 0;
        clearTimeout(this.timer);
      }
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (current() && code && terminalCodes.has(code)) this.callbacks.ended();
    } finally {
      if (this.flight === ticket) this.flight = undefined;
      if (this.ticket === ticket && this.pending) {
        const delay = Math.min(4000, 500 * 2 ** Math.min(this.attempts, 3));
        this.schedule(this.socket.connected ? delay + Math.random() * 300 : this.deadline - Date.now());
      }
    }
  }
}
