import { Capacitor, registerPlugin } from '@capacitor/core';
import { io, type Socket } from 'socket.io-client';
declare global { interface Window { desktop?: { getServer(): Promise<string>; setServer(url: string): Promise<void>; getSecret(): Promise<string | null>; setSecret(secret: string | null): Promise<void>; setInCall(active: boolean): void; version: string } } }
const store = registerPlugin<any>('DorhamSecrets');
export const native = Capacitor.isNativePlatform() || Boolean(window.desktop);
let base = '', csrf = '', access = '', accessExpires = 0, refreshPromise: Promise<boolean> | null = null;
export async function initialize() { if (window.desktop) base = await window.desktop.getServer(); else if (native) base = localStorage.getItem('dorham.server') || ''; }
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
    const response = await fetch(`${base}/api/v1/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken, requestId: crypto.randomUUID() }) });
    if (!response.ok) { await setSecret(null); return false; }
    const data = await response.json(); access = data.accessToken; accessExpires = Date.now() + 15 * 60000; csrf = data.csrf; await setSecret(data.refreshToken); return true;
  })();
  try { return await refreshPromise; } finally { refreshPromise = null; }
}
export async function maintainSession() { if (native && Date.now() >= accessExpires - 120000 && !await refreshSession()) throw new Error('Session expired. Sign in again.'); }
export async function request<T = any>(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', retry = true): Promise<T> {
  if (native && !base) throw new Error('Enter your server address to connect.');
  const headers: Record<string, string> = { ...(access ? { Authorization: `Bearer ${access}` } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(native ? { 'X-Dorham-Native': '1' } : {}) };
  const payload = body && typeof body === 'object' && !(body instanceof FormData) ? { requestId: crypto.randomUUID(), ...body } : body;
  if (payload && !(payload instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (payload instanceof FormData) headers['X-Request-Id'] = crypto.randomUUID();
  const response = await fetch(`${base}/api/v1${route}`, { method, credentials: 'include', headers, body: payload instanceof FormData ? payload : payload ? JSON.stringify(payload) : undefined });
  if (response.status === 401 && retry && !route.startsWith('/auth/login') && !route.startsWith('/auth/register') && await refreshSession()) return request<T>(route, payload, method, false);
  const data = await response.json().catch(() => ({ error: { message: 'The server returned an invalid response.' } }));
  if (!response.ok) { const error = new Error(data.error?.message || 'Request failed.'); Object.assign(error, { status: response.status }); throw error; }
  if (data.csrf) csrf = data.csrf;
  if (data.accessToken) { access = data.accessToken; accessExpires = Date.now() + 15 * 60000; await setSecret(data.refreshToken); }
  return data;
}
export async function signOut() { try { await request('/auth/logout', {}); } finally { access = ''; csrf = ''; await setSecret(null); if ('caches' in window) { for (const key of await caches.keys()) await caches.delete(key); } } }
export function connectSocket(): Socket { return io(base || window.location.origin, { withCredentials: true, auth: callback => callback({ token: access || undefined, csrf }), reconnectionDelay: 500, reconnectionDelayMax: 5000, transports: ['websocket', 'polling'], tryAllTransports: true }); }
