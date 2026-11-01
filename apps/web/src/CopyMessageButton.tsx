import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { t } from './i18n';
import './copy-message.css';
const clipboard = registerPlugin<{ write(value: { text: string }): Promise<void> }>('DorhamClipboard');
export function CopyMessageButton({ text, touch = false, error }: { text: string; touch?: boolean; error: (error: unknown) => void }) {
 const [copied, setCopied] = useState(false);
 return <button type="button" className={touch ? 'message-copy-touch' : 'icon-button message-copy'} title={t('Copy message text')} aria-label={t('Copy message text')} onClick={() => {
  const result = Capacitor.getPlatform() === 'android' ? clipboard.write({ text }) : navigator.clipboard.writeText(text);
  void result.then(() => { setCopied(true); }).catch(error);
 }} onBlur={() => setCopied(false)}>{copied ? <Check size={14}/> : <Copy size={14}/>}{touch && <span>{t(copied ? 'Copied' : 'Copy')}</span>}</button>;
}
