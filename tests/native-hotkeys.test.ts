import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
let hotkeys: any;
const children: any[] = [];
function helper() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.end = vi.fn(); child.kill = vi.fn(); children.push(child); return child;
}
const preferences = (code = 'F9') => ({ mode: 'push', background: true, binding: { code, ctrl: false, alt: false, shift: false } });
beforeEach(() => { vi.useFakeTimers(); children.length = 0; });
afterEach(() => { hotkeys?.stop(); hotkeys = undefined; vi.restoreAllMocks(); vi.useRealTimers(); });

// Stub only process creation; exercise the product's actual child-protocol,
// watchdog and generation fences without intercepting the user's keyboard.
function fixture() {
  const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation(helper);
  delete require.cache[require.resolve('../apps/desktop/voice-hotkeys.cjs')];
  const { VoiceHotkeys } = require('../apps/desktop/voice-hotkeys.cjs');
  const events: any[] = [];
  hotkeys = new VoiceHotkeys({ isPackaged: false }, (event: any) => events.push(event));
  hotkeys.configure(preferences()); hotkeys.setActive(true);
  return { events, spawn, child: children[0] };
}

it.skipIf(process.platform !== 'win32')('native hotkeys parse fragmented child events, tolerate heartbeats and fail closed on a stalled helper', () => {
  const { events, child, spawn } = fixture();
  expect(spawn).toHaveBeenCalledOnce();
  child.stdout.emit('data', Buffer.from('D')); expect(events.at(-1)).toEqual({ type: 'release' });
  child.stdout.emit('data', Buffer.from('\nH\nU\n'));
  expect(events.slice(-2)).toEqual([{ type: 'down' }, { type: 'up' }]);
  vi.advanceTimersByTime(2000); child.stdout.emit('data', Buffer.from('H\n'));
  vi.advanceTimersByTime(2000); expect(child.kill).not.toHaveBeenCalled();
  vi.advanceTimersByTime(500);
  expect(child.kill).toHaveBeenCalledOnce(); expect(child.stdin.end).toHaveBeenCalledOnce();
  expect(events.slice(-2)).toEqual([{ type: 'release' }, expect.objectContaining({ type: 'error' })]);
  expect(vi.getTimerCount()).toBe(0);
});

it.skipIf(process.platform !== 'win32')('native hotkeys ignore retired helper output and exit events after a binding change', () => {
  const { events, child: old, spawn } = fixture();
  old.stdout.emit('data', Buffer.from('D\n'));
  hotkeys.configure(preferences('F10')); const current = children[1];
  expect(spawn).toHaveBeenCalledTimes(2); expect(old.kill).toHaveBeenCalledOnce();
  const count = events.length;
  old.stdout.emit('data', Buffer.from('D\n')); old.emit('exit', 1); old.emit('error', new Error('retired helper'));
  expect(events).toHaveLength(count); expect(current.kill).not.toHaveBeenCalled();
  current.stdout.emit('data', Buffer.from('D\n')); expect(events.at(-1)).toEqual({ type: 'down' });
  hotkeys.setActive(false);
  expect(current.kill).toHaveBeenCalledOnce(); expect(events.at(-1)).toEqual({ type: 'release' });
  expect(vi.getTimerCount()).toBe(0);
});

it.skipIf(process.platform !== 'win32')('native hotkeys reject invalid or unbounded helper output and release the microphone once', () => {
  const { events, child } = fixture();
  child.stdout.emit('data', Buffer.from('A'.repeat(17)));
  expect(child.kill).toHaveBeenCalledOnce();
  expect(events.slice(-2)).toEqual([{ type: 'release' }, expect.objectContaining({ type: 'error' })]);
  const count = events.length; child.emit('exit', 1); child.emit('error', new Error('already retired'));
  expect(events).toHaveLength(count); expect(vi.getTimerCount()).toBe(0);
});
