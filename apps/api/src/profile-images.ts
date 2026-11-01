import sharp from 'sharp';
import { AppError, fail } from './security';

// These small, one-off thumbnails do not benefit from a large retained operation cache.
// This is a cache budget, not a limit on all native allocations during decoding.
sharp.cache({ memory: 8, files: 0, items: 32 });
sharp.concurrency(1);

type Waiter = { start: () => void; stop: () => void };

/** One decoder shared by avatars and server icons; queued uploads remain unread. */
export class ProfileImages {
  private active = false;
  private closed = false;
  private waiting: Waiter[] = [];
  private rejected = 0;
  private completed = 0;

  private async acquire() {
    if (this.closed) fail(503, 'IMAGE_BUSY', 'Image processing is unavailable. Try again shortly.');
    if (!this.active) { this.active = true; return; }
    if (this.waiting.length >= 2) { this.rejected++; fail(429, 'IMAGE_BUSY', 'Image processing is busy. Try again shortly.'); }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        start: () => { clearTimeout(timer); resolve(); },
        stop: () => { clearTimeout(timer); reject(new AppError(503, 'IMAGE_BUSY', 'Image processing is unavailable. Try again shortly.')); },
      };
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(waiter), 1);
        this.rejected++;
        reject(new AppError(429, 'IMAGE_BUSY', 'Image processing is busy. Try again shortly.'));
      }, 10000);
      timer.unref();
      this.waiting.push(waiter);
    });
  }

  async resize(read: () => Promise<Buffer>) {
    await this.acquire();
    try {
      // Admission precedes buffering as well as native decoding.
      const bytes = await read();
      let image: Buffer;
      try { image = await sharp(bytes, { limitInputPixels: 16000000 }).rotate().resize(128, 128, { fit: 'cover' }).webp({ quality: 80 }).toBuffer(); }
      catch { fail(400, 'INVALID_IMAGE', 'Image could not be decoded.'); }
      this.completed++;
      return { bytes, image: image! };
    } finally {
      const next = this.waiting.shift();
      if (next) next.start(); else this.active = false;
    }
  }

  metrics() {
    return { active: Number(this.active), queued: this.waiting.length, maxActive: 1, maxQueued: 2, rejected: this.rejected, completed: this.completed, threadsPerImage: sharp.concurrency(), cache: sharp.cache() };
  }

  close() { this.closed = true; for (const waiter of this.waiting.splice(0)) waiter.stop(); }
}
