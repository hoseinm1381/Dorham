import { Capacitor, registerPlugin } from '@capacitor/core';
import { io, type Socket } from 'socket.io-client';
import instance from './instance.json';
import { installNativeVisibility } from './native-visibility';
import { setDesktopCaptureCapabilities } from '../../../packages/media/src/screen-capture';
import { pauseBulkRequest, waitForBulkTransfer } from '../../../packages/media/src/network-pressure';
import { localMediaBytes, readLocal, removeLocal, saveMedia, savePartialMedia, saveUpload, storageScope, storageSettings } from './offline-storage';
import { prepareBrowserDownload, writeBrowserDownload } from './download-folder';
declare global { interface Window { desktop?: { getDownloadFolder?(): Promise<string | null>; chooseDownloadFolder?(): Promise<string | null>; resetDownloadFolder?(): Promise<void>; onOverlayPreferences?(listener: (preferences: import('./WindowsVoiceOverlay').OverlayPreferences) => void): () => void; onVisibility?(listener: (visible: boolean) => void): () => void; getOverlay?(): Promise<import('./WindowsVoiceOverlay').OverlayPreferences>; configureOverlay?(value: import('./WindowsVoiceOverlay').OverlayPreferences): Promise<import('./WindowsVoiceOverlay').OverlayPreferences>; updateOverlay?(value: import('./WindowsVoiceOverlay').OverlayState): void; getServer(): Promise<string>; setServer(url: string): Promise<void>; getSecret(): Promise<string | null>; setSecret(secret: string | null): Promise<void>; setInCall(active: boolean): void; setLanguage?(value: string): Promise<void>; version?: string; getAppInfo?(): Promise<{version: string; platform: string}>; checkUpdate?(): Promise<{current: string; latest: string; available: boolean}>; installUpdate?(): Promise<{started: boolean}>; getUpdateState?(): Promise<import('./ReleaseProvider').WindowsUpdateState>; onUpdateState?(listener: (state: import('./ReleaseProvider').WindowsUpdateState) => void): () => void; prepareUpdate?(): Promise<void>; getCaptureCapabilities?(): Promise<{ sharedAudio: boolean }>; captureNativeVideo?(settings: import('../../../packages/media/src/screen-capture').ScreenCaptureSettings, audio: boolean): Promise<import('../../../packages/media/src/screen-capture').NativeVideo>; getCaptureSelection?(): Promise<{ sourceName: string; audioScope: 'none' | 'application' | 'system' } | null>; startCaptureAudio?(): Promise<{ id: string; sourceName: string; audioScope: 'application' | 'system' }>; stopCaptureAudio?(id: string): void; acknowledgeCaptureAudio?(id: string): void; onCaptureAudio?(listener: (packet: { id: string; pcm?: Uint8Array; error?: string }) => void): () => void; systemAudioSafe?: boolean; configureVoiceHotkey(value: import('../../../packages/contracts/src/voice-hotkeys').VoiceInputPreferences): Promise<{ supported: boolean }>; onVoiceHotkey(listener: (event: { type: 'down' | 'up' | 'release' | 'error' | 'ready'; message?: string; background?: boolean }) => void): () => void } } }
const store = registerPlugin<any>('DorhamSecrets');
const files = registerPlugin<any>('DorhamFiles');
export const native = Capacitor.isNativePlatform() || (typeof window !== 'undefined' && Boolean(window.desktop));
let base = '', csrf = '', access = '', accessExpires = 0, refreshPromise: Promise<boolean> | null = null;
let webSessionUserId: string | null = null;
let webProofPromise: Promise<{ csrf: string; user: { id: string } }> | null = null;
let nativeSessionGeneration = 0;
export async function initialize() { const defaultServer = import.meta.env.VITE_DEFAULT_SERVER_URL || instance.defaultServerUrl; if (window.desktop) { installNativeVisibility(); base = await window.desktop.getServer() || defaultServer; if (window.desktop.getCaptureCapabilities) setDesktopCaptureCapabilities(await window.desktop.getCaptureCapabilities()); } else if (native) base = localStorage.getItem('dorham.server') || defaultServer; }
export const serverUrl = () => base;
export async function setServer(value: string) { const url = new URL(value); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname))) throw new Error('Use HTTPS for your server address.'); if (base !== url.origin) { access = ''; csrf = ''; webSessionUserId = null; await setSecret(null); } base = url.origin; if (window.desktop) await window.desktop.setServer(base); else localStorage.setItem('dorham.server', base); }
export const assetUrl = (value: string | null) => value ? `${base}${value}` : undefined;
async function getSecret() { if (window.desktop) return window.desktop.getSecret(); if (native) return (await store.get()).value as string | null; return null; }
async function setSecret(value: string | null) { if (!value) nativeSessionGeneration++; if (window.desktop) await window.desktop.setSecret(value); else if (native) await store.set({ value }); }
type NativeCredential = { token: string; rotation?: { id: string; proof: string } };
function credential(raw: string): NativeCredential {
  if (!raw.startsWith('{')) return { token: raw };
  try { const parsed = JSON.parse(raw); return typeof parsed.token === 'string' ? parsed : { token: '' }; }
  catch { return { token: '' }; }
}
function newRotation() {
  const proof = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { id: crypto.randomUUID(), proof };
}
async function refreshSession(): Promise<boolean> {
  if (!native) return false;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const generation = nativeSessionGeneration, origin = base;
    const stored = await getSecret(); if (!stored || generation !== nativeSessionGeneration || origin !== base) return false;
    const { token: refreshToken, rotation: saved } = credential(stored); if (!refreshToken) return false;
    const rotation = saved || newRotation();
    if (!saved) await setSecret(JSON.stringify({ token: refreshToken, rotation }));
    const send = (path: string, body: object) => fetch(`${origin}/api/v1/auth/${path}`, { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let response = await send('refresh-safe', { refreshToken, requestId: rotation.id, retryProof: rotation.proof });
    if (generation !== nativeSessionGeneration || origin !== base) return false;
    if (response.status === 404 || response.status === 405) response = await send('refresh', { refreshToken, requestId: rotation.id });
    if (generation !== nativeSessionGeneration || origin !== base) return false;
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      if (response.status === 401 && data?.error?.code === 'REFRESH_INVALID') {
        if (generation !== nativeSessionGeneration || origin !== base) return false;
        await forgetSession();
        window.dispatchEvent(new Event('dorham-session-revoked'));
        return false;
      }
      throw new Error('The server is temporarily unavailable. Try again.');
    }
    const data = await response.json(); if (generation !== nativeSessionGeneration || origin !== base) return false;
    await setSecret(data.refreshToken); access = data.accessToken; accessExpires = Date.now() + 15 * 60000; csrf = data.csrf; return true;
  })();
  try { return await refreshPromise; } finally { refreshPromise = null; }
}
let lastWebRenewal = 0, webCredentialGeneration = 0, webRenewal: Promise<void> | null = null;
// Browser tabs share the HttpOnly session cookie, but keep their proof in memory.
// Recover only for the same account; never resend an action as a different user.
async function synchronizeWebProof(expectedUser: string) {
  webProofPromise ||= (async () => {
    const response = await fetch(`${base}/api/v1/auth/me`, { credentials: 'include', signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok || !data.csrf || !data.user?.id) throw Object.assign(new Error(data.error?.message || 'Session expired. Sign in again.'), { status: response.status, code: data.error?.code });
    return data as { csrf: string; user: { id: string } };
  })().finally(() => { webProofPromise = null; });
  const proof = await webProofPromise;
  if (proof.user.id !== expectedUser || webSessionUserId !== expectedUser) {
    if (webSessionUserId === expectedUser) window.dispatchEvent(new Event('dorham-session-revoked'));
    throw Object.assign(new Error('Your account changed in another tab. Reload Dorham to continue.'), { code: 'SESSION_CHANGED' });
  }
  csrf = proof.csrf;
  webCredentialGeneration++;
}
export async function maintainSession() { if (native) { if (Date.now() >= accessExpires - 120000 && !await refreshSession()) throw new Error('Session expired. Sign in again.'); } else if (Date.now() - lastWebRenewal >= 12 * 3600000) { webRenewal ||= request('/auth/renew', {}).then(() => { lastWebRenewal = Date.now(); webCredentialGeneration++; }).finally(() => { webRenewal = null; }); await webRenewal; } }
export async function request<T = any>(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', retry = true, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  if (native && !base) throw new Error('Enter your server address to connect.');
  if (!native && route !== '/auth/renew' && webRenewal) await webRenewal;
  const credentialGeneration = webCredentialGeneration;
  const sentAccess = access;
  const headers: Record<string, string> = { ...(access ? { Authorization: `Bearer ${access}` } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(native ? { 'X-Dorham-Native': '1' } : {}) };
  const raw = body instanceof Blob;
  const payload = !raw && body && typeof body === 'object' && !(body instanceof FormData) ? { requestId: crypto.randomUUID(), ...body } : body;
  if (raw) headers['Content-Type'] = 'application/octet-stream';
  else if (payload && !(payload instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (payload instanceof FormData) headers['X-Request-Id'] = crypto.randomUUID();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? (route.startsWith('/auth/') ? 30000 : method === 'GET' ? 15000 : 20000));
  let response: Response;
  try { response = await fetch(`${base}/api/v1${route}`, { method, credentials: 'include', headers, signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout, body: payload instanceof FormData || payload instanceof Blob ? payload : payload ? JSON.stringify(payload) : undefined }); }
  catch (e) { if (timeout.aborted) throw Object.assign(new Error('Connection timed out. Please try again.'), { code: 'TIMEOUT' }); throw e; }
  // Requests already in flight can carry the cookie retired by a renewal.
  // Retry only that race once, retaining the mutation's idempotency identifier.
  if (!native && response.status === 401 && retry && route !== '/auth/renew' && (webRenewal || credentialGeneration !== webCredentialGeneration)) {
    await webRenewal; return request<T>(route, payload, method, false, options);
  }
  const data = await response.json().catch(e => { if (timeout.aborted) throw Object.assign(new Error('Connection timed out. Your message was not automatically resent.'), { code: 'TIMEOUT' }); if (options.signal?.aborted) throw e; return { error: { message: 'The server returned an invalid response.' } }; });
  const identityRejected = response.status === 401 && data.error?.code === 'UNAUTHENTICATED';
  if (native && identityRejected && retry && !/^\/auth\/(login|register|guest|recover|logout)(\/|$)/.test(route) &&
      ((access && access !== sentAccess) || await refreshSession())) {
    options.signal?.throwIfAborted();
    return request<T>(route, payload, method, false, options);
  }
  if (!native && response.status === 403 && data.error?.code === 'CSRF' && retry && webSessionUserId) {
    await synchronizeWebProof(webSessionUserId);
    if (options.signal?.aborted) throw options.signal.reason;
    return request<T>(route, payload, method, false, options);
  }
  if (!native && identityRejected && route === '/auth/me' && credentialGeneration === webCredentialGeneration)
    window.dispatchEvent(new Event('dorham-session-revoked'));
  if (!response.ok) { const error = new Error(data.error?.message || 'Request failed.'); Object.assign(error, { status: response.status, code: data.error?.code }); throw error; }
  if (data.csrf) { csrf = data.csrf; if (!native && data.user?.id) webSessionUserId = data.user.id; }
  if (data.accessToken) { access = data.accessToken; accessExpires = Date.now() + 15 * 60000; await setSecret(data.refreshToken); }
  return data;
}
export async function signOut() { try { await request('/auth/logout', {}); } catch (e: any) { if (e.status !== 401) throw e; } finally { access = ''; csrf = ''; webSessionUserId = null; await setSecret(null); if ('caches' in window) { for (const key of await caches.keys()) await caches.delete(key); } } }
export async function forgetSession() { access = ''; csrf = ''; webSessionUserId = null; await setSecret(null); }
export function connectSocket(): Socket {
  return io(base || window.location.origin, {
    withCredentials: true,
    auth: callback => {
      if (native) {
        void maintainSession().then(() => callback({ token: access || undefined, csrf }), () => callback({}));
      } else if (!webSessionUserId) callback({ csrf });
      else void synchronizeWebProof(webSessionUserId).then(() => callback({ csrf })).catch(() => callback({ csrf: '' }));
    },
    reconnectionDelay: 500, reconnectionDelayMax: 5000, transports: ['websocket', 'polling'], tryAllTransports: true,
  });
}

export type UploadDraft = { file: File; requestId: string; reserved?: { id: string; state: string; expiresAt: number; resumable?: boolean } };

export async function cancelAttachmentUpload(conversationId: string, draft: UploadDraft) {
  if (draft.reserved) await request(`/attachments/${draft.reserved.id}`, {}, 'DELETE');
  await removeLocal(storageScope(), 'upload', conversationId).catch(() => {});
}

export async function uploadAttachment(file: File, conversationId: string, signal?: AbortSignal, onProgress?: (bytes: number) => void, saved?: UploadDraft) {
  const scope = storageScope(), draft = saved || { file, requestId: crypto.randomUUID() };
  await saveUpload(scope, conversationId, draft).catch(() => {});
  const reserved = draft.reserved ||= await request('/attachments', { name: file.name, size: file.size, conversationId, requestId: draft.requestId, resumable: true }, 'POST', true, { signal });
  await saveUpload(scope, conversationId, draft).catch(() => {});
  const finished = async () => {
    await removeLocal(scope, 'upload', conversationId).catch(() => {});
    return { id: reserved.id, name: file.name, size: file.size, expiresAt: reserved.expiresAt, available: true };
  };
  if (reserved.resumable) {
    const route = `/attachments/${reserved.id}`;
    let progress = await request<{ offset: number; state: string }>(`${route}/transfer`, undefined, 'GET', true, { signal });
    onProgress?.(progress.offset);
    let retries = 0;
    while (progress.state !== 'ready') {
      signal?.throwIfAborted();
      await waitForBulkTransfer(signal);
      if (storageScope() !== scope) throw new Error('Your account changed. Reopen the upload to continue.');
      if (!Number.isSafeInteger(progress.offset) || progress.offset < 0 || progress.offset > file.size) throw new Error('The server returned an invalid upload position.');
      const end = Math.min(progress.offset + 128 * 1024, file.size);
      const bandwidth = pauseBulkRequest(signal);
      try {
        progress = await request(`${route}/content?offset=${progress.offset}`, file.slice(progress.offset, end), 'PATCH', true, { signal: bandwidth.signal, timeoutMs: 90000 });
        retries = 0;
        onProgress?.(progress.offset);
      } catch (cause: any) {
        if (signal?.aborted || cause.status && cause.status < 500 && ![408, 409, 429].includes(cause.status) && cause.code !== 'UPLOAD_INTERRUPTED' || retries++ >= 2) throw cause;
        await new Promise(resolve => setTimeout(resolve, retries * 900));
        signal?.throwIfAborted();
        progress = await request(`${route}/transfer`, undefined, 'GET', true, { signal });
      } finally { bandwidth.release(); }
    }
    return finished();
  }
  try {
    const deadline = AbortSignal.timeout(15 * 60000);
    const response = await fetch(`${base}/api/v1/attachments/${reserved.id}/content`, { method: 'POST', credentials: 'include', signal: signal ? AbortSignal.any([deadline, signal]) : deadline, headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf, ...(access ? { Authorization: `Bearer ${access}` } : {}) }, body: file });
    const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error?.message || 'File upload failed.'), { code: data.error?.code });
    return finished();
  } catch (e) { await request(`/attachments/${reserved.id}`, {}, 'DELETE').catch(() => {}); await removeLocal(scope, 'upload', conversationId).catch(() => {}); throw e; }
}
export async function downloadAttachment(id: string, name: string, conversation?: string, onProgress?: (fraction: number) => void, signal?: AbortSignal) {
  const scope = storageScope(), mediaKey = `full:${id}`;
  const folder = await prepareBrowserDownload();
  let blob = await readLocal<Blob>(scope, 'media', mediaKey);
  if (!blob) {
    await waitForBulkTransfer(signal);
    const bandwidth = pauseBulkRequest(signal);
    signal = bandwidth.signal;
    try {
    if (Capacitor.getPlatform() === 'android') {
      try { await maintainSession(); } catch (cause) { if (navigator.onLine !== false) throw cause; }
      if (scope !== storageScope()) return;
      const listener = await files.addListener('download', (state: { active: boolean; progress: number }) => { if (state.active) onProgress?.(state.progress / 100); });
      const pause = () => { void files.cancel().catch(() => {}); };
      signal?.addEventListener('abort', pause, { once: true });
      try {
        const limit = Math.max(0, storageSettings(scope).limit * 1024 * 1024 - await localMediaBytes(scope).catch(() => 0));
        signal?.throwIfAborted();
        await files.download({ url: `${base}/api/v1/attachments/${encodeURIComponent(id)}/download`, name, accessToken: access, scope, limit });
      } finally { signal?.removeEventListener('abort', pause); await listener.remove(); }
      return;
    }
    await maintainSession();
    const partialKey = `partial:${id}`;
    let partial = await readLocal<{ blob: Blob; etag: string }>(scope, 'media', partialKey);
    const headers: Record<string, string> = access ? { Authorization: `Bearer ${access}` } : {};
    if (partial?.blob.size && partial.etag) { headers.Range = `bytes=${partial.blob.size}-`; headers['If-Range'] = partial.etag; }
    const response = await fetch(`${base}/api/v1/attachments/${encodeURIComponent(id)}/download`, { credentials: 'include', headers, signal });
    if (!response.ok) {
      if ([403, 404, 410, 416].includes(response.status)) await removeLocal(scope, 'media', partialKey).catch(() => {});
      const data = await response.json().catch(() => ({})); throw Object.assign(new Error(data.error?.message || 'File download failed.'), { status: response.status, code: data.error?.code });
    }
    const etag = response.headers.get('ETag') || '';
    if (response.status !== 206) partial = undefined;
    if (response.status === 206 && (!partial || !response.headers.get('Content-Range')?.startsWith(`bytes ${partial.blob.size}-`) || etag !== partial.etag)) throw new Error('The server returned an invalid download position.');
    const pieces: BlobPart[] = partial ? [partial.blob] : [];
    let received = partial?.blob.size || 0;
    const total = received + Number(response.headers.get('Content-Length') || 0);
    const reader = response.body?.getReader();
    try {
      if (!reader) blob = await response.blob();
      else {
        for (;;) {
          const piece = await reader.read();
          if (piece.done) break;
          pieces.push(new Uint8Array(piece.value)); received += piece.value.byteLength;
          if (total) onProgress?.(received / total);
        }
        if (total && received !== total) throw new Error('Download paused. Select Download to resume.');
        blob = new Blob(pieces);
      }
    } catch (cause) {
      if (etag && received && storageScope() === scope) await savePartialMedia(scope, partialKey, new Blob(pieces), etag, conversation).catch(() => {});
      throw cause;
    } finally { reader?.releaseLock(); }
    await removeLocal(scope, 'media', partialKey).catch(() => {});
    if (storageScope() === scope) await saveMedia(scope, mediaKey, blob, conversation, /\.(jpg|jpeg|png|gif|webp)$/i.test(name) ? 'image' : /\.(mp4|webm)$/i.test(name) ? 'video' : 'file').catch(() => {});
    } finally { bandwidth.release(); }
  }
  if (scope !== storageScope()) return;
  signal?.throwIfAborted();
  if (folder) { await writeBrowserDownload(folder, name, blob, signal); return; }
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function speechAudio(id: string) {
  await maintainSession();
  const response = await fetch(`${base}/api/v1/voice/tts/${encodeURIComponent(id)}/audio`, { credentials: 'include', headers: access ? { Authorization: `Bearer ${access}` } : {}, cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error('Speech audio is unavailable.');
  return response.arrayBuffer();
}
