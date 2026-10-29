import type { Connection, Row } from './db';

// Reuse identical reads only inside one database transaction. This cache never
// survives a commit, and any write invalidates it before the next read.
export function readSnapshot(tx: Connection): Connection {
  const cache = new Map<string, Promise<unknown>>();
  const read = <T>(kind: string, query: string, params: unknown[] | undefined, fn: () => Promise<T>) => {
    const key = JSON.stringify([kind, query, params || []]);
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key) as Promise<T>;
  };
  return {
    all: <T extends Row = Row>(q: string, p?: unknown[]) => read('all', q, p, () => tx.all<T>(q, p)),
    one: <T extends Row = Row>(q: string, p?: unknown[]) => read('one', q, p, () => tx.one<T>(q, p)),
    run: async (q, p) => { cache.clear(); await tx.run(q, p); }
  };
}
