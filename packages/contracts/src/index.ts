import { z } from 'zod';

export const id = z.string().min(1).max(80);
export const requestId = z.string().uuid();
export const roles = ['owner', 'administrator', 'moderator', 'member'] as const;
export type Role = typeof roles[number];
export const permissions = ['view', 'write', 'speak', 'share', 'manageChannels', 'manageMembers', 'moderate'] as const;
export type Permission = typeof permissions[number];
export type Presence = 'online' | 'offline' | 'idle' | 'busy';
export type PublicUser = { id: string; username: string; displayName: string; bio: string; avatar: string | null; status: Presence; instanceAdmin?: boolean };
export type Server = { id: string; name: string; ownerId: string; role: Role };
export type Channel = { id: string; serverId: string; name: string; kind: 'text' | 'voice'; conversationId: string | null; permissions: Record<Permission, boolean> };
export type Reaction = { emoji: string; userIds: string[] };
export type Message = { id: string; conversationId: string; sequence: number; author: PublicUser; content: string; replyTo: string | null; createdAt: number; editedAt: number | null; deleted: boolean; reactions: Reaction[] };
export type ConversationEvent = { conversationId: string; sequence: number; kind: string; payload: unknown };
export type VoiceMember = { user: PublicUser; muted: boolean; deafened: boolean; serverMuted: boolean; canShare: boolean; epoch: string; eligible: boolean; joinedAt: number };
export type Share = { id: string; channelId: string; userId: string; expiresAt: number };
export type VoiceRoom = { channelId: string; members: VoiceMember[]; shares: Share[]; coordinatorId: string | null; coordinatorEpoch: number; transport: 'mesh' | 'livekit' };
export type VoicePresence = { channelId: string; members: Pick<VoiceMember, 'user' | 'muted' | 'deafened' | 'serverMuted'>[]; shares: number };
export type Signal = { channelId: string; to: string; from?: string; epoch: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null; streams?: { streamId: string; kind: 'audio' | 'screen'; leaseId?: string }[]; subscription?: { leaseId: string; enabled: boolean } };
export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
export const credentialsSchema = z.object({ username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/), password: z.string().min(10).max(128) });
export const registerSchema = credentialsSchema.extend({ displayName: z.string().trim().min(1).max(48), requestId });
export const messageSchema = z.object({ conversationId: id, content: z.string().trim().min(1).max(4000), replyTo: id.nullable().optional(), requestId });
export const signalSchema = z.object({ channelId: id, to: id, epoch: id, description: z.object({ type: z.enum(['offer', 'answer', 'pranswer', 'rollback']), sdp: z.string().max(100000).optional() }).optional(), candidate: z.object({ candidate: z.string().max(4096).optional(), sdpMid: z.string().nullable().optional(), sdpMLineIndex: z.number().int().nullable().optional(), usernameFragment: z.string().nullable().optional() }).nullable().optional(), streams: z.array(z.object({ streamId: id, kind: z.enum(['audio', 'screen']), leaseId: id.optional() })).max(3).optional(), subscription: z.object({ leaseId: id, enabled: z.boolean() }).optional() });
const rank: Record<Role, number> = { member: 0, moderator: 1, administrator: 2, owner: 3 };
export function basePermissions(role: Role): Record<Permission, boolean> {
  return { view: true, write: true, speak: true, share: true, manageChannels: rank[role] >= 2, manageMembers: rank[role] >= 1, moderate: rank[role] >= 1 };
}
export function resolvePermissions(role: Role, overrides: Partial<Record<Permission, boolean>> = {}): Record<Permission, boolean> {
  return role === 'owner' ? basePermissions(role) : { ...basePermissions(role), ...overrides };
}
export function canManage(actor: Role, target: Role): boolean { return rank[actor] > rank[target]; }
