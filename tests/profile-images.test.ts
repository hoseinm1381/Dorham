import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ProfileImages } from '../apps/api/src/profile-images';
import { harness } from './helpers';

afterEach(() => vi.useRealTimers());
const png = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#9176df' } }).png().toBuffer();

it('admits one image before buffering, bounds its shared queue, and preserves thumbnail output', async () => {
  const images = new ProfileImages(), bytes = await png();
  let release!: (bytes: Buffer) => void;
  const first = images.resize(() => new Promise(resolve => { release = resolve; }));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const read = vi.fn(async () => bytes), second = images.resize(read), third = images.resize(read);
  expect(images.metrics()).toMatchObject({ active: 1, queued: 2, maxActive: 1, maxQueued: 2, threadsPerImage: 1, cache: { memory: { max: 8 } } });
  await expect(images.resize(read)).rejects.toMatchObject({ status: 429, code: 'IMAGE_BUSY' });
  expect(read).not.toHaveBeenCalled();
  release(bytes);
  const results = await Promise.all([first, second, third]);
  const expected = await sharp(bytes, { limitInputPixels: 16000000 }).rotate().resize(128, 128, { fit: 'cover' }).webp({ quality: 80 }).toBuffer();
  for (const result of results) { expect(result.bytes).toEqual(bytes); expect(result.image).toEqual(expected); }
  expect(images.metrics()).toMatchObject({ active: 0, queued: 0, rejected: 1, completed: 3 }); images.close();
});

it('releases its decoder after failed uploads and rejects invalid or oversized decoded images', async () => {
  const images = new ProfileImages();
  await expect(images.resize(async () => { throw new Error('Upload disconnected'); })).rejects.toThrow('Upload disconnected');
  await expect(images.resize(async () => Buffer.from('invalid'))).rejects.toMatchObject({ status: 400, code: 'INVALID_IMAGE' });
  const oversized = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: 'white' } }).png().toBuffer();
  await expect(images.resize(async () => oversized)).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
  expect((await images.resize(png)).image.length).toBeGreaterThan(0);
  expect(images.metrics()).toMatchObject({ active: 0, queued: 0, completed: 1 }); images.close();
});

it('expires queued uploads without reading them and admits later uploads after the active one finishes', async () => {
  const bytes = await png(); vi.useFakeTimers();
  const images = new ProfileImages(); let release!: (bytes: Buffer) => void;
  const first = images.resize(() => new Promise(resolve => { release = resolve; })); await Promise.resolve();
  const read = vi.fn(async () => bytes), waiting = images.resize(read);
  const expired = expect(waiting).rejects.toMatchObject({ status: 429, code: 'IMAGE_BUSY' });
  await vi.advanceTimersByTimeAsync(10000); await expired;
  expect(read).not.toHaveBeenCalled(); expect(images.metrics().queued).toBe(0);
  vi.useRealTimers(); release(bytes); await first;
  await images.resize(read); expect(read).toHaveBeenCalledTimes(1); images.close();
});

it('rejects waiting and future uploads during shutdown while the admitted decoder drains', async () => {
  const bytes = await png(), images = new ProfileImages(); let release!: (bytes: Buffer) => void;
  const first = images.resize(() => new Promise(resolve => { release = resolve; })); await Promise.resolve();
  const read = vi.fn(async () => bytes), waiting = images.resize(read);
  const stopped = expect(waiting).rejects.toMatchObject({ status: 503, code: 'IMAGE_BUSY' });
  images.close(); await stopped;
  await expect(images.resize(read)).rejects.toMatchObject({ status: 503 }); expect(read).not.toHaveBeenCalled();
  release(bytes); await first; expect(images.metrics()).toMatchObject({ active: 0, queued: 0 });
});

it('shares the same admission budget across real avatar and server-icon routes', async () => {
  const h = await harness(); let release!: (bytes: Buffer) => void;
  const bytes = await png(); let blocker: Promise<unknown> | undefined;
  try {
    const owner = await h.register('image_owner'), member = await h.register('image_member');
    await h.db.run('UPDATE users SET instance_admin=1 WHERE id=?', [owner.id]);
    const server = (await h.api(owner, '/servers', { name: 'Images' })).json();
    const upload = (route: string) => {
      const boundary = 'dorham-images';
      return h.app.inject({ method: 'POST', url: `/api/v1${route}`, headers: { authorization: `Bearer ${owner.token}`, 'x-request-id': randomUUID(), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) });
    };
    blocker = h.images.resize(() => new Promise(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const avatar = upload('/profile/avatar').then(r => r), icon = upload(`/servers/${server.id}/icon`).then(r => r);
    await vi.waitFor(() => expect(h.images.metrics().queued).toBe(2));
    const overflow = await upload('/profile/avatar'); expect(overflow.statusCode).toBe(429); expect(overflow.json().error.code).toBe('IMAGE_BUSY');
    release(bytes); await blocker;
    const responses = await Promise.all([avatar, icon]);
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200);
      const url = response.json().avatar || response.json().icon;
      expect(await sharp(await readFile(path.join(h.dataDir, url))).metadata()).toMatchObject({ width: 128, height: 128, format: 'webp' });
    }
    expect((await h.api(owner, '/admin/metrics')).json().images).toMatchObject({ active: 0, queued: 0, completed: 3, rejected: 1 });
    expect((await h.api(member, '/admin/metrics')).statusCode).toBe(403);
  } finally { if (release) release(bytes); await blocker; await h.close(); }
});
