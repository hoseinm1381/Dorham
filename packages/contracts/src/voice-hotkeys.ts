import keys from './voice-keys.json';
export type VoiceInputMode = 'open' | 'push' | 'toggle';
export type VoiceBinding = { code: string; ctrl: boolean; alt: boolean; shift: boolean };
export type VoiceInputPreferences = { mode: VoiceInputMode; binding: VoiceBinding; background: boolean };
export const defaultVoiceInput: VoiceInputPreferences = { mode: 'open', binding: { code: 'KeyV', ctrl: true, alt: false, shift: true }, background: true };
export function validBinding(value: unknown): value is VoiceBinding {
  if (!value || typeof value !== 'object') return false; const b = value as VoiceBinding;
  return Object.hasOwn(keys, b.code) && ['ctrl', 'alt', 'shift'].every(k => typeof b[k as keyof VoiceBinding] === 'boolean') && !(b.alt && b.code === 'F4');
}
export function bindingLabel(b: VoiceBinding) { return [b.ctrl && 'Ctrl', b.alt && 'Alt', b.shift && 'Shift', b.code.replace(/^Key|^Digit/, '')].filter(Boolean).join(' + '); }
export function matchesBinding(b: VoiceBinding, event: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }) { return !event.metaKey && event.code === b.code && event.ctrlKey === b.ctrl && event.altKey === b.alt && event.shiftKey === b.shift; }
// Function keys and explicit command combinations do not type message content.
// Plain text/navigation bindings remain suppressed while composing a message.
export function allowedWhileTyping(b: VoiceBinding) { return /^F\d{1,2}$/.test(b.code) || b.ctrl || b.alt; }
export class VoiceInputState {
  mode: VoiceInputMode = 'open'; held = false; latched = false; locked = false;
  configure(mode: VoiceInputMode) { this.mode = mode; this.held = false; this.latched = false; this.locked = false; }
  down() { if (this.held) return; this.held = true; if (this.mode === 'push') this.locked = false; if (this.mode === 'toggle') this.latched = !this.latched; }
  up() { this.held = false; }
  release() { this.held = false; if (this.mode === 'toggle') this.latched = false; }
  // Ordinary focus changes release held keys, not an intentionally latched mic.
  blur() { this.up(); }
  manual() {
    if (this.mode === 'toggle') this.latched = !this.latched;
    else if (this.mode === 'push') { this.locked = !this.muted; this.held = false; }
    else this.locked = !this.locked;
  }
  get muted() { return this.mode === 'push' ? this.locked || !this.held : this.mode === 'toggle' ? !this.latched : this.locked; }
}
