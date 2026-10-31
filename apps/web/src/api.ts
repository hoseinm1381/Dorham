import { Capacitor, registerPlugin } from '@capacitor/core';
import { io, type Socket } from 'socket.io-client';
import instance from './instance.json';
declare global { interface Window { desktop?: { getServer(): Promise<string>; setServer(url: string): Promise<void>; getSecret(): Promise<string | null>; setSecret(secret: string | null): Promise<void>; setInCall(active: boolean): void; setLanguage?(value: string): Promise<void>; version?: string; getAppInfo?(): Promise<{version: string; platform: string}>; checkUpdate?(): Promise<{current: string; latest: string; available: boolean}>; installUpdate?(): Promise<{started: boolean}>; systemAudioSafe?: boolean; configureVoiceHotkey(value: import('../../../packages/contracts/src/voice-hotkeys').VoiceInputPreferences): Promise<{ supported: boolean }>; onVoiceHotkey(listener: (event: { type: 'down' | 'up' | 'release' | 'error'; message?: string; background?: boolean }) => void): () => void } } }
const store = registerPlugin<any>('DorhamSecrets');
const files = registerPlugin<any>('DorhamFiles');
export const native = Capacitor.isNativePlatform() || Boolean(window.desktop);
let base = '', csrf = '', access = '', accessExpires = 0, refreshPromise: Promise<boolean> | null = null;
export async function initialize() { const defaultServer = import.meta.env.VITE_DEFAULT_SERVER_URL || instance.defaultServerUrl; if (window.desktop) base = await window.desktop.getServer() || defaultServer; else if (native) base = localStorage.getItem('dorham.server') || defaultServer; }
export const serverUrl = () => base;
export async function setServer(value: string) { const url = new URL(value); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname))) throw new Error('Use HTTPS for your server address.'); if (base !== url.origin) { access = ''; csrf = ''; await setSecret(null); } base = url.origin; if (window.desktop) await window.desktop.setServer(base); else localStorage.setItem('dorham.server', base); }
export const assetUrl = (value: string | null) => value ? `${base}${value}` : undefined;
async function getSecret() { if (window.desktop) return window.desktop.getSecret(); if (native) return (await store.get()).value as string | null; return null; }
async function setSecret(value: string | null) { if (window.desktop) await window.desktop.setSecret(value); else if (native) await store.set({ value }); }
async function refreshSession(): Promise<boolean> {
  if (!native) return false;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const refreshToken = await getSecret(); if (!refreshToken) return false;
    const response = await fetch(`${base}/api/v1/auth/refresh`, { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken, requestId: crypto.randomUUID() }) });
    if (!response.ok) { if (response.status === 401 || response.status === 403) { await setSecret(null); return false; } throw new Error('The server is temporarily unavailable. Try again.'); }
    const data = await response.json(); access = data.accessToken; accessExpires = Date.now() + 15 * 60000; csrf = data.csrf; await setSecret(data.refreshToken); return true;
  })();
  try { return await refreshPromise; } finally { refreshPromise = null; }
}
let lastWebRenewal = 0, webCredentialGeneration = 0, webRenewal: Promise<void> | null = null;
export async function maintainSession() { if (native) { if (Date.now() >= accessExpires - 120000 && !await refreshSession()) throw new Error('Session expired. Sign in again.'); } else if (Date.now() - lastWebRenewal >= 12 * 3600000) { webRenewal ||= request('/auth/renew', {}).then(() => { lastWebRenewal = Date.now(); webCredentialGeneration++; }).finally(() => { webRenewal = null; }); await webRenewal; } }
export async function request<T = any>(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', retry = true, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  if (native && !base) throw new Error('Enter your server address to connect.');
  if (!native && route !== '/auth/renew' && webRenewal) await webRenewal;
  const credentialGeneration = webCredentialGeneration;
  const headers: Record<string, string> = { ...(access ? { Authorization: `Bearer ${access}` } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(native ? { 'X-Dorham-Native': '1' } : {}) };
  const payload = body && typeof body === 'object' && !(body instanceof FormData) ? { requestId: crypto.randomUUID(), ...body } : body;
  if (payload && !(payload instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (payload instanceof FormData) headers['X-Request-Id'] = crypto.randomUUID();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? (route.startsWith('/auth/') ? 30000 : method === 'GET' ? 15000 : 20000));
  let response: Response;
  try { response = await fetch(`${base}/api/v1${route}`, { method, credentials: 'include', headers, signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout, body: payload instanceof FormData ? payload : payload ? JSON.stringify(payload) : undefined }); }
  catch (e) { if (timeout.aborted) throw Object.assign(new Error('Connection timed out. Your message was not automatically resent.'), { code: 'TIMEOUT' }); throw e; }
  // Requests already in flight can carry the cookie retired by a renewal.
  // Retry only that race once, retaining the mutation's idempotency identifier.
  if (!native && response.status === 401 && retry && route !== '/auth/renew' && (webRenewal || credentialGeneration !== webCredentialGeneration)) {
    await webRenewal; return request<T>(route, payload, method, false, options);
  }
  if (response.status === 401 && retry && !route.startsWith('/auth/login') && !route.startsWith('/auth/register') && await refreshSession()) return request<T>(route, payload, method, false, options);
  const data = await response.json().catch(e => { if (timeout.aborted) throw Object.assign(new Error('Connection timed out. Your message was not automatically resent.'), { code: 'TIMEOUT' }); if (options.signal?.aborted) throw e; return { error: { message: 'The server returned an invalid response.' } }; });
  if (response.status === 401 && !['/auth/login', '/auth/register', '/auth/guest', '/auth/recover'].some(path => route.startsWith(path))) window.dispatchEvent(new Event('dorham-session-revoked'));
  if (!response.ok) { const error = new Error(data.error?.message || 'Request failed.'); Object.assign(error, { status: response.status, code: data.error?.code }); throw error; }
  if (data.csrf) csrf = data.csrf;
  if (data.accessToken) { access = data.accessToken; accessExpires = Date.now() + 15 * 60000; await setSecret(data.refreshToken); }
  return data;
}
export async function signOut() { try { await request('/auth/logout', {}); } catch (e: any) { if (e.status !== 401) throw e; } finally { access = ''; csrf = ''; await setSecret(null); if ('caches' in window) { for (const key of await caches.keys()) await caches.delete(key); } } }
export async function forgetSession() { access = ''; csrf = ''; await setSecret(null); }
export function connectSocket(): Socket { return io(base || window.location.origin, { withCredentials: true, auth: callback => callback({ token: access || undefined, csrf }), reconnectionDelay: 500, reconnectionDelayMax: 5000, transports: ['websocket', 'polling'], tryAllTransports: true }); }

export async function uploadAttachment(file: File, conversationId: string, signal?: AbortSignal) {
  const reserved = await request('/attachments', { name: file.name, size: file.size, conversationId });
  try {
    const deadline = AbortSignal.timeout(15 * 60000);
    const response = await fetch(`${base}/api/v1/attachments/${reserved.id}/content`, { method: 'POST', credentials: 'include', signal: signal ? AbortSignal.any([deadline, signal]) : deadline, headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf, ...(access ? { Authorization: `Bearer ${access}` } : {}) }, body: file });
    const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error?.message || 'File upload failed.'), { code: data.error?.code });
    return { id: reserved.id, name: file.name, size: file.size, expiresAt: reserved.expiresAt, available: true };
  } catch (e) { await request(`/attachments/${reserved.id}`, {}, 'DELETE').catch(() => {}); throw e; }
}
export async function downloadAttachment(id: string, name: string) {
  await maintainSession();
  if (Capacitor.getPlatform() === 'android') { await files.download({ url: `${base}/api/v1/attachments/${encodeURIComponent(id)}/download`, name, accessToken: access }); return; }
  const response = await fetch(`${base}/api/v1/attachments/${encodeURIComponent(id)}/download`, { credentials: 'include', headers: access ? { Authorization: `Bearer ${access}` } : {} });
  if (!response.ok) { const data = await response.json(); throw Object.assign(new Error(data.error?.message || 'File download failed.'), { code: data.error?.code }); }
  const blob = await response.blob(), url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
