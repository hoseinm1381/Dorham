import { useCallback, useSyncExternalStore, type ButtonHTMLAttributes } from 'react';
import { connectionLatenciesSchema, type ConnectionLatency } from '../../../packages/contracts/src/connection';
import { KeyedStore } from './keyed-store';

export const latencyStore = new KeyedStore<ConnectionLatency>();
export const speakingStore = new KeyedStore<boolean>();
export function acceptLatencies(value: unknown) {
  const parsed = connectionLatenciesSchema.safeParse(value);
  if (parsed.success) latencyStore.replace(Object.fromEntries(parsed.data.map(sample => [sample.userId, sample])));
}
export function useConnectionLatency(userId: string) {
  return useSyncExternalStore(useCallback(notify => latencyStore.subscribe(userId, notify), [userId]), useCallback(() => latencyStore.get(userId), [userId]));
}
export function SpeakingButton({ userId, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { userId: string }) {
  const active = useSyncExternalStore(useCallback(notify => speakingStore.subscribe(userId, notify), [userId]), useCallback(() => speakingStore.get(userId) === true, [userId]));
  return <button {...props} className={`${className}${active ? ' speaking' : ''}`.trim()}/>;
}
