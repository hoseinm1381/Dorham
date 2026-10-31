import { expect, it } from 'vitest';
import { updateAudio } from '../apps/web/src/audio-updates';
it('keeps a later settings change after a slow model load, including when the first operation fails', async () => {
  let finish!: () => void;
  const events: string[] = [];
  const first = updateAudio(null, async () => { events.push('loading'); await new Promise<void>(resolve => { finish = resolve; }); events.push('strong'); throw Error('model failed'); });
  const rejected = first.catch(() => {});
  const second = updateAudio(null, async () => { events.push('off'); });
  await Promise.resolve(); await Promise.resolve(); expect(events).toEqual(['loading']);
  finish(); await rejected; await second; expect(events).toEqual(['loading', 'strong', 'off']);
});
