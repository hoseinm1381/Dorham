import { canManage, type Role } from './index';

// Voice moves may target peers; punitive actions still require a higher role.
export function canMoveMember(actor: Role, target: Role): boolean {
 return target !== 'owner' && (canManage(actor, target) || (actor === target && ['administrator', 'moderator'].includes(actor)));
}
export const timeoutDurations = [60, 600, 3600, 86400, 604800] as const;
export type MemberModerationInfo = {
 userId: string; role: Role; timeoutUntil: number;
 actions: { voice: boolean; move: boolean; timeout: boolean; kick: boolean; ban: boolean };
 voice: { channelId: string; serverMuted: boolean; serverDeafened: boolean; sharingAllowed: boolean } | null;
};
