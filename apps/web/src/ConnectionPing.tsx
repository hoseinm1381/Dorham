import { Activity } from 'lucide-react';
import type { ConnectionLatency } from '../../../packages/contracts/src/connection';
import { formatNumber, t } from './i18n';

export function ConnectionPing({ name, sample, online }: { name: string; sample?: ConnectionLatency; online: boolean }) {
  if (!online) return null;
  const ms = sample?.milliseconds ?? null;
  const label = ms === null ? t('Ping unavailable') : t('{value} ms', { value: formatNumber(ms) });
  return <span className={`connection-ping ${ms === null ? 'unknown' : ms < 150 ? 'good' : ms < 300 ? 'fair' : 'slow'}`} data-testid="connection-ping" data-ping-ms={ms ?? ''} aria-label={t('Chat server ping for {name}: {ping}', { name, ping: label })} title={t('Round-trip to the chat server; not voice latency. Best recent active connection.')}><Activity size={11}/><span>{label}</span></span>;
}
