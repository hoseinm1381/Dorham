import { spawn } from 'node:child_process';
import { SpeechWorker } from './speech-worker';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Message } from '@dorham/contracts';
import type { VoiceTts } from '../../../packages/contracts/src/tts';
import type { Service } from './service';
import type { Row } from './db';
export type Synthesize = (text: string, onColdStart?: () => Promise<void>) => Promise<Buffer>;
export class VoiceSpeech {
  private worker: SpeechWorker;
  private audioBytes = 0;
  private queue = Promise.resolve(); private queued = 0; private started = Date.now(); private closed = false;
  private seen = new Map<string, number>(); private cooldown = new Map<string, number>();
  private audio = new Map<string, { data: Buffer; channelId: string; recipients: Map<string, string>; expires: number }>();
  constructor(private service: Service, private deliver: (socketId: string, event: VoiceTts) => void, private notice: (userId: string, text: string) => void, private engine?: Synthesize, private loading: (socketId: string, event: VoiceTts) => void = () => {}) {
    this.worker = new SpeechWorker(() => {
      const python = process.env.DORHAM_TTS_PYTHON || '/opt/dorham-tts/venv/bin/python';
      if (!existsSync(python)) throw Error('TTS is unavailable. Your message was sent normally.');
      return spawn(python, ['-u', path.resolve('deployment/tts-worker.py')], { stdio: 'pipe', windowsHide: true, env: { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' } });
    }, service.c.ttsIdleSeconds * 1000);
  }
  private removeAudio(id: string) {
    const entry = this.audio.get(id); if (!entry) return;
    this.audioBytes -= entry.data.length; this.audio.delete(id);
  }
  cleanup() {
    const now = Date.now();
    for (const [id, expires] of this.seen) if (expires <= now) this.seen.delete(id);
    for (const [id, entry] of this.audio) if (entry.expires <= now) this.removeAudio(id);
    for (const [id, at] of this.cooldown) if (at <= now - 60000) this.cooldown.delete(id);
    if (this.queued === 0) this.worker.cleanup();
  }
  metrics() {
    return { worker: this.worker.metrics(), queued: this.queued, cachedClips: this.audio.size, cachedAudioBytes: this.audioBytes, audioBudgetBytes: this.service.c.ttsAudioCacheMiB * 1048576, dedupEntries: this.seen.size, cooldownEntries: this.cooldown.size };
  }
  private async audience(userId: string, message: Message, sender: Row, initial: Row[]) {
    if (this.closed) return null;
    const current = await this.service.db.one('SELECT * FROM voice_members WHERE user_id=? AND channel_id=? AND epoch=? AND heartbeat>?', [userId, sender.channel_id, sender.epoch, Date.now() - 30000]);
    const stored = await this.service.db.one('SELECT content,deleted FROM messages WHERE id=?', [message.id]);
    if (this.closed || !current || current.server_muted || !stored || stored.deleted || stored.content !== message.content) return null;
    await this.service.db.transaction(tx => this.service.channel(tx, userId, sender.channel_id, 'speak'));
    const members = await this.service.db.all('SELECT user_id,epoch,socket_id FROM voice_members WHERE channel_id=? AND deafened=0 AND server_deafened=0 AND heartbeat>?', [sender.channel_id, Date.now() - 30000]);
    return this.closed ? null : members.filter(m => initial.some(i => i.user_id === m.user_id && i.epoch === m.epoch));
  }
  async enqueue(userId: string, message: Message) {
    const now = Date.now();
    this.cleanup();
    if (this.closed || this.seen.has(message.id) || message.createdAt < this.started - 1000 || now - message.createdAt > 30000) return;
    this.seen.set(message.id, now + 60000);
    const sender = await this.service.db.one('SELECT * FROM voice_members WHERE user_id=? AND heartbeat>?', [userId, now - 30000]);
    if (!sender) return; // Required fallback: the ordinary text message is already committed.
    try { if (sender.server_muted) throw Error('You cannot use TTS while server-muted.'); await this.service.db.transaction(tx => this.service.channel(tx, userId, sender.channel_id, 'speak')); }
    catch { this.notice(userId, 'You cannot use TTS in this voice channel. Your message was sent normally.'); return; }
    if (message.content.length > 400 || this.queued >= 4 || now - (this.cooldown.get(userId) || 0) < 4000) { this.notice(userId, 'TTS is limited to 400 characters and one request every 4 seconds. Your message was sent normally.'); return; }
    const initial = await this.service.db.all('SELECT user_id,epoch FROM voice_members WHERE channel_id=? AND heartbeat>?', [sender.channel_id, now - 30000]);
    if (this.queued >= 4) { this.notice(userId, 'TTS is busy. Your message was sent normally.'); return; }
    this.cooldown.set(userId, now); this.queued++;
    this.queue = this.queue.then(async () => {
      try {
        if (this.closed) return;
        let announced = false;
        const onColdStart = async () => {
          if (announced || this.closed) return; announced = true;
          const members = await this.audience(userId, message, sender, initial);
          if (!members || this.closed) return;
          for (const member of members) this.loading(member.socket_id, { id: message.id, channelId: sender.channel_id, userId, expiresAt: Date.now() + 15000 });
        };
        const data = await (this.engine ? this.engine(message.content, onColdStart) : this.worker.synthesize(message.content, onColdStart));
        if (this.closed) return;
        const members = await this.audience(userId, message, sender, initial); if (!members) return;
        const recipients = new Map<string, string>(members.map(m => [m.user_id, m.epoch]));
        const budget = this.service.c.ttsAudioCacheMiB * 1048576;
        if (data.length > Math.min(budget, 3000000)) throw Error('Speech audio exceeds its memory budget.');
        while (this.audio.size >= 8 || this.audioBytes + data.length > budget) this.removeAudio(this.audio.keys().next().value!);
        const expires = Date.now() + 120000; this.audio.set(message.id, { data, recipients, channelId: sender.channel_id, expires }); this.audioBytes += data.length;
        for (const member of members) if (recipients.has(member.user_id)) this.deliver(member.socket_id, { id: message.id, channelId: sender.channel_id, userId, expiresAt: expires });
      } catch { if (!this.closed) this.notice(userId, 'TTS is unavailable. Your message was sent normally.'); }
      finally { this.queued--; }
    });
  }
  async read(userId: string, id: string) {
    const item = this.audio.get(id); if (item && item.expires <= Date.now()) this.removeAudio(id);
    if (this.closed || !item || item.expires <= Date.now() || !item.recipients.has(userId)) return null;
    const member = await this.service.db.one('SELECT epoch FROM voice_members WHERE user_id=? AND channel_id=? AND deafened=0 AND server_deafened=0 AND heartbeat>?', [userId, item.channelId, Date.now() - 30000]);
    return member?.epoch === item.recipients.get(userId) ? item.data : null;
  }
  async close() { this.closed = true; this.audio.clear(); this.audioBytes = 0; this.seen.clear(); this.cooldown.clear(); await this.worker.close(); }
}
