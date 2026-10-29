// Local, synthesized cues: no external assets or requests. Audio is unlocked by a
// user gesture; browsers may deliberately suppress cues before that gesture.
export type Cue = 'message' | 'sent' | 'join' | 'leave';
export type SoundPreferences = { messages: boolean; voice: boolean };
let context: AudioContext | undefined, last = 0;
export function soundPreferences(): SoundPreferences {
  try { const value = JSON.parse(localStorage.getItem('dorham-sounds') || '{}'); return { messages: value.messages !== false, voice: value.voice !== false }; }
  catch { return { messages: true, voice: true }; }
}
export function saveSoundPreferences(value: SoundPreferences) { try { localStorage.setItem('dorham-sounds', JSON.stringify(value)); } catch { /* session-only controls still work */ } }
export function unlockSounds() {
  try { context ||= new AudioContext(); if (context.state === 'suspended') void context.resume().catch(() => {}); } catch { /* no audio device */ }
}
export function playCue(kind: Cue, busy = false) {
  const prefs = soundPreferences(); if (busy || !(kind === 'message' || kind === 'sent' ? prefs.messages : prefs.voice)) return;
  if (context?.state === 'suspended') { void context.resume().then(() => { if (context?.state === 'running') playCue(kind, busy); }).catch(() => {}); return; }
  if (!context || context.state !== 'running' || ((kind === 'message' || kind === 'sent') && performance.now() - last < 120)) return;
  last = performance.now();
  const notes = kind === 'message' ? [660, 880] : kind === 'sent' ? [520] : kind === 'join' ? [440, 660] : [660, 440];
  try {
    notes.forEach((frequency, i) => {
      const start = context!.currentTime + i * 0.10, oscillator = context!.createOscillator(), gain = context!.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency; gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.085, start + 0.01); gain.gain.exponentialRampToValueAtTime(0.001, start + 0.12);
      oscillator.connect(gain); gain.connect(context!.destination); oscillator.start(start); oscillator.stop(start + 0.14); oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    });
    window.dispatchEvent(new CustomEvent('dorham-sound-played', { detail: kind }));
  } catch { /* Notifications must never break chat/calls. */ }
}
