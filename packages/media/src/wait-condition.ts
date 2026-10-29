export function waitForCondition(ready: () => boolean, subscribe: (check: () => void) => () => void, signal: AbortSignal, timeoutMs = 5000): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Screen sharing was cancelled.'));
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let finished = false, unsubscribe = () => {};
    const finish = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); unsubscribe(); signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(); };
    const check = () => { if (ready()) finish(); };
    const abort = () => finish(new Error('Screen sharing was cancelled.'));
    const timer = setTimeout(() => finish(new Error('Screen-sharing permission was not confirmed. Try again.')), timeoutMs);
    unsubscribe = subscribe(check); if (finished) { unsubscribe(); return; } signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else check();
  });
}
