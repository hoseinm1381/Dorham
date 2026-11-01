import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { SpeechWorker } from '../apps/api/src/speech-worker';
import { fixtureSpeech } from './tts-fixture';
import { config } from '../apps/api/src/config';

afterEach(() => vi.useRealTimers());
function child() {
  return Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
}
function reply(c: ReturnType<typeof child>) { c.stdout.write(JSON.stringify({ audio: fixtureSpeech().toString('base64') }) + '\n'); }

it('defaults to 180 idle seconds, announces only a fresh child, and announces again after retirement', async () => {
  expect(config().ttsIdleSeconds).toBe(180);
  vi.useFakeTimers(); const a = child(), b = child(), start = vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b), worker = new SpeechWorker(start, 180000), loading = vi.fn(async () => {});
  const first = worker.synthesize('first', loading); await vi.waitFor(() => expect(a.stdin.readableLength).toBeGreaterThan(0)); reply(a); await first;
  expect(loading).toHaveBeenCalledTimes(1);
  const warm = worker.synthesize('warm', loading); reply(a); await warm; expect(loading).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(179999); worker.cleanup(); expect(a.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); worker.cleanup(); expect(a.kill).toHaveBeenCalledTimes(1); a.emit('exit', 0);
  const next = worker.synthesize('cold again', loading); await vi.waitFor(() => expect(loading).toHaveBeenCalledTimes(2)); reply(b); await next;
  const closing = worker.close(); b.emit('exit', 0); await closing;
});

it('fences concurrent work and shutdown while cold-start notification is awaiting routing', async () => {
  const c = child(), worker = new SpeechWorker(() => c as unknown as ChildProcessWithoutNullStreams, 180000); let release!: () => void;
  const first = worker.synthesize('starting', () => new Promise(resolve => { release = resolve; })), rejected = expect(first).rejects.toThrow('unavailable');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await expect(worker.synthesize('concurrent')).rejects.toThrow('unavailable'); expect(c.stdin.readableLength).toBe(0);
  const closing = worker.close(); c.emit('exit', 0); await closing; await rejected; release(); await Promise.resolve();
  expect(c.stdin.readableLength).toBe(0);
});

it('never retires active synthesis and measures idle time from the completed reply', async () => {
  vi.useFakeTimers(); const c = child(), worker = new SpeechWorker(() => c as unknown as ChildProcessWithoutNullStreams, 1000);
  const pending = worker.synthesize('hello');
  await vi.advanceTimersByTimeAsync(1500); worker.cleanup(); expect(c.kill).not.toHaveBeenCalled();
  reply(c); await expect(pending).resolves.toEqual(fixtureSpeech());
  await vi.advanceTimersByTimeAsync(999); worker.cleanup(); expect(c.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); worker.cleanup(); expect(c.kill).toHaveBeenCalledTimes(1);
  expect(worker.metrics()).toMatchObject({ running: false, stopping: true, idleStops: 1 });
  c.emit('exit', 0); await worker.close();
});

it('waits for the retiring child to exit before launching its replacement', async () => {
  vi.useFakeTimers(); const a = child(), b = child(), start = vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b), worker = new SpeechWorker(start, 1000);
  const first = worker.synthesize('first'); reply(a); await first;
  await vi.advanceTimersByTimeAsync(1000); worker.cleanup();
  const second = worker.synthesize('second'); expect(start).toHaveBeenCalledTimes(1);
  a.emit('exit', 0); await Promise.resolve(); expect(start).toHaveBeenCalledTimes(2);
  reply(b); await expect(second).resolves.toEqual(fixtureSpeech());
  const closing = worker.close(); b.emit('exit', 0); await closing;
});

it('rejects a timed-out request and fences late output from the stopped worker', async () => {
  vi.useFakeTimers(); const c = child(), worker = new SpeechWorker(() => c as unknown as ChildProcessWithoutNullStreams, 1000);
  const pending = worker.synthesize('stuck'), rejected = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(60000); await rejected;
  expect(c.kill).toHaveBeenCalledTimes(1); reply(c); expect(worker.metrics().busy).toBe(false);
  c.emit('exit', 0); await worker.close();
});

it('shutdown rejects in-flight speech, waits for exit and prevents a new process', async () => {
  const c = child(), start = vi.fn(() => c as unknown as ChildProcessWithoutNullStreams), worker = new SpeechWorker(start, 1000);
  const pending = worker.synthesize('closing'), rejected = expect(pending).rejects.toThrow('unavailable');
  const closing = worker.close(); c.emit('exit', 0); await closing; await rejected;
  await expect(worker.synthesize('after close')).rejects.toThrow('unavailable'); expect(start).toHaveBeenCalledTimes(1);
});

it('releases an actual 32 MiB child process after idle and restarts for the next request', async () => {
  const processes: ChildProcessWithoutNullStreams[] = [];
  const source = `global.memory=Buffer.alloc(32*1024*1024,1);require('node:readline').createInterface({input:process.stdin}).on('line',()=>console.log(JSON.stringify({audio:'${fixtureSpeech().toString('base64')}'})));`;
  const worker = new SpeechWorker(() => { const c = spawn(process.execPath, ['-e', source], { stdio: 'pipe', windowsHide: true }); processes.push(c); return c; }, 20);
  try {
    await expect(worker.synthesize('hello')).resolves.toEqual(fixtureSpeech());
    await new Promise(resolve => setTimeout(resolve, 30)); worker.cleanup();
    await expect.poll(() => worker.metrics().stopping).toBe(false);
    expect(processes[0].exitCode !== null || processes[0].signalCode !== null).toBe(true);
    await expect(worker.synthesize('سلام')).resolves.toEqual(fixtureSpeech());
    expect(processes).toHaveLength(2); expect(worker.metrics()).toMatchObject({ starts: 2, idleStops: 1 });
  } finally { await worker.close(); }
});
