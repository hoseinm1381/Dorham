import { expect, it, vi } from 'vitest';
import { MicrophoneGain, clampMicrophoneGain } from '../packages/media/src/microphone-gain';

it('limits microphone gain to 50% through +45 dB and rejects nonfinite input', () => {
  expect([-5, 0.5, 1, 2.5, 10, NaN, Infinity].map(clampMicrophoneGain)).toEqual([0.5, 0.5, 1, 2.5, 10, 1, 1]);
  expect(clampMicrophoneGain(1000)).toBeCloseTo(10 ** (45 / 20));
});
it('gates outgoing audio while muted, rebuilds on capture restart and releases only graph-owned tracks', async () => {
  vi.stubGlobal('MediaStream', class {});
  const sourceTrack = { stop: vi.fn() }, outputs: any[] = [], nodes: any[] = [], destinations: any[] = [];
  const context = { state: 'suspended', resume: vi.fn(async () => {}), createMediaStreamSource: () => ({ connect: vi.fn((node: any) => node), disconnect: vi.fn() }),
    createGain: () => { const node = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }; nodes.push(node); return node; },
    createMediaStreamDestination: () => { const track = { stop: vi.fn() }; outputs.push(track); const destination = { stream: { getAudioTracks: () => [track] } }; destinations.push(destination); return destination; }
  };
  try {
    const gain = new MicrophoneGain(2.5); gain.setEnabled(false);
    await gain.init({ track: sourceTrack as any, audioContext: context as any });
    expect(nodes[0].gain.value).toBe(0); gain.setGain(0.5); expect(nodes[0].gain.value).toBe(0);
    gain.setEnabled(true); expect(nodes[0].gain.value).toBe(0.5);
    gain.setGain(2.5); expect(nodes[0].gain.value).toBe(2.5);
    await gain.restart({ track: sourceTrack as any, audioContext: context as any });
    expect(outputs[0].stop).toHaveBeenCalledOnce(); expect(nodes.find(node => node.connect.mock.calls.some(([target]: any[]) => target === destinations[1])).gain.value).toBe(2.5);
    await gain.destroy(); expect(outputs[1].stop).toHaveBeenCalledOnce(); expect(sourceTrack.stop).not.toHaveBeenCalled(); expect(gain.processedTrack).toBeUndefined();
  } finally { vi.unstubAllGlobals(); }
});
