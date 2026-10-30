import type { Share } from '@dorham/contracts';
import type { Connection, Row } from './db';
import type { Config } from './config';

export function shareView(row: Row, c: Config): Share {
  return { id: row.id, channelId: row.channel_id, userId: row.user_id, expiresAt: Number(row.expires_at), tier: row.tier,
    startedAt: Number(row.started_at), requestedFrameRate: Number(row.requested_fps),
    maxFrameRate: Math.min(row.tier === 'standard' ? 30 : 15, c.screenMaxFrameRate),
    includeAudio: Boolean(row.include_audio), policyRevision: Number(row.policy_revision) };
}

// Called inside the existing serialized transaction. No timer, network request,
// or permission cache lives here; a released slot always goes to an older waiter.
export async function reconcileShares(tx: Connection, c: Config) {
  await tx.run('DELETE FROM share_leases WHERE expires_at<?', [Date.now()]);
  const count = await tx.one("SELECT COUNT(*) AS count FROM share_leases WHERE tier='standard'");
  const available = Math.max(0, c.standardShareSlots - Number(count!.count));
  if (!available) return;
  const waiting = await tx.all("SELECT id FROM share_leases WHERE tier='fallback' ORDER BY started_at,id LIMIT ?", [available]);
  for (const row of waiting) await tx.run("UPDATE share_leases SET tier='standard',policy_revision=policy_revision+1 WHERE id=? AND tier='fallback'", [row.id]);
}
