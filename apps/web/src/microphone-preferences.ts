import { clampMicrophoneGain } from '../../../packages/media/src/microphone-gain';
export const microphoneGainChanged = 'dorham-microphone-gain';
const key = 'dorham.microphoneGain.v1';
export function readMicrophoneGain() {
  try { const saved = localStorage.getItem(key); return saved === null ? 1 : clampMicrophoneGain(Number(saved)); } catch { return 1; }
}
export function saveMicrophoneGain(value: number) {
  value = clampMicrophoneGain(value);
  try { localStorage.setItem(key, String(value)); } catch { /* Current controls still receive the live value. */ }
  window.dispatchEvent(new CustomEvent(microphoneGainChanged, { detail: value }));
}
