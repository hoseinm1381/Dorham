import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';
import cardSlide from './games/assets/card-slide.ogg?url';
import diceRoll from './games/assets/dice-roll.ogg?url';

type Cue = 'move' | 'roll' | 'card' | 'turn' | 'success' | 'finish' | 'clock';
const tones: Record<Cue, number[]> = {
  move: [240], roll: [175, 275, 365], card: [330, 270], turn: [440, 590],
  success: [480, 610, 750], finish: [392, 494, 587], clock: [380, 380]
};
const preference = 'dorham.games.sound';
let audio: AudioContext | undefined;
const samples: Partial<Record<Cue, AudioBuffer>> = {};
let loadingSamples = false;

async function unlock() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') await audio.resume();
    if (!loadingSamples && audio.state === 'running') {
      loadingSamples = true;
      const context = audio;
      const urls = { card: cardSlide, roll: diceRoll } as const;
      void Promise.allSettled((Object.keys(urls) as (keyof typeof urls)[]).map(async cue => {
        const response = await fetch(urls[cue]);
        if (response.ok) samples[cue] = await context.decodeAudioData(await response.arrayBuffer());
      }));
    }
  } catch { /* Games remain playable without Web Audio. */ }
}

export function useGameSound(silenced: boolean) {
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem(preference) === 'on'; } catch { return false; }
  });
  function toggle() {
    const next = !enabled;
    setEnabled(next);
    try { localStorage.setItem(preference, next ? 'on' : 'off'); } catch { /* Session preference still works. */ }
    if (next && !silenced) void unlock();
  }
  function play(cue: Cue) {
    if (!enabled || silenced || document.hidden || audio?.state !== 'running') return;
    const context = audio;
    const sample = samples[cue];
    if (sample) {
      const source = context.createBufferSource(), gain = context.createGain();
      source.buffer = sample;
      gain.gain.value = 0.17;
      source.connect(gain).connect(context.destination);
      source.start();
      return;
    }
    tones[cue].forEach((hz, i) => {
      const start = context.currentTime + i * 0.07;
      const oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.frequency.setValueAtTime(hz, start);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.045, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.1);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.11);
    });
  }
  return { enabled, toggle, play, unlock: () => { if (enabled && !silenced) void unlock(); } };
}

export type GameSound = ReturnType<typeof useGameSound>;

export function GameSoundButton({ sound }: { sound: GameSound }) {
  return <button type="button" className="secondary game-sound-toggle" aria-label={t('Game sounds')} title={t('Game sounds')} aria-pressed={sound.enabled} onClick={sound.toggle}><span aria-hidden="true" className="game-sound-icon">{sound.enabled ? '🔊' : '🔇'}</span><span className="game-sound-label">{t('Game sounds')}</span></button>;
}

// The first snapshot on entering a game is history. Only play for changes observed while watching.
export function useGameCue(sound: GameSound, id?: string, event?: string, cue: Cue = 'move') {
  const previous = useRef<{ id?: string; event?: string }>({});
  useEffect(() => {
    const last = previous.current;
    previous.current = { id, event };
    if (id && id === last.id && event !== undefined && last.event !== event) sound.play(cue);
  }, [id, event, cue, sound]);
}
