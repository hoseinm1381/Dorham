import { expect, it } from 'vitest';
import { VoicePriority, bufferMusic, outgoingScreenShare, receivingScreenFps, screenEncodingTarget } from '../packages/media/src/voice-priority';

it('reduces screen quality immediately and restores it after three stable samples', () => {
  const priority = new VoicePriority();
  expect(priority.observe('reduced', false)).toBe('reduced');
  expect(priority.observe('full', false)).toBe('reduced');
  expect(priority.observe('full', true)).toBe('reduced');
  expect(priority.observe('reduced', false)).toBe('reduced');
  expect(priority.observe('full', true)).toBe('reduced');
  expect(priority.observe('full', true)).toBe('reduced');
  expect(priority.observe('full', true)).toBe('full');
});

it('adapts the single upload continuously within the selected quality limits', () => {
  const targets = [600000, 340000, 240000, 130000, 30000].map(available =>
    screenEncodingTarget(outgoingScreenShare(600000, available, false), 600000, 30, 720));
  expect(targets[0]).toEqual({ bitrate: 600000, fps: 30, scale: 1 });
  for (let i = 1; i < targets.length; i++) {
    expect(targets[i].bitrate).toBeLessThan(targets[i - 1].bitrate);
    expect(targets[i].fps).toBeLessThan(targets[i - 1].fps);
    expect(targets[i].scale).toBeGreaterThan(targets[i - 1].scale);
  }
  expect(screenEncodingTarget(0, 600000, 30, 720)).toEqual({ bitrate: 32000, fps: 4, scale: 3 });
  expect(outgoingScreenShare(600000, undefined, true)).toBe(.55);
  expect(receivingScreenFps(.1, 1)).toBeLessThan(receivingScreenFps(.04, 1));
});

it('requests a music playout buffer only on receivers with the WebRTC control', () => {
  const supported = { jitterBufferTarget: null };
  const unsupported = {};
  bufferMusic(supported as unknown as RTCRtpReceiver);
  bufferMusic(unsupported as RTCRtpReceiver);
  expect(supported.jitterBufferTarget).toBe(1500);
  expect(unsupported).not.toHaveProperty('jitterBufferTarget');
});
