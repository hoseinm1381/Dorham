import { useState } from 'react';
import { request } from './api';
import { t } from './i18n';
export function SignedInPasswordReset({ error, completed = () => {} }: { error: (e: unknown) => void; completed?: () => void | Promise<void> }) {
  const [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  return <details className="signed-in-password-reset"><summary>{t('Reset password while signed in')}</summary>
    <p>{t('You are already signed in. Choose a new password without your old password or a recovery code. Other devices will be signed out.')}</p>
    <form onSubmit={e => { e.preventDefault(); setBusy(true); void request('/auth/password', { password }).then(async () => { setPassword(''); setSaved(true); await completed(); }).catch(error).finally(() => setBusy(false)); }}>
      <label>{t('New password')}<input type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={e => { setPassword(e.target.value); setSaved(false); }}/></label>
      <button className="secondary" disabled={busy}>{t('Save new password')}</button>
    </form>{saved && <p role="status">{t('Password updated. Use your new password for recovery setup and future sign-ins.')}</p>}
  </details>;
}
