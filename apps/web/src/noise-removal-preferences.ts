import type { NoiseRemoval } from '@dorham/media';
export const noiseRemovalChanged = 'dorham-noise-removal';
export function readNoiseRemoval(): NoiseRemoval {
  try {
    const saved = localStorage.getItem('dorham.noiseRemoval.v1');
    if (saved === 'off' || saved === 'standard' || saved === 'strong') return saved;
    return JSON.parse(localStorage.getItem('dorham.audioProcessing.v1') || '{}').noiseSuppression === false ? 'off' : 'standard';
  } catch { return 'standard'; }
}
export function saveNoiseRemoval(mode: NoiseRemoval) {
  try { localStorage.setItem('dorham.noiseRemoval.v1', mode); } catch { /* Live setting remains usable. */ }
  window.dispatchEvent(new CustomEvent(noiseRemovalChanged, { detail: mode }));
}
