// Local, synthesized cues: no external assets or requests. Audio is unlocked by a
// user gesture; browsers may deliberately suppress cues before that gesture.
export type Cue = 'message' | 'sent' | 'join' | 'leave' | 'mute' | 'unmute';
export type SoundPreferences = { messages: boolean; voice: boolean; volume: number };
const defaultVolume = 75;
let context: AudioContext | undefined, last = 0;
let onDemand = false, unlocked = false, idleClose: ReturnType<typeof setTimeout> | undefined;
export function enableOnDemandDesktopAudio() { onDemand = true; }
export function onDemandDesktopAudio() { return onDemand; }

function audioContext() {
  try { return context ||= new AudioContext(); } catch { return undefined; }
}

function closeAfterQuiet(audio: AudioContext) {
  if (!onDemand) return;
  clearTimeout(idleClose);
  idleClose = setTimeout(() => {
    if (context === audio) context = undefined;
    void audio.close().catch(() => {});
  }, 6000);
}
export function soundPreferences(): SoundPreferences {
  try {
    const value = JSON.parse(localStorage.getItem('dorham-sounds') || '{}');
    const volume = Number.isFinite(value.volume) ? Math.round(Math.max(0, Math.min(100, value.volume))) : defaultVolume;
    return { messages: value.messages !== false, voice: value.voice !== false, volume };
  } catch { return { messages: true, voice: true, volume: defaultVolume }; }
}
export function saveSoundPreferences(value: SoundPreferences) { try { localStorage.setItem('dorham-sounds', JSON.stringify(value)); } catch { /* session-only controls still work */ } }
export function unlockSounds() {
  unlocked = true;
  if (onDemand) return;
  const audio = audioContext();
  if (audio?.state === 'suspended') void audio.resume().catch(() => {});
}
export function playCue(kind: Cue, busy = false, preview = false) {
  const prefs = soundPreferences(); if (!prefs.volume || busy || (!preview && !(kind === 'message' || kind === 'sent' ? prefs.messages : prefs.voice))) return;
  const audio = context ?? (onDemand && unlocked ? audioContext() : undefined);
  if (!audio) return;
  closeAfterQuiet(audio);
  if (audio.state === 'suspended') {
    void audio.resume().then(() => { if (context === audio && audio.state === 'running') playCue(kind, busy, preview); }).catch(() => {});
    return;
  }
  if (audio.state !== 'running' || ((kind === 'message' || kind === 'sent') && performance.now() - last < 120)) return;
  last = performance.now();
  const peak = prefs.volume / 100 * (kind === 'mute' || kind === 'unmute' ? 0.48 : 0.42);
  const notes = kind === 'message' ? [660, 880] : kind === 'sent' ? [520] : kind === 'join' ? [440, 660] : kind === 'leave' ? [660, 440] : kind === 'mute' ? [520, 350] : [350, 520];
  try {
    notes.forEach((frequency, i) => {
      const start = audio.currentTime + i * 0.10, oscillator = audio.createOscillator(), gain = audio.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency; gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(peak, start + 0.01); gain.gain.exponentialRampToValueAtTime(peak / 85, start + 0.12);
      oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(start); oscillator.stop(start + 0.14); oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    });
    window.dispatchEvent(new CustomEvent('dorham-sound-played', { detail: kind }));
  } catch { /* Notifications must never break chat/calls. */ }
}
