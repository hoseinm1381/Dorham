import { useEffect, useRef, useState, type RefObject } from 'react';
import { allowedWhileTyping, bindingLabel, defaultVoiceInput, matchesBinding, validBinding, VoiceInputState, type VoiceInputPreferences } from '../../../packages/contracts/src/voice-hotkeys';
import type { MediaTransport } from '@dorham/media';
import { t } from './i18n';

export function readVoiceInput(): VoiceInputPreferences {
  try { const value = JSON.parse(localStorage.getItem('dorham-voice-input') || 'null'); if (value && ['open', 'push', 'toggle'].includes(value.mode) && validBinding(value.binding) && typeof value.background === 'boolean') return value; } catch { /* device defaults */ }
  return defaultVoiceInput;
}
function blocked(binding: VoiceInputPreferences['binding']) { const el = document.activeElement as HTMLElement | null; return Boolean(el?.closest('[data-hotkey-capture]') || ((el?.isContentEditable || el?.closest('input,textarea,select,[role=textbox]')) && !allowedWhileTyping(binding))); }

export function useVoiceInput(transport: RefObject<MediaTransport | null>, active: boolean, error: (e: Error) => void, notice: (message: string) => void = () => {}) {
  const state = useRef(new VoiceInputState()), prefs = useRef(readVoiceInput()), activeRef = useRef(active), onError = useRef(error), task = useRef<Promise<void> | null>(null), dirty = useRef(false), fault = useRef(false);
  const [muted, setMuted] = useState(() => prefs.current.mode !== 'open'), [locked, setLocked] = useState(false), [preferences, setPreferences] = useState(prefs.current);
  const initialized = useRef(false); if (!initialized.current) { state.current.configure(prefs.current.mode); initialized.current = true; }
  activeRef.current = active; onError.current = error;
  const onNotice = useRef(notice); onNotice.current = notice;
  const apply = () => {
    setMuted(state.current.muted); setLocked(state.current.locked); dirty.current = true;
    // Invoke mute immediately so release never waits behind a signaling roundtrip.
    if (state.current.muted) void transport.current?.setMuted(true).catch(e => onError.current(e));
    if (!task.current) task.current = Promise.resolve().then(async () => {
      do { dirty.current = false; await transport.current?.setMuted(state.current.muted); } while (dirty.current);
    }).catch(e => { state.current.release(); if (prefs.current.mode === 'open') state.current.locked = true; setMuted(true); void transport.current?.setMuted(true).catch(() => {}); onError.current(e); }).finally(() => { task.current = null; });
  };
  const applyRef = useRef(apply); applyRef.current = apply;
  useEffect(() => {
    const changed = () => { prefs.current = readVoiceInput(); state.current.configure(prefs.current.mode); fault.current = false; setPreferences(prefs.current); applyRef.current(); void window.desktop?.configureVoiceHotkey(prefs.current).catch(e => onError.current(e)); };
    const native = window.desktop?.onVoiceHotkey(event => {
      if (event.type === 'error') { fault.current = true; state.current.release(); applyRef.current(); onError.current(new Error(event.message)); return; }
      if (event.type === 'release') state.current.release();
      else if (event.type === 'up') state.current.up();
      else if (activeRef.current && !fault.current && ((event.background ?? !document.hasFocus()) || !blocked(prefs.current.binding))) state.current.down();
      applyRef.current();
    });
    const down = (e: KeyboardEvent) => {
      if (!activeRef.current || prefs.current.mode === 'open' || (window.desktop && prefs.current.background) || e.repeat || blocked(prefs.current.binding) || !matchesBinding(prefs.current.binding, e)) return;
      e.preventDefault(); state.current.down(); applyRef.current();
    };
    const up = (e: KeyboardEvent) => { if (window.desktop && prefs.current.background) return; if (e.code === prefs.current.binding.code || ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) { state.current.up(); applyRef.current(); } };
    const release = () => { if (!window.desktop || !prefs.current.background) { state.current.blur(); applyRef.current(); } };
    const visible = () => { if (document.hidden) release(); };
    window.addEventListener('dorham-voice-input-changed', changed); window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', release); document.addEventListener('visibilitychange', visible);
    void window.desktop?.configureVoiceHotkey(prefs.current).catch(e => onError.current(e));
    return () => { native?.(); window.removeEventListener('dorham-voice-input-changed', changed); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', visible); };
  }, []);
  useEffect(() => { if (!active) { state.current.release(); applyRef.current(); } }, [active]);
  return { muted, locked, preferences, prepare: async () => { state.current.release(); setMuted(state.current.muted); await transport.current?.setMuted(state.current.muted); }, toggle: () => { state.current.manual(); applyRef.current(); if (prefs.current.mode === 'push' && state.current.muted) onNotice.current(t('Hold {key} to talk. Pressing the talk key also clears manual mute.', { key: bindingLabel(prefs.current.binding) })); } };
}

export function VoiceInputSettings() {
  const [prefs, setPrefs] = useState(readVoiceInput), [recording, setRecording] = useState(false), [notice, setNotice] = useState('');
  const save = (value: VoiceInputPreferences) => { setPrefs(value); try { localStorage.setItem('dorham-voice-input', JSON.stringify(value)); } catch { setNotice('Device storage is unavailable.'); } window.dispatchEvent(new Event('dorham-voice-input-changed')); };
  useEffect(() => { if (!recording) return; const record = (e: KeyboardEvent) => { e.preventDefault(); e.stopImmediatePropagation(); if (e.key === 'Escape') { setRecording(false); return; } const binding = { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey }; if (!e.metaKey && validBinding(binding)) { save({ ...prefs, binding }); setRecording(false); setNotice(''); } else setNotice('Choose a letter, number, function key, Space or navigation key.'); }; window.addEventListener('keydown', record, true); return () => window.removeEventListener('keydown', record, true); }, [recording, prefs]);
  return <section className="voice-input-settings"><h3>{t('Voice input & hotkeys')}</h3><label>{t('Input mode')}<select aria-label={t("Voice input mode")} value={prefs.mode} onChange={e => save({ ...prefs, mode: e.target.value as VoiceInputPreferences['mode'] })}><option value="open">{t('Open microphone')}</option><option value="push">{t('Push to talk')}</option><option value="toggle">{t('Toggle to talk')}</option></select></label>{prefs.mode !== 'open' && <><label>{t('Talk key')}<button type="button" className="secondary" data-hotkey-capture aria-label={t("Record talk hotkey")} onClick={() => setRecording(true)} onBlur={() => setRecording(false)}>{recording ? t('Press a key combination · Esc to cancel') : bindingLabel(prefs.binding)}</button></label>{window.desktop && <label className="check-row"><input type="checkbox" checked={prefs.background} onChange={e => save({ ...prefs, background: e.target.checked })}/>{t('Work while using games and other apps')}</label>}<p>{t(window.desktop && prefs.background ? 'Windows background talk keys work in other apps and the tray. Toggle-to-talk stays on when switching apps. Lock, sleep or helper failure mutes the microphone.' : 'Push-to-talk releases when this page loses focus. Toggle-to-talk stays on until toggled off or you leave the call. Function keys work while typing; letter keys do not. Website hotkeys cannot be pressed from other apps.')}</p></>}{notice && <p role="status">{t(notice)}</p>}</section>;
}
