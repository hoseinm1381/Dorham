// Concurrent requests share a pass. A mutation arriving during a pass always
// gets a subsequent pass before its caller resolves; stale work cannot win.
export class SingleFlight {
  private active = false;
  private requested = 0;
  private waiters: { revision: number; resolve: () => void; reject: (reason: unknown) => void }[] = [];
  constructor(private work: () => Promise<void>) {}
  run(): Promise<void> {
    const revision = ++this.requested;
    const result = new Promise<void>((resolve, reject) => { this.waiters.push({ revision, resolve, reject }); });
    if (!this.active) { this.active = true; void Promise.resolve().then(() => this.drain()); }
    return result;
  }
  private async drain() {
    try {
      while (this.waiters.length) {
        const revision = this.requested;
        await this.work();
        const done = this.waiters.filter(w => w.revision <= revision);
        this.waiters = this.waiters.filter(w => w.revision > revision);
        done.forEach(w => w.resolve());
      }
    } catch (error) { const failed = this.waiters; this.waiters = []; failed.forEach(w => w.reject(error)); }
    finally { this.active = false; }
  }
}
