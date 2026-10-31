import { z } from 'zod';

export const id = z.string().min(1).max(80);
export const requestId = z.string().uuid();
export const roles = ['owner', 'administrator', 'moderator', 'member'] as const;
export type Role = typeof roles[number];
export const permissions = ['view', 'write', 'speak', 'share', 'manageChannels', 'manageMembers', 'moderate', 'createInvites'] as const;
export type Permission = typeof permissions[number];
export type Presence = 'online' | 'offline' | 'idle' | 'busy';
export type Tag = { id: string; serverId: string; name: string; color: string };
export type CustomRole = { id: string; serverId: string; name: string; color: string; permissions: Partial<Record<Permission, boolean>> };
export type ServerMember = { user: PublicUser; role: Role; customRoles: CustomRole[] };
export type PublicUser = { id: string; username: string; displayName: string; bio: string; avatar: string | null; status: Presence; instanceAdmin?: boolean; guest?: boolean; language?: 'en-US' | 'fa-IR'; banned?: boolean; mustChangePassword?: boolean; tags?: Tag[] };
export type Server = { id: string; name: string; ownerId: string; icon?: string | null; role: Role; allowGuests?: boolean; allowMemberInvites?: boolean; permissions?: Record<Permission, boolean> };
export type Channel = { id: string; serverId: string; name: string; kind: 'text' | 'voice'; conversationId: string | null; permissions: Record<Permission, boolean>; locked?: boolean; userLimit?: number; tagMode?: 'ANY' | 'ALL'; requiredTags?: string[] };
export type Attachment = { id: string; name: string; size: number; expiresAt: number; available: boolean };
export type Reaction = { emoji: string; userIds: string[] };
export type Message = { id: string; conversationId: string; sequence: number; author: PublicUser; content: string; replyTo: string | null; createdAt: number; editedAt: number | null; deleted: boolean; reactions: Reaction[]; attachments?: Attachment[] };
export type ConversationEvent = { conversationId: string; sequence: number; kind: string; payload: unknown; direct?: boolean };
export type VoiceMember = { user: PublicUser; muted: boolean; deafened: boolean; serverMuted: boolean; serverDeafened?: boolean; canShare: boolean; epoch: string; eligible: boolean; joinedAt: number };
export type Share = { id: string; channelId: string; userId: string; expiresAt: number; tier?: 'standard' | 'fallback'; startedAt?: number; requestedFrameRate?: number; maxFrameRate?: number; includeAudio?: boolean; policyRevision?: number };
export const shareStartSchema = z.object({ requestId, protocolVersion: z.literal(2), includeAudio: z.boolean().default(false) }).strict();
export const shareUpdateSchema = z.object({ requestId, leaseId: id, expectedRevision: z.number().int().positive(), frameRate: z.union([z.literal(15), z.literal(30)]).optional(), includeAudio: z.literal(false).optional() }).strict();
export type VoiceRoom = { channelId: string; members: VoiceMember[]; shares: Share[]; coordinatorId: string | null; coordinatorEpoch: number; transport: 'mesh' | 'livekit' };
export type VoicePresence = { channelId: string; members: Pick<VoiceMember, 'user' | 'muted' | 'deafened' | 'serverMuted'>[]; shares: number };
export type Signal = { channelId: string; to: string; from?: string; epoch: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null; streams?: { streamId: string; kind: 'audio' | 'screen'; leaseId?: string }[]; subscription?: { leaseId: string; enabled: boolean } };
export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
export const passwordSchema = z.string().min(8).max(128);
export const credentialsSchema = z.object({ username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/), password: passwordSchema });
export const registerSchema = credentialsSchema.extend({ displayName: z.string().trim().min(1).max(48), language: z.enum(['en-US', 'fa-IR']).optional(), requestId });
export const messageSchema = z.object({ conversationId: id, content: z.string().trim().max(4000), replyTo: id.nullable().optional(), attachmentIds: z.array(z.string().uuid()).max(4).default([]), requestId }).refine(v => v.content.length > 0 || v.attachmentIds.length > 0, { message: 'Write a message or attach a file.' });
export const signalSchema = z.object({ channelId: id, to: id, epoch: id, description: z.object({ type: z.enum(['offer', 'answer', 'pranswer', 'rollback']), sdp: z.string().max(100000).optional() }).optional(), candidate: z.object({ candidate: z.string().max(4096).optional(), sdpMid: z.string().nullable().optional(), sdpMLineIndex: z.number().int().nullable().optional(), usernameFragment: z.string().nullable().optional() }).nullable().optional(), streams: z.array(z.object({ streamId: id, kind: z.enum(['audio', 'screen']), leaseId: id.optional() })).max(3).optional(), subscription: z.object({ leaseId: id, enabled: z.boolean() }).optional() });
const rank: Record<Role, number> = { member: 0, moderator: 1, administrator: 2, owner: 3 };
export function basePermissions(role: Role): Record<Permission, boolean> {
  return { view: true, write: true, speak: true, share: true, manageChannels: rank[role] >= 2, manageMembers: rank[role] >= 1, moderate: rank[role] >= 1, createInvites: true };
}
export function resolvePermissions(role: Role, overrides: Partial<Record<Permission, boolean>> = {}): Record<Permission, boolean> {
  return role === 'owner' ? basePermissions(role) : { ...basePermissions(role), ...overrides };
}
export function canManage(actor: Role, target: Role): boolean { return rank[actor] > rank[target]; }

// Explicit custom-role denies win over allows. Channel overrides are applied last.
// Owners remain unrestricted; custom roles never confer ownership or instance admin.
export function resolveCustomPermissions(role: Role, assigned: Partial<Record<Permission, boolean>>[], channel: Partial<Record<Permission, boolean>> = {}): Record<Permission, boolean> {
  if (role === 'owner') return basePermissions(role);
  const result = basePermissions(role);
  for (const p of permissions) {
    if (assigned.some(r => r[p] === false)) result[p] = false;
    else if (assigned.some(r => r[p] === true)) result[p] = true;
  }
  return { ...result, ...channel };
}
