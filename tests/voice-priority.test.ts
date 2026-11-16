import { expect, it } from 'vitest';
import { VoicePriority, bufferMusic, screenEncodingBudget } from '../packages/media/src/voice-priority';

it('reduces screen delivery immediately and restores one level after three stable samples', () => {
  const priority = new VoicePriority();
  expect(priority.observe('reduced', false)).toBe('reduced');
  expect(priority.observe('paused', true)).toBe('paused');
  expect(priority.observe('full', false)).toBe('paused');
  expect(priority.observe('full', true)).toBe('paused');
  expect(priority.observe('paused', false)).toBe('paused');
  expect(priority.observe('full', true)).toBe('paused');
  expect(priority.observe('full', true)).toBe('paused');
  expect(priority.observe('full', true)).toBe('reduced');
  expect(priority.observe('full', true)).toBe('reduced');
  expect(priority.observe('full', true)).toBe('reduced');
  expect(priority.observe('full', true)).toBe('full');
});

it('reserves a low screen layer within the publisher bandwidth cap', () => {
  expect(screenEncodingBudget(300000)).toEqual({ full: 225000, fallback: 75000 });
  expect(screenEncodingBudget(1200000)).toEqual({ full: 1100000, fallback: 100000 });
});

it('requests a music playout buffer only on receivers with the WebRTC control', () => {
  const supported = { jitterBufferTarget: null };
  const unsupported = {};
  bufferMusic(supported as unknown as RTCRtpReceiver);
  bufferMusic(unsupported as RTCRtpReceiver);
  expect(supported.jitterBufferTarget).toBe(1500);
  expect(unsupported).not.toHaveProperty('jitterBufferTarget');
});
