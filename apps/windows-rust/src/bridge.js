(() => {
  if (window !== window.top || location.origin !== 'https://localhost') return;
  const pending = new Map(), hotkeys = new Set(); let next = 0;
  const invoke = (method, args = null) => new Promise((resolve, reject) => {
    const id = ++next;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Native operation timed out')); }, method === 'installUpdate' ? 660000 : 30000);
    pending.set(id, { resolve, reject, timeout });
    window.ipc.postMessage(JSON.stringify({ id, method, args }));
  });
  Object.defineProperty(window, '__dorhamNativeResponse', { value: value => {
    const entry = pending.get(value.id); if (!entry) return;
    clearTimeout(entry.timeout); pending.delete(value.id);
    if (value.error) entry.reject(new Error(value.error)); else entry.resolve(value.result);
  }});
  Object.defineProperty(window, '__dorhamNativeHotkey', { value: value => { for (const callback of hotkeys) callback(value); }});
  Object.defineProperty(window, 'desktop', { value: Object.freeze({
    getServer: () => invoke('getServer'), setServer: value => invoke('setServer', value),
    getSecret: () => invoke('getSecret'), setSecret: value => invoke('setSecret', value),
    setLanguage: value => invoke('setLanguage', value),
    configureVoiceHotkey: value => invoke('configureVoiceHotkey', value),
    onVoiceHotkey: callback => { hotkeys.add(callback); return () => hotkeys.delete(callback); },
    getOverlay: () => invoke('getOverlay'), configureOverlay: value => invoke('configureOverlay', value),
    updateOverlay: value => { void invoke('updateOverlay', value).catch(() => {}); },
    setInCall: value => { void invoke('setInCall', value === true).catch(() => {}); },
    systemAudioSafe: false, getAppInfo: () => invoke('getAppInfo'),
    checkUpdate: () => invoke('checkUpdate'), installUpdate: () => invoke('installUpdate')
  }) });
  try {
    const storage = __DORHAM_MIGRATED_STORAGE__;
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
    if (Object.keys(storage).length) void invoke('storageMigrated').catch(() => {});
  } catch { /* Keep the protected pending export for a subsequent retry. */ }
})();
