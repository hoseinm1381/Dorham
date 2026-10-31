const key = 'dorham.voiceClarity.v1';
export const voiceClarityChanged = 'dorham-voice-clarity';
export function readVoiceClarity() { try { return localStorage.getItem(key) !== 'false'; } catch { return true; } }
export function saveVoiceClarity(enabled: boolean) {
  try { localStorage.setItem(key, String(enabled)); } catch { /* Keep the live choice. */ }
  window.dispatchEvent(new CustomEvent(voiceClarityChanged, { detail: enabled }));
}
