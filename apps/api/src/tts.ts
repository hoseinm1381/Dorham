import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Message } from '@dorham/contracts';
import type { VoiceTts } from '../../../packages/contracts/src/tts';
import type { Service } from './service';
type Synthesize = (text: string) => Promise<Buffer>;
export class VoiceSpeech {
  private process?: ChildProcessWithoutNullStreams;
  private pending?: { resolve: (data: Buffer) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
  private queue = Promise.resolve(); private queued = 0; private started = Date.now(); private closed = false;
  private seen = new Map<string, number>(); private cooldown = new Map<string, number>();
  private audio = new Map<string, { data: Buffer; channelId: string; recipients: Map<string, string>; expires: number }>();
  constructor(private service: Service, private deliver: (socketId: string, event: VoiceTts) => void, private notice: (userId: string, text: string) => void, private engine?: Synthesize) {}
  private synthesize(text: string): Promise<Buffer> {
    if (this.engine) return this.engine(text);
    const python = process.env.DORHAM_TTS_PYTHON || '/opt/dorham-tts/venv/bin/python';
    if (!existsSync(python)) return Promise.reject(Error('TTS is unavailable. Your message was sent normally.'));
    if (!this.process) {
      const child = spawn(python, ['-u', path.resolve('deployment/tts-worker.py')], { stdio: 'pipe', windowsHide: true, env: { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' } }); this.process = child;
      child.stderr.resume();
      createInterface({ input: child.stdout }).on('line', line => {
        if (this.process !== child) return;
        const p = this.pending; if (!p) return; this.pending = undefined; clearTimeout(p.timer);
        try { const data = JSON.parse(line); if (!data.audio) throw Error('synthesis'); const audio = Buffer.from(data.audio, 'base64'); if (audio.length > 3000000 || audio.toString('ascii', 0, 4) !== 'RIFF') throw Error('format'); p.resolve(audio); } catch { p.reject(Error('TTS is unavailable. Your message was sent normally.')); }
      });
      const ended = () => { if (this.process !== child) return; this.process = undefined; const p = this.pending; this.pending = undefined; if (p) { clearTimeout(p.timer); p.reject(Error('TTS is unavailable. Your message was sent normally.')); } };
      child.on('error', ended); child.on('exit', ended);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = undefined; this.process?.kill(); this.process = undefined; reject(Error('TTS timed out. Your message was sent normally.')); }, 60000);
      this.pending = { resolve, reject, timer }; this.process!.stdin.write(JSON.stringify({ text }) + '\n');
    });
  }
  async enqueue(userId: string, message: Message) {
    const now = Date.now();
    for (const [key, expiry] of this.seen) if (expiry < now) this.seen.delete(key);
    for (const [key, value] of this.audio) if (value.expires < now) this.audio.delete(key);
    for (const [key, at] of this.cooldown) if (at < now - 60000) this.cooldown.delete(key);
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
        const data = await this.synthesize(message.content);
        const current = await this.service.db.one('SELECT * FROM voice_members WHERE user_id=? AND channel_id=? AND epoch=? AND heartbeat>?', [userId, sender.channel_id, sender.epoch, Date.now() - 30000]);
        const stored = await this.service.db.one('SELECT content,deleted FROM messages WHERE id=?', [message.id]);
        if (!current || current.server_muted || !stored || stored.deleted || stored.content !== message.content) return;
        await this.service.db.transaction(tx => this.service.channel(tx, userId, sender.channel_id, 'speak'));
        const members = await this.service.db.all('SELECT user_id,epoch,socket_id FROM voice_members WHERE channel_id=? AND deafened=0 AND server_deafened=0 AND heartbeat>?', [sender.channel_id, Date.now() - 30000]);
        const recipients = new Map<string, string>(members.filter(m => initial.some(i => i.user_id === m.user_id && i.epoch === m.epoch)).map(m => [m.user_id, m.epoch]));
        while (this.audio.size >= 8) this.audio.delete(this.audio.keys().next().value!);
        const expires = Date.now() + 120000; this.audio.set(message.id, { data, recipients, channelId: sender.channel_id, expires });
        for (const member of members) if (recipients.has(member.user_id)) this.deliver(member.socket_id, { id: message.id, channelId: sender.channel_id, userId, expiresAt: expires });
      } catch { if (!this.closed) this.notice(userId, 'TTS is unavailable. Your message was sent normally.'); }
      finally { this.queued--; }
    });
  }
  async read(userId: string, id: string) {
    const item = this.audio.get(id); if (!item || item.expires < Date.now() || !item.recipients.has(userId)) return null;
    const member = await this.service.db.one('SELECT epoch FROM voice_members WHERE user_id=? AND channel_id=? AND deafened=0 AND server_deafened=0 AND heartbeat>?', [userId, item.channelId, Date.now() - 30000]);
    return member?.epoch === item.recipients.get(userId) ? item.data : null;
  }
  close() { this.closed = true; this.process?.kill(); this.audio.clear(); }
}
