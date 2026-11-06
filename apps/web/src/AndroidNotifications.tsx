import { useEffect, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { request, serverUrl } from './api';
import { currentLanguage, t } from './i18n';
import { Bell, BellOff } from 'lucide-react';
type NotificationState = { enabled: boolean; configured: boolean; permission: boolean; batteryExempt: boolean; deviceId: string; accountId: string | null; connection: string; sessionGeneration: number };
const notifications = registerPlugin<{ info(): Promise<NotificationState>; configure(options: Record<string, unknown>): Promise<NotificationState>; consumeLink(): Promise<{ url: string | null }>; batterySettings(): Promise<void>; connectionNoticeSettings(): Promise<void>; getChatMutes(options: { origin: string; accountId: string }): Promise<{ mutedConversationIds: string[] }>; setChatMuted(options: { origin: string; accountId: string; conversationId: string; muted: boolean }): Promise<{ mutedConversationIds: string[] }> }>('DorhamNotifications');
let muteScope = '', mutedChats = new Set<string>();
const foregroundAlerts = new Map<string, number>();
function cacheMutes(account: string, values: string[]) {
  const scope = `${serverUrl()}|${account}`;
  if (scope !== muteScope) { foregroundAlerts.clear(); muteScope = scope; }
  mutedChats = new Set(values);
  window.dispatchEvent(new Event('dorham-chat-mutes'));
}
export function allowAndroidMessageAlert(conversation: string) {
  if (Capacitor.getPlatform() !== 'android') return true;
  if (mutedChats.has(conversation)) return false;
  const now = Date.now(), previous = foregroundAlerts.get(conversation);
  if (previous !== undefined && now >= previous && now - previous < 15000) return false;
  for (const [key, at] of foregroundAlerts) if (now < at || now - at >= 15000) foregroundAlerts.delete(key);
  foregroundAlerts.set(conversation, now); return true;
}
export function AndroidChatNotifications({ accountId, conversationId }: { accountId: string; conversationId: string }) {
  const [muted, setMuted] = useState<boolean | null>(null), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return;
    let disposed = false; setMuted(null);
    const refresh = () => { void notifications.getChatMutes({ origin: serverUrl(), accountId }).then(value => { if (!disposed) { cacheMutes(accountId, value.mutedConversationIds); setMuted(value.mutedConversationIds.includes(conversationId)); } }).catch(() => {}); };
    const changed = () => { if (!disposed) setMuted(mutedChats.has(conversationId)); };
    refresh(); window.addEventListener('dorham-app-state', refresh); window.addEventListener('dorham-chat-mutes', changed);
    return () => { disposed = true; window.removeEventListener('dorham-app-state', refresh); window.removeEventListener('dorham-chat-mutes', changed); };
  }, [accountId, conversationId]);
  if (Capacitor.getPlatform() !== 'android') return null;
  const label = failed ? t('Chat notification settings could not be saved.') : t(muted ? 'Unmute this chat' : 'Mute this chat');
  return <button type="button" className="icon-button" title={label} aria-label={label} aria-pressed={muted === true} disabled={muted === null || busy} onClick={() => {
    setBusy(true); setFailed(false); void notifications.setChatMuted({ origin: serverUrl(), accountId, conversationId, muted: !muted }).then(value => { cacheMutes(accountId, value.mutedConversationIds); setMuted(value.mutedConversationIds.includes(conversationId)); }).catch(() => setFailed(true)).finally(() => setBusy(false));
  }}>{muted ? <BellOff size={18}/> : <Bell size={18}/>}</button>;
}
export async function notifyAndroidMessage(_conversationId: string, _title: string) { /* Native delivery owns Android alerts, including when the WebView is suspended. */ }
export async function consumeAndroidLink(): Promise<string | null> { if (Capacitor.getPlatform() !== 'android') return null; return (await notifications.consumeLink()).url || null; }
async function enable(state: NotificationState, resetQueue: boolean, stillCurrent = () => true) {
  const user = await request('/auth/me');
  const registration = await request('/notifications/devices', { installationId: state.deviceId, resetQueue });
  if (!stillCurrent()) return state;
  return notifications.configure({ enabled: true, credential: registration.credential, origin: serverUrl(), accountId: user.user.id, language: currentLanguage(), sessionGeneration: state.sessionGeneration });
}
export function useAndroidNotifications(userId: string | undefined, language: string) {
  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android' || !userId) return;
    if (muteScope !== `${serverUrl()}|${userId}`) cacheMutes(userId, []);
    let disposed = false, running = false;
    const sync = async (initial = false) => {
      if (running) return; running = true;
      try {
        const mutes = await notifications.getChatMutes({ origin: serverUrl(), accountId: userId }); if (!disposed) cacheMutes(userId, mutes.mutedConversationIds);
        const state = await notifications.info(); if (!disposed && state.enabled && (initial || !state.configured || state.connection === 'sign-in')) await enable(state, false, () => !disposed);
      }
      catch { /* Offline login never blocks the app. Resume offers another attempt. */ }
      finally { running = false; }
    };
    const resume = () => { void sync(); };
    void sync(true); window.addEventListener('dorham-app-state', resume); window.addEventListener('online', resume);
    return () => { disposed = true; window.removeEventListener('dorham-app-state', resume); window.removeEventListener('online', resume); };
  }, [userId, language]);
}
export function AndroidNotificationSettings() {
  const [state, setState] = useState<NotificationState | null>(null), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return;
    let disposed = false;
    const refresh = () => { void notifications.info().then(value => { if (!disposed) setState(value); }).catch(() => {}); };
    refresh(); window.addEventListener('dorham-app-state', refresh);
    const timer = setInterval(refresh, 5000);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('dorham-app-state', refresh); };
  }, []);
  if (!state) return null;
  const change = async (enabled: boolean) => {
    setBusy(true); setFailed(false);
    try {
      if (enabled) setState(await enable(state, true));
      else { setState(await notifications.configure({ enabled: false })); await request('/notifications/devices', {}, 'DELETE'); }
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  return <section><h3>{t('Android notifications')}</h3><label className="check-row"><input type="checkbox" checked={state.enabled} disabled={busy} onChange={event => { void change(event.target.checked); }}/>{t('Notify me about direct messages and mentions')}</label><p>{t('Receive private alerts directly from your Dorham server, without Google services or another app.')}</p><p>{t('Each chat can alert once every 15 seconds. Muted chats stay muted until you unmute them from the chat header.')}</p><p>{t('Android requires a background connection notice. You can hide only that category and keep Messages and mentions enabled.')}</p><button type="button" className="secondary" onClick={() => { void notifications.connectionNoticeSettings().catch(() => setFailed(true)); }}>{t('Hide connection notice')}</button><p>{t('Android Force stop pauses alerts until you reopen Dorham.')}</p>{state.enabled && <><p role="status">{t(state.connection === 'connected' ? 'Notification connection is active.' : state.connection === 'sign-in' ? 'Open Dorham and sign in to reconnect notifications.' : 'Notification connection is starting or reconnecting.')}</p>{!state.permission && <p>{t('Allow notifications in Android settings to receive alerts.')}</p>}{!state.batteryExempt && <><p>{t('Allow background battery use for timely alerts while your screen is off.')}</p><button type="button" disabled={busy} onClick={() => { void notifications.batterySettings().catch(() => setFailed(true)); }}>{t('Allow background notifications')}</button></>}</>}{failed && <p role="alert">{t('Notification settings could not be saved. Check your connection and try again.')}</p>}</section>;
}
