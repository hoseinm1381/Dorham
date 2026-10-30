import 'dotenv/config';
import path from 'node:path';

export type Config = ReturnType<typeof config>;
export function config(overrides: Partial<{
  dataDir: string; databaseUrl: string; port: number; host: string; publicUrl: string; origins: string[];
  secure: boolean; production: boolean; bootstrapSecret: string; registrationOpen: boolean;
  maxUsers: number; maxOnline: number; maxVoice: number; roomShares: number; globalShares: number;
  retentionDays: number; maxMessages: number; maxDatabaseMiB: number; maxAvatarsMiB: number;
  stunUrls: string[]; turnUrls: string[]; turnUsername: string; turnPassword: string; turnSecret: string;
  cloudflareTurnKeyId: string; cloudflareTurnApiToken: string;
  mediaTransport: 'mesh' | 'livekit'; livekitUrl: string; livekitApiUrl: string; livekitKey: string; livekitSecret: string;
  screenMaxBitrate: number; screenMaxFrameRate: number; standardShareSlots: number; trustedProxies: string[];
  guestsEnabled: boolean; maxGuests: number; attachmentDir: string; attachmentBudgetMiB: number; uploadReserveMiB: number; uploadConcurrency: number;
  uploadSoftMiB: number; uploadHardMiB: number; uploadSmallMiB: number;
  mediaAdmissionSecret: string;
}> = {}) {
  const num = (key: string, fallback: number, allowZero = false) => { const n = Number(process.env[key] || fallback); if (!Number.isSafeInteger(n) || n < (allowZero ? 0 : 1)) throw new Error(`Invalid ${key}`); return n; };
  const list = (key: string, fallback = '') => (process.env[key] ?? fallback).split(',').map(s => s.trim()).filter(Boolean);
  const production = process.env.NODE_ENV === 'production';
  const c = {
    dataDir: path.resolve(process.env.DATA_DIR || './data'), databaseUrl: process.env.DATABASE_URL || '',
    port: num('SERVER_PORT', 3001), host: process.env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    publicUrl: process.env.PUBLIC_URL || 'http://localhost:3001',
    origins: list('ALLOWED_ORIGINS', 'http://localhost:5173,http://localhost:3001,capacitor://localhost,https://localhost,dorham://app'),
    secure: process.env.COOKIE_SECURE === 'true' || production, production,
    bootstrapSecret: process.env.BOOTSTRAP_ADMIN_SECRET || '', registrationOpen: process.env.REGISTRATION_OPEN !== 'false',
    maxUsers: num('MAX_USERS', 100), maxOnline: num('MAX_ONLINE_USERS', 20), maxVoice: num('MAX_VOICE_PARTICIPANTS', 16),
    roomShares: num('MAX_ROOM_SHARES', 0, true), globalShares: num('MAX_GLOBAL_SHARES', 0, true),
    retentionDays: num('MESSAGE_RETENTION_DAYS', 90), maxMessages: num('MAX_MESSAGES', 50000),
    maxDatabaseMiB: num('MAX_DATABASE_MIB', 256), maxAvatarsMiB: num('MAX_AVATARS_MIB', 16),
    stunUrls: list('STUN_URLS'), turnUrls: list('TURN_URLS'),
    turnUsername: process.env.TURN_USERNAME || '', turnPassword: process.env.TURN_PASSWORD || '', turnSecret: process.env.TURN_SECRET || '',
    cloudflareTurnKeyId: process.env.CLOUDFLARE_TURN_KEY_ID || '', cloudflareTurnApiToken: process.env.CLOUDFLARE_TURN_API_TOKEN || '',
    mediaTransport: (process.env.MEDIA_TRANSPORT === 'livekit' ? 'livekit' : 'mesh') as 'mesh' | 'livekit',
    screenMaxBitrate: num('SCREEN_MAX_BITRATE', 1500000), screenMaxFrameRate: num('SCREEN_MAX_FRAME_RATE', 30),
    standardShareSlots: num('STANDARD_SHARE_SLOTS', 3), trustedProxies: list('TRUSTED_PROXIES'),
    guestsEnabled: process.env.GUESTS_ENABLED !== 'false', maxGuests: num('MAX_GUESTS', 100),
    attachmentDir: path.resolve(process.env.ATTACHMENT_DIR || path.join(process.env.DATA_DIR || './data', 'attachments')),
    attachmentBudgetMiB: num('ATTACHMENT_BUDGET_MIB', 2048), uploadReserveMiB: num('UPLOAD_FREE_RESERVE_MIB', 2048), uploadConcurrency: num('UPLOAD_CONCURRENCY', 2),
    uploadSoftMiB: num('UPLOAD_DAILY_SOFT_MIB', 512), uploadHardMiB: num('UPLOAD_DAILY_HARD_MIB', 1024), uploadSmallMiB: num('UPLOAD_SMALL_FILE_MIB', 2),
    livekitUrl: process.env.LIVEKIT_URL || '', livekitKey: process.env.LIVEKIT_API_KEY || '', livekitSecret: process.env.LIVEKIT_API_SECRET || '',
    livekitApiUrl: process.env.LIVEKIT_API_URL || '',
    mediaAdmissionSecret: process.env.MEDIA_ADMISSION_SECRET || '',
    ...overrides
  };
  if (Boolean(c.cloudflareTurnKeyId) !== Boolean(c.cloudflareTurnApiToken)) throw new Error('Both Cloudflare TURN key ID and API token are required');
  if (c.cloudflareTurnKeyId && (!/^[a-zA-Z0-9_-]{1,128}$/.test(c.cloudflareTurnKeyId) || c.turnUrls.length)) throw new Error('Use one TURN provider and a valid Cloudflare TURN key ID');
  if (c.mediaTransport === 'livekit' && (!c.livekitUrl || !c.livekitKey || !c.livekitSecret)) throw new Error('LiveKit credentials required');
  if (c.screenMaxBitrate < 64000 || c.screenMaxBitrate > 10000000 || c.screenMaxFrameRate > 30) throw new Error('Invalid screen publishing policy');
  if (!process.env.ATTACHMENT_DIR && overrides.dataDir && !overrides.attachmentDir) c.attachmentDir = path.join(c.dataDir, 'attachments');
  if (c.attachmentDir === c.dataDir || c.attachmentDir === path.parse(c.attachmentDir).root) throw new Error('ATTACHMENT_DIR must be a dedicated attachment directory.');
  if (c.uploadHardMiB < c.uploadSoftMiB || c.uploadSmallMiB > 100) throw new Error('Invalid shared upload policy.');
  if (c.mediaAdmissionSecret && c.mediaAdmissionSecret.length < 32) throw new Error('MEDIA_ADMISSION_SECRET must contain at least 32 characters.');
  if (c.production && !c.publicUrl.startsWith('https://')) throw new Error('Production PUBLIC_URL must use HTTPS');
  return c;
}
