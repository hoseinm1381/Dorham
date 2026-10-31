import { afterEach, expect, it, vi } from 'vitest';
import { StrongDenoiser } from '../packages/media/src/strong-denoiser';
import { readBoostNoise } from '../apps/web/src/microphone-preferences';
import { readNoiseRemoval, saveNoiseRemoval } from '../apps/web/src/noise-removal-preferences';
afterEach(() => vi.unstubAllGlobals());
it('migrates an explicitly disabled browser suppressor and validates saved modes', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  expect(readNoiseRemoval()).toBe('standard'); values.set('dorham.audioProcessing.v1', '{"noiseSuppression":false}'); expect(readNoiseRemoval()).toBe('off');
  values.set('dorham.boostNoise.v1', '{"enabled":false,"threshold":-40}'); expect(readBoostNoise()).toEqual({ enabled: false, threshold: -70 });
  saveNoiseRemoval('strong'); expect(readNoiseRemoval()).toBe('strong');
  values.set('dorham.noiseRemoval.v1', 'invalid'); expect(readNoiseRemoval()).toBe('off');
});
it('falls back without loading a model on unsupported sample rates', async () => {
  const input = { connect: vi.fn(), disconnect: vi.fn() }, output = {};
  const graph = new StrongDenoiser({ sampleRate: 44100, audioWorklet: {} } as any, input as any, output as any);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await graph.configure('strong'); expect(graph.state).toMatchObject({ requested: 'strong', active: 'standard', status: 'fallback' }); expect(fetch).not.toHaveBeenCalled();
  await graph.configure('off'); expect(graph.state.active).toBe('off'); graph.destroy();
});
it('a model load finishing after Off or destruction cannot reconnect strong processing', async () => {
  let finish!: (response: any) => void;
  vi.stubGlobal('document', { baseURI: 'https://fixture.invalid/' });
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
  const node = vi.fn(); vi.stubGlobal('AudioWorkletNode', node);
  const input = { connect: vi.fn(), disconnect: vi.fn() }, output = {}, context = { sampleRate: 48000, audioWorklet: { addModule: vi.fn(async () => {}) } };
  const graph = new StrongDenoiser(context as any, input as any, output as any);
  const loading = graph.configure('strong'); await graph.configure('off'); graph.destroy();
  finish({ ok: true, arrayBuffer: async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer }); await loading;
  expect(node).not.toHaveBeenCalled(); expect(graph.state.active).toBe('off');
});
