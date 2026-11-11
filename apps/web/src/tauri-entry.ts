import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { acknowledgeCaptureAudio, captureNativeVideo, onCaptureAudio, startCaptureAudio, stopCaptureAudio } from './tauri-capture';

function desktop<T>(method: string, value?: unknown) {
  return invoke<T>('desktop_command', { request: { method, value } });
}

function subscribe<T>(event: string, listener: (value: T) => void, initial?: () => Promise<T>) {
  let active = true;
  const subscription = listen<T>(event, ({ payload }) => { if (active) listener(payload); });
  if (initial) void subscription.then(initial).then(value => { if (active) listener(value); }).catch(console.error);
  return () => {
    active = false;
    void subscription.then(stop => stop()).catch(console.error);
  };
}

async function start() {
  const pending = await desktop<Record<string, string> | null>('getPendingStorage');
  if (pending) {
    for (const [key, value] of Object.entries(pending)) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    }
    await desktop<void>('finishMigration');
  }

  const bridge: NonNullable<Window['desktop']> = {
    getAppInfo: () => desktop('getAppInfo'),
    checkUpdate: () => invoke('update_check'),
    prepareUpdate: () => invoke('update_prepare'),
    installUpdate: () => invoke('update_install'),
    getUpdateState: () => desktop('getUpdateState'),
    onUpdateState: listener => subscribe('desktop-update-state', listener),
    getServer: () => desktop('getServer'),
    setServer: value => desktop('setServer', value),
    getSecret: () => desktop('getSecret'),
    setSecret: value => desktop('setSecret', value),
    getOverlay: () => desktop('getOverlay'),
    configureOverlay: value => desktop('configureOverlay', value),
    updateOverlay: value => { void desktop('updateOverlay', value).catch(console.error); },
    onOverlayPreferences: listener => subscribe('desktop-overlay-preferences', listener),
    onVisibility: listener => subscribe('desktop-visibility', listener, () => desktop('isVisible')),
    getCaptureCapabilities: () => desktop('getCaptureCapabilities'),
    captureNativeVideo,
    startCaptureAudio,
    stopCaptureAudio,
    acknowledgeCaptureAudio,
    onCaptureAudio,
    setInCall: value => { void desktop('setInCall', value).catch(console.error); },
    setLanguage: value => desktop('setLanguage', value),
    configureVoiceHotkey: value => desktop('configureVoiceHotkey', value),
    onVoiceHotkey: listener => subscribe('desktop-voice-hotkey', listener),
  };
  Object.defineProperty(window, 'desktop', { value: Object.freeze(bridge) });
  await import('./main');
}

void start().catch(() => {
  const root = document.getElementById('root');
  if (root) root.textContent = 'Dorham could not open the desktop profile. Close the app and retry. / دورهم نتوانست نمایه را باز کند. برنامه را ببندید و دوباره تلاش کنید.';
});
