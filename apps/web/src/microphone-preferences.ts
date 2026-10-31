import { clampMicrophoneGain } from '../../../packages/media/src/microphone-gain';
export const microphoneGainChanged = 'dorham-microphone-gain';
const key = 'dorham.microphoneGain.v1';
const boostKey = 'dorham.microphoneBoost.v1';
export const boostNoiseChanged = 'dorham-boost-noise';
export function readBoostNoise(): { enabled: boolean; threshold: number } {
  try { const value = JSON.parse(localStorage.getItem('dorham.boostNoise.v1') || '{}'); return { enabled: value.enabled !== false, threshold: Number.isFinite(value.threshold) ? Math.max(-90, Math.min(-40, value.threshold)) : -70 }; } catch { return { enabled: true, threshold: -70 }; }
}
export function saveBoostNoise(value: { enabled: boolean; threshold: number }) {
  try { localStorage.setItem('dorham.boostNoise.v1', JSON.stringify(value)); } catch { /* In-memory graph still changes. */ }
  window.dispatchEvent(new CustomEvent(boostNoiseChanged, { detail: value }));
}
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
