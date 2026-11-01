import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

const unavailable = () => Error('TTS is unavailable. Your message was sent normally.');
type Pending = { resolve: (audio: Buffer) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

// A serial request worker. Releasing this child returns its model/native memory
// to the OS; it does not restart the application or disconnect voice clients.
export class SpeechWorker {
  private child?: ChildProcessWithoutNullStreams;
  private reader?: Interface;
  private pending?: Pending;
  private retiring?: { child: ChildProcessWithoutNullStreams; done: Promise<void> };
  private closed = false;
  private lastUsed = Date.now();
  private starts = 0;
  private idleStops = 0;
  constructor(private start: () => ChildProcessWithoutNullStreams, private idleMs: number) {}

  private launch() {
    const child = this.start(); this.child = child; this.starts++;
    child.stderr.resume();
    const reader = createInterface({ input: child.stdout }); this.reader = reader;
    reader.on('line', line => {
      if (this.child !== child || !this.pending) return;
      const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer); this.lastUsed = Date.now();
      try {
        const response = JSON.parse(line); if (typeof response.audio !== 'string') throw unavailable();
        // Reject before decoding an oversized base64 payload as well as after it.
        if (response.audio.length > 4000000) throw unavailable();
        const audio = Buffer.from(response.audio, 'base64');
        if (audio.length > 3000000 || audio.toString('ascii', 0, 4) !== 'RIFF') throw unavailable();
        pending.resolve(audio);
      } catch { pending.reject(unavailable()); }
    });
    const ended = () => {
      if (this.child !== child) return;
      this.child = undefined; this.reader = undefined; reader.close();
      const pending = this.pending; this.pending = undefined;
      if (pending) { clearTimeout(pending.timer); pending.reject(unavailable()); }
    };
    child.on('error', ended); child.on('exit', ended);
    child.stdin.on('error', () => {
      if (this.child !== child) return;
      const pending = this.pending; this.pending = undefined;
      if (pending) { clearTimeout(pending.timer); pending.reject(unavailable()); }
      void this.retire();
    });
    return child;
  }

  async synthesize(text: string, onColdStart?: () => Promise<void>): Promise<Buffer> {
    if (this.retiring) await this.retiring.done;
    if (this.closed || this.pending) throw unavailable();
    const cold = !this.child, child = this.child || this.launch(); this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined; void this.retire();
        reject(Error('TTS timed out. Your message was sent normally.'));
      }, 60000);
      const pending = { resolve, reject, timer }; this.pending = pending;
      const write = () => {
        if (this.child !== child || this.pending !== pending) return;
        try { child.stdin.write(JSON.stringify({ text }) + '\n'); }
        catch { this.pending = undefined; clearTimeout(timer); void this.retire(); reject(unavailable()); }
      };
      // Reserve work before awaiting notification routing, preserving shutdown,
      // timeout and concurrent-request protection during startup.
      if (cold && onColdStart) void Promise.resolve().then(onColdStart).then(write, write);
      else write();
    });
  }

  private retire(): Promise<void> | undefined {
    const child = this.child;
    if (!child) return this.retiring?.done;
    this.child = undefined; this.reader?.close(); this.reader = undefined;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    this.retiring = { child, done };
    const complete = () => {
      clearTimeout(timer); child.removeListener('exit', complete); child.removeListener('error', complete);
      if (this.retiring?.child === child) this.retiring = undefined;
      finish();
    };
    // Do not overlap model processes if a new request arrives during shutdown.
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2000); timer.unref();
    child.once('exit', complete); child.once('error', complete);
    child.kill();
    return done;
  }

  cleanup() {
    if (!this.closed && this.child && !this.pending && Date.now() - this.lastUsed >= this.idleMs) {
      this.idleStops++; void this.retire();
    }
  }
  metrics() {
    return { running: Boolean(this.child), stopping: Boolean(this.retiring), pid: this.child?.pid ?? null, busy: Boolean(this.pending), starts: this.starts, idleStops: this.idleStops, idleSeconds: this.idleMs / 1000 };
  }
  async close() {
    this.closed = true;
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(unavailable()); }
    await this.retire();
  }
}
