import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { VoiceTtsProgress } from '../../../packages/contracts/src/tts';
import { KeyedStore } from './keyed-store';
import { formatNumber, t } from './i18n';

export const ttsProgressStore = new KeyedStore<VoiceTtsProgress>();
export function clearTtsProgress(messageId?: string) {
  if (!messageId) { ttsProgressStore.replace({}); return; }
  ttsProgressStore.replace(old => Object.fromEntries(Object.entries(old).filter(([id]) => id !== messageId)));
}
export function acceptTtsProgress(event: VoiceTtsProgress) {
  if (!event || typeof event.id !== 'string' || event.id.length > 200 || !Number.isInteger(event.percent) || event.percent < 0 || event.percent > 100 || !['queued', 'preparing', 'synthesizing', 'finished'].includes(event.phase) || !Number.isFinite(event.expiresAt) || event.expiresAt <= Date.now()) return;
  if (event.phase === 'finished' || event.percent === 100) { clearTtsProgress(event.id); return; }
  const old = ttsProgressStore.get(event.id);
  if (old && old.percent > event.percent) return;
  ttsProgressStore.replace(entries => ({ ...Object.fromEntries(Object.entries(entries).filter(([id, value]) => id !== event.id && value.expiresAt > Date.now()).slice(-15)), [event.id]: event }));
}
export function TtsProgress({ messageId }: { messageId: string }) {
  const progress = useSyncExternalStore(useCallback(notify => ttsProgressStore.subscribe(messageId, notify), [messageId]), useCallback(() => ttsProgressStore.get(messageId), [messageId]));
  useEffect(() => { if (!progress) return; const timer = setTimeout(() => clearTtsProgress(messageId), Math.min(600000, Math.max(0, progress.expiresAt - Date.now()))); return () => clearTimeout(timer); }, [messageId, progress]);
  if (!progress) return null;
  return <span className={`tts-progress${progress.percent === 0 ? ' waiting' : ''}`} role="progressbar" aria-label={t('Preparing speech')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} title={t(progress.phase === 'queued' ? 'Speech is queued' : 'Preparing speech')}><span className="tts-progress-track" aria-hidden="true"><span style={{ width: `${progress.percent}%` }}/></span><small aria-hidden="true">{formatNumber(progress.percent)}%</small></span>;
}
