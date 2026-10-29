import { useEffect, useSyncExternalStore } from 'react';
import fa from './locales/fa-IR.json';
export type Language = 'en-US' | 'fa-IR';
const listeners = new Set<() => void>();
function detect(): Language {
  try { const saved = localStorage.getItem('dorham.language'); if (saved === 'en-US' || saved === 'fa-IR') return saved; } catch { /* Browser preference works without storage. */ }
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('fa') ? 'fa-IR' : 'en-US';
}
let language = detect();
export const currentLanguage = () => language;
export function setLanguage(next: Language) {
  if (next !== 'fa-IR' && next !== 'en-US') return;
  try { localStorage.setItem('dorham.language', next); } catch { /* Session switching still works. */ }
  if (language === next) return; language = next; for (const notify of listeners) notify();
}
export function useLanguage() {
  const value = useSyncExternalStore(notify => { listeners.add(notify); return () => listeners.delete(notify); }, currentLanguage, () => 'en-US' as Language);
  useEffect(() => { document.documentElement.lang = value; document.documentElement.dir = value === 'fa-IR' ? 'rtl' : 'ltr'; }, [value]); return value;
}
export function t(text: string, values: Record<string, string | number> = {}): string {
  const translated = language === 'fa-IR' ? (fa as Record<string, string>)[text] || text : text;
  return translated.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
}
export function LanguagePicker({ save }: { save?: (language: Language) => Promise<unknown> }) {
  const value = useLanguage();
  return <label className="language-picker">{t('Language')}<select aria-label={t('Language')} value={value} onChange={e => { const next = e.target.value as Language; setLanguage(next); void save?.(next); }}><option value="en-US">English</option><option value="fa-IR">فارسی</option></select></label>;
}
export function translatedError(error: any) { const message = error?.message || String(error); if (language === 'en-US' || (fa as Record<string, string>)[message]) return t(message); return t(error?.code === 'VALIDATION' ? 'Please check the input.' : 'Request failed. Please retry.'); }
