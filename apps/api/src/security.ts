import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
export class AppError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
export const fail = (status: number, code: string, message: string): never => { throw new AppError(status, code, message); };
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
let active = 0;
export async function passwordHash(password: string) { return limited(() => argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })); }
export async function passwordVerify(encoded: string, password: string) { return limited(() => argon2.verify(encoded, password)); }
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 2) fail(429, 'AUTH_BUSY', 'Authentication is busy. Please retry shortly.');
  active++; try { return await fn(); } finally { active--; }
}
