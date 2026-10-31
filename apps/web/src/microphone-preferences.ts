import { clampMicrophoneGain } from '../../../packages/media/src/microphone-gain';
export const microphoneGainChanged = 'dorham-microphone-gain';
const key = 'dorham.microphoneGain.v1';
const boostKey = 'dorham.microphoneBoost.v1';
export function readMicrophoneBoost() { try { return localStorage.getItem(boostKey) === 'true'; } catch { return false; } }
export function saveMicrophoneBoost(enabled: boolean) { try { localStorage.setItem(boostKey, String(enabled)); } catch { /* Current control still works. */ } }
export function readMicrophoneGain() {
  try { const saved = localStorage.getItem(key); return saved === null ? 1 : Math.min(readMicrophoneBoost() ? Infinity : 2.5, clampMicrophoneGain(Number(saved))); } catch { return 1; }
}
export function saveMicrophoneGain(value: number) {
  value = clampMicrophoneGain(value);
  try { localStorage.setItem(key, String(value)); } catch { /* Current controls still receive the live value. */ }
  window.dispatchEvent(new CustomEvent(microphoneGainChanged, { detail: value }));
}
