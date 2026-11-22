const congested = new Set<'voice' | 'call'>();
const listeners = new Set<() => void>();
let inCall = false, dataSaver = false;
const changed = () => { for (const listener of listeners) listener(); };

export function reportMediaPressure(source: 'voice' | 'call', poor: boolean) {
  if (congested.has(source) === poor) return;
  if (poor) congested.add(source); else congested.delete(source);
  changed();
}
export function setMediaTransferPolicy(call: boolean, saver: boolean) {
  if (call === inCall && saver === dataSaver) return;
  inCall = call; dataSaver = saver; changed();
}
export const bulkTransferPaused = () => inCall && (dataSaver || congested.size !== 0);
export const mediaCongested = () => inCall && congested.size !== 0;
export const monitorBulkTransfers = (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; };

export function waitForBulkTransfer(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!bulkTransferPaused()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const check = () => { if (!bulkTransferPaused()) { cleanup(); resolve(); } };
    const cancel = () => { cleanup(); reject(signal?.reason); };
    const cleanup = () => { listeners.delete(check); signal?.removeEventListener('abort', cancel); };
    listeners.add(check); signal?.addEventListener('abort', cancel, { once: true });
  });
}

export function pauseBulkRequest(signal?: AbortSignal) {
  const stop = new AbortController();
  const check = () => { if (bulkTransferPaused()) stop.abort(new Error('Transfer paused to keep voice clear.')); };
  const release = monitorBulkTransfers(check);
  check();
  return { signal: signal ? AbortSignal.any([signal, stop.signal]) : stop.signal, release };
}
