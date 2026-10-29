export class VoiceMembershipCues {
  private channel: string | null = null;
  private members = new Set<string>();
  transition(channelId: string | null, members: string[] = []): ('join' | 'leave')[] {
    if (channelId === this.channel) return [];
    const cues: ('join' | 'leave')[] = [];
    if (this.channel) cues.push('leave');
    if (channelId) cues.push('join');
    this.channel = channelId; this.members = new Set(members); return cues;
  }
  directory(rooms: { channelId: string; members: { user: { id: string } }[] }[], selfId: string): ('join' | 'leave')[] {
    const room = rooms.find(r => r.channelId === this.channel);
    // Local removal is handled once by transition(null), not as an extra peer cue.
    if (!room?.members.some(m => m.user.id === selfId)) return [];
    const next = new Set(room.members.map(m => m.user.id)), cues: ('join' | 'leave')[] = [];
    if ([...this.members].some(id => id !== selfId && !next.has(id))) cues.push('leave');
    if ([...next].some(id => id !== selfId && !this.members.has(id))) cues.push('join');
    this.members = next; return cues;
  }
}
