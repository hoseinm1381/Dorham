import { useEffect, useId, useRef, useState } from 'react';
import { SlidersHorizontal, Volume2, VolumeX } from 'lucide-react';
import { t } from './i18n';
import cardSlide from './games/assets/card-slide.ogg?url';
import diceRoll from './games/assets/dice-roll.ogg?url';

export type GameCue = 'move' | 'roll' | 'card' | 'turn' | 'success' | 'finish' | 'clock' | 'miss' | 'capture' | 'deploy' | 'check' | 'promote';
const tones: Record<GameCue, number[]> = {
  move: [295], roll: [175, 275, 365], card: [330, 270], turn: [370, 494],
  success: [440, 554, 659], finish: [392, 494, 587, 784], clock: [349, 349], miss: [294, 247],
  capture: [330, 230], deploy: [349, 466, 523], check: [415, 349], promote: [392, 523, 659],
};
const preference = 'dorham.games.sound';
const volumePreference = 'dorham.games.volume';
let audio: AudioContext | undefined;
const samples: Partial<Record<GameCue, AudioBuffer>> = {};
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
  const [volume, setVolume] = useState(() => {
    try {
      const saved = localStorage.getItem(volumePreference);
      const value = saved === null ? 60 : Number(saved);
      return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 60;
    } catch { return 60; }
  });
  function changeVolume(value: number) {
    setVolume(value);
    try { localStorage.setItem(volumePreference, String(value)); } catch { /* Keep the session preference. */ }
  }
  function toggle() {
    const next = !enabled;
    setEnabled(next);
    try { localStorage.setItem(preference, next ? 'on' : 'off'); } catch { /* Session preference still works. */ }
    if (next && !silenced) void unlock();
  }
  function play(cue: GameCue) {
    if (!enabled || !volume || silenced || document.hidden || audio?.state !== 'running') return;
    const context = audio;
    const level = volume / 100;
    const sample = samples[cue];
    if (sample) {
      const source = context.createBufferSource(), gain = context.createGain();
      source.buffer = sample;
      gain.gain.value = 0.17 * level;
      source.connect(gain).connect(context.destination);
      source.start();
      return;
    }
    tones[cue].forEach((hz, i) => {
      const start = context.currentTime + i * 0.07;
      const oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.frequency.setValueAtTime(hz, start);
      gain.gain.setValueAtTime(0.001 * level, start);
      gain.gain.exponentialRampToValueAtTime(0.055 * level, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001 * level, start + 0.1);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.11);
    });
  }
  return { enabled, silenced, toggle, play, volume, changeVolume, unlock: () => { if (enabled && !silenced) void unlock(); } };
}

export type GameSound = ReturnType<typeof useGameSound>;

export function GameSoundButton({ sound }: { sound: GameSound }) {
  const Icon = sound.enabled ? Volume2 : VolumeX;
  return <button type="button" className="secondary game-sound-toggle" aria-label={t('Game sounds')} title={t('Game sounds')} aria-pressed={sound.enabled} onClick={sound.toggle}><Icon size={16} aria-hidden="true"/><span className="game-sound-label">{t('Game sounds')}</span></button>;
}

export function GameSoundSettings({ sound }: { sound: GameSound }) {
  const slider = useId();
  return <details className="game-sound-settings">
    <summary title={t('Game sound volume')} aria-label={t('Game sound volume')}><SlidersHorizontal size={16} aria-hidden="true"/></summary>
    <label htmlFor={slider}>{t('Game sound volume')}
      <input id={slider} type="range" min="0" max="100" step="5" value={sound.volume} onChange={event => sound.changeVolume(Number(event.target.value))}/>
    </label>
  </details>;
}

// The first snapshot on entering a game is history. Only play for changes observed while watching.
export function useGameCue(sound: GameSound, id?: string, event?: string, cue: GameCue = 'move') {
  const previous = useRef<{ id?: string; event?: string }>({});
  useEffect(() => {
    const last = previous.current;
    previous.current = { id, event };
    if (id && id === last.id && event !== undefined && last.event !== event) sound.play(cue);
  }, [id, event, cue, sound]);
}
