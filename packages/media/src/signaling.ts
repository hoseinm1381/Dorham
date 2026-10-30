import type { Socket } from 'socket.io-client';
import type { Result } from '@dorham/contracts';
export function ack<T = any>(socket: Socket, event: string, body: unknown): Promise<T> {
  const payload = body && typeof body === 'object' ? { requestId: crypto.randomUUID(), ...body } : body;
  return new Promise((resolve, reject) => socket.timeout(10000).emit(event, payload, (err: Error | null, result: Result<T>) => {
    if (err) reject(Object.assign(new Error('Connection timed out. Retry after reconnecting.'), { code: 'TIMEOUT' }));
    else if (!result?.ok) reject(Object.assign(new Error(result?.error.message || 'Action failed.'), { code: result?.error.code }));
    else resolve(result.data);
  }));
}
