import { useEffect, useRef, useState } from 'react';
import { request, serverUrl } from './api';
import { t } from './i18n';

// Sensitive plaintext is held in this tab's memory only, until acknowledged.
let issued: { account: string; origin: string; codes: string[] } | null = null;
let landing: { serverId: string; channelId?: string | null } | null = null;
export function rememberRecoveryCodes(account: string, codes?: string[]) { issued = codes?.length ? { account, origin: serverUrl(), codes } : null; }
export function rememberInviteLanding(value: typeof landing) { landing = value; }
export function takeInviteLanding() { const value = landing; landing = null; return value; }
export function PasswordResetGuide() {
  return <details className="password-reset-guide"><summary>{t('How to reset your password')}</summary><ol>
    <li>{t('On the sign-in screen, open Forgot password?')}</li>
    <li>{t('Enter your username, one unused recovery code and your new password.')}</li>
    <li>{t('Sign in with the new password. The used code stops working and other devices are signed out.')}</li>
  </ol><p>{t('Keep recovery codes in a password manager or a private offline file. Anyone with a code can reset your password. Dorham cannot show old codes again.')}</p><p>{t('Without a saved code, contact your instance administrator for a temporary password. Security questions alone cannot reset your account.')}</p></details>;
}
export function RecoverySetup({ account, username, error }: { account: string; username: string; error: (e: unknown) => void }) {
  const [open, setOpen] = useState(false), [codes, setCodes] = useState(() => issued?.account === account && issued.origin === serverUrl() ? issued.codes : []);
  const [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [hasCodes, setHasCodes] = useState(false), [saved, setSaved] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { let live = true; void request('/auth/recovery').then(value => { if (live) { setHasCodes(value.codesRemaining > 0); setOpen(Boolean(value.prompt || codes.length)); } }).catch(error); return () => { live = false; issued = null; }; }, [account]);
  useEffect(() => { if (!open) return; const node = dialog.current!, previous = document.activeElement as HTMLElement | null; node.showModal(); return () => { node.close(); if (previous?.isConnected) previous.focus(); }; }, [open]);
  async function dismiss() {
    setBusy(true); try { await request('/auth/recovery-acknowledge', {}); issued = null; setCodes([]); setOpen(false); } catch (e) { error(e); } finally { setBusy(false); }
  }
  if (!open) return null;
  return <dialog ref={dialog} className="modal-backdrop" aria-label={t('Protect your account')} onCancel={e => { e.preventDefault(); }}><div className="modal recovery-setup">
    <header><div><span className="eyebrow">{t('ACCOUNT RECOVERY')}</span><h2>{t('Protect your account')}</h2></div></header>
    <p>{t('Save your recovery codes now so you can reset a forgotten password. This reminder appears once for your account.')}</p>
    {codes.length ? <><p>{t('Each code works once. Save this set before continuing.')}</p><pre className="recovery-code-grid" dir="ltr">{codes.join('\n')}</pre><button className="secondary" disabled={busy} onClick={() => { const blob = new Blob([`Dorham recovery codes\nUsername: ${username}\n${codes.join('\n')}\nKeep private. Each code works once.`], { type: 'text/plain' }), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'dorham-recovery-codes.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>{t('Save recovery codes')}</button><label className="check-row"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)}/>{t('I have saved my recovery codes')}</label><button className="primary" disabled={!saved || busy} onClick={() => { void dismiss(); }}>{t('Continue to Dorham')}</button></> : <><p>{t(hasCodes ? 'You already have recovery codes. Keep them if you saved them; generating a new set invalidates the previous set.' : 'Confirm your current password to generate a private set of recovery codes.')}</p><form onSubmit={e => { e.preventDefault(); setBusy(true); void request('/auth/recovery-codes', { password }).then(value => { issued = null; setCodes(value.codes); setPassword(''); }).catch(error).finally(() => setBusy(false)); }}><label>{t('Current password')}<input type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}/></label><button className="primary" disabled={busy || !password}>{t('Generate recovery codes')}</button></form><button className="secondary" disabled={busy} onClick={() => { void dismiss(); }}>{t(hasCodes ? 'I already saved my codes' : 'Set up later in Account settings')}</button></>}
    <PasswordResetGuide/>
  </div></dialog>;
}
