import type { Socket } from 'socket.io';
import { connectionProbeSchema, type ConnectionLatency } from '../../../packages/contracts/src/connection';

// Chat-server RTT, measured by this server's monotonic clock. No client timing,
// IP address, database writes or media getStats polling is involved.
export class ConnectionLatencyMonitor {
  private samples = new Map<string, ConnectionLatency>();
  private pending = new Set<string>();
  constructor(private wallClock = Date.now, private clock = () => performance.now()) {}
  async probe(socket: Socket) {
    if (!socket.connected || this.pending.has(socket.id)) return;
    this.pending.add(socket.id);
    const started = this.clock();
    try {
      const reply = await socket.timeout(5000).emitWithAck('connection:probe', { version: 1 });
      connectionProbeSchema.parse(reply);
      const milliseconds = Math.round(this.clock() - started);
      if (socket.connected && milliseconds >= 0 && milliseconds <= 5000) {
        this.samples.set(socket.id, { userId: socket.data.userId, milliseconds, measuredAt: this.wallClock() });
      } else this.samples.delete(socket.id);
    } catch { this.samples.delete(socket.id); }
    finally { this.pending.delete(socket.id); }
  }
  remove(socketId: string) { this.samples.delete(socketId); }
  snapshot(sockets: Iterable<Socket>): ConnectionLatency[] {
    const users = new Map<string, ConnectionLatency>(), now = this.wallClock();
    for (const socket of sockets) {
      if (!socket.connected) continue;
      const userId = socket.data.userId, sample = this.samples.get(socket.id);
      if (!users.has(userId)) users.set(userId, { userId, milliseconds: null, measuredAt: null });
      if (!sample || sample.measuredAt === null || now - sample.measuredAt > 45000) continue;
      const previous = users.get(userId)!;
      if (previous.milliseconds === null || sample.milliseconds! < previous.milliseconds) users.set(userId, sample);
    }
    return [...users.values()];
  }
}
