import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { applyAction, advanceLegalAction, costs, inCheck, canMateOnTimeout, legalActions, initialPosition, outcome, repetitionCount, squareName, type Color, type ChessAction, type ChessGame, type ChessView, type ChessPosition, type VoiceGame } from '../../../packages/contracts/src/chess';
import { arcadeBusy } from './games/service';
import type { Service } from './service';
import type { Connection } from './db';
import { fail } from './security';

export const chessCreate = z.object({ requestId: z.string().uuid(), serverId: z.string().min(1).max(100), channelId: z.string().min(1).max(100).optional(), openSeat: z.literal(true).optional(), opponentId: z.string().min(1).max(100).optional(), difficulty: z.enum(['Easy', 'Medium', 'Hard']).optional(), mode: z.enum(['standard', 'elixer']), minutes: z.union([z.literal(3), z.literal(5), z.literal(10), z.literal(15)]), increment: z.union([z.literal(0), z.literal(2), z.literal(5), z.literal(10)]) }).strict().refine(b => [b.opponentId, b.difficulty, b.openSeat].filter(Boolean).length === 1 && (!b.openSeat || Boolean(b.channelId)) && (!b.channelId || !b.opponentId), 'Choose an open voice seat or AI');
export const chessCommand = z.object({ requestId: z.string().uuid(), revision: z.number().int().positive(), kind: z.enum(['join', 'accept', 'decline', 'cancel', 'action', 'resign', 'offerDraw', 'acceptDraw', 'declineDraw', 'claimDraw']), action: z.object({ from: z.number().int().min(0).max(63).optional(), to: z.number().int().min(0).max(63), buy: z.enum(['p', 'n', 'b', 'r', 'q']).optional(), promotion: z.enum(['q', 'r', 'b', 'n']).optional() }).strict().optional() }).strict();
type Create = z.infer<typeof chessCreate>; type Command = z.infer<typeof chessCommand>;
const winner = (color: number, reason: string) => `${color === 0 ? 'White' : 'Black'} wins by ${reason}`;
export function chargeClock(g: ChessGame, now: number) {
  if (g.status !== 'playing' || g.pausedUntil) return;
  const color = g.position.turn;
  g.remaining[color] = Math.max(0, g.remaining[color] - Math.max(0, now - g.runningSince)); g.runningSince = now;
  if (!g.remaining[color]) { g.status = 'finished'; g.result = g.position.mode === 'standard' && !canMateOnTimeout(g.position, (1 - color) as Color) ? 'Draw by insufficient material' : winner(1 - color, 'timeout'); }
}
// AI never has a thread or a continuous loop. Search is bounded to 8ms and 144 replies.
export function chooseAi(s: ChessPosition, difficulty: string): ChessAction | undefined {
  const actions = legalActions(s); if (!actions.length) return;
  if (difficulty === 'Easy') return actions[Math.floor(Math.random() * actions.length)];
  const values: Record<string, number> = { ...costs, k: 100 }, color = s.turn, deadline = performance.now() + 8;
  const evaluate = (p: ChessPosition) => p.board.reduce((score, piece) => score + (piece ? (piece === piece.toUpperCase() ? 1 : -1) * values[piece.toLowerCase()] : 0), 0) * (color === 0 ? 1 : -1) + (p.coins[color] - p.coins[1 - color]) * 0.12;
  const ranked = actions.map(a => ({ a, hint: (a.buy ? 0.2 : values[s.board[a.to]?.toLowerCase()] || 0) + (a.promotion ? 8 : 0) })).sort((a, b) => b.hint - a.hint);
  let best = ranked[0].a, score = -Infinity, searched = 0;
  for (const { a } of ranked) {
    if (performance.now() > deadline && searched) break;
    const next = advanceLegalAction(s, a); let value = evaluate(next) + (inCheck(next) ? 0.3 : 0);
    if (difficulty === 'Hard' && searched < 12) {
      const replies = legalActions(next).sort((a, b) => (values[next.board[b.to]?.toLowerCase()] || 0) - (values[next.board[a.to]?.toLowerCase()] || 0)).slice(0, 12);
      for (const reply of replies) { if (performance.now() > deadline) break; value = Math.min(value, evaluate(advanceLegalAction(next, reply))); }
    }
    if (value > score) { score = value; best = a; } searched++;
  }
  return best;
}
export class ChessService {
  private active = new Map<string, ChessGame>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly epoch = Date.now(); private readonly monotonic = performance.now();
  now = () => this.epoch + performance.now() - this.monotonic;
  notify: (g: ChessGame, directoryChanged: boolean) => Promise<void> = async () => {};
  online: (id: string) => boolean = () => true;
  onError: (e: unknown) => void = () => {};
  constructor(private service: Service) {}
  async initialize() {
    const rows = await this.service.db.all("SELECT state FROM chess_games WHERE status<>'finished'");
    for (const row of rows) {
      const g = JSON.parse(row.state) as ChessGame;
      // Reconstruct the persisted deadline once at restart, then use monotonic
      // elapsed time again. A crash never refunds an entire uncommitted turn.
      if (g.status === 'playing') { const now = this.now(); this.expire(g, now); if (g.status === 'playing') { g.missing = [g.whiteId, ...(g.blackId ? [g.blackId] : [])]; g.missingAt = Object.fromEntries(g.missing.map(id => [id, now])); g.pausedUntil = now + 30000; g.runningSince = now; } g.revision++; await this.save(this.service.db, g); }
      if (g.status !== 'finished') this.active.set(g.id, g);
    }
    this.schedule();
  }
  close() { this.closed = true; clearTimeout(this.timer); }
  async allowed(tx: Connection, uid: string, g: ChessGame) {
    const member = await tx.one('SELECT m.user_id FROM members m JOIN users u ON u.id=m.user_id JOIN servers s ON s.id=m.server_id WHERE m.user_id=? AND m.server_id=? AND u.banned=0 AND (u.guest=0 OR s.allow_guests=1)', [uid, g.serverId]);
    if (!member) fail(403, 'FORBIDDEN', 'Join the match server to play or watch.');
    // Spectators must still share this server with both players.
    const ids = [g.whiteId, ...(g.blackId ? [g.blackId] : [])];
    for (const id of ids) if (!await tx.one('SELECT user_id FROM members WHERE server_id=? AND user_id=?', [g.serverId, id])) fail(403, 'FORBIDDEN', 'A player has left the match server.');
    if (g.channelId && uid !== g.whiteId && uid !== g.blackId) await this.requireVoice(tx, uid, g.channelId);
  }
  private async requireVoice(tx: Connection, uid: string, channelId: string) {
    const channel = await this.service.channel(tx, uid, channelId);
    if (channel.kind !== 'voice' || !await tx.one('SELECT user_id FROM voice_members WHERE user_id=? AND channel_id=?', [uid, channelId])) fail(403, 'VOICE_REQUIRED', 'Join this voice channel to play or watch.');
    return channel;
  }
  private async load(tx: Connection, id: string): Promise<ChessGame> { const row = await tx.one('SELECT state FROM chess_games WHERE id=?', [id]); if (!row) fail(404, 'NOT_FOUND', 'Chess match not found.'); return JSON.parse(row!.state); }
  private async save(tx: Connection, g: ChessGame) { g.updatedAt = this.now(); await tx.run('INSERT INTO chess_games(id,server_id,white_id,black_id,status,updated_at,state,channel_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET black_id=excluded.black_id,channel_id=excluded.channel_id,status=excluded.status,updated_at=excluded.updated_at,state=excluded.state', [g.id, g.serverId, g.whiteId, g.blackId, g.status, g.updatedAt, JSON.stringify(g), g.channelId || null]); }
  async get(uid: string, id: string): Promise<ChessView> {
    return this.service.db.transaction(async tx => {
      const g = await this.load(tx, id); await this.allowed(tx, uid, g); const now = this.now();
      const view = structuredClone(g); chargeClock(view, now);
      const ownTurn = (view.position.turn === 0 ? view.whiteId : view.blackId) === uid;
      const inVoice = !g.channelId || Boolean(await tx.one('SELECT user_id FROM voice_members WHERE user_id=? AND channel_id=?', [uid, g.channelId]));
      return { ...view, serverNow: now, actions: view.status === 'playing' && !view.pausedUntil && ownTurn && inVoice ? legalActions(view.position) : [], canPlay: Boolean(g.openSeat && g.status === 'pending' && !g.blackId && uid !== g.whiteId && inVoice && !g.pausedUntil), check: inCheck(view.position), canClaimDraw: view.position.mode === 'standard' && (view.position.half >= 100 || repetitionCount(view.position) >= 3) };
    });
  }
  async voiceGames(uid: string, channelId: string): Promise<VoiceGame[]> {
    return this.service.db.transaction(async tx => {
      const channel = await this.requireVoice(tx, uid, channelId);
      const rows = await tx.all("SELECT state FROM chess_games WHERE status<>'finished' AND (channel_id=? OR (channel_id IS NULL AND server_id=? AND (white_id=? OR black_id=?))) ORDER BY updated_at DESC LIMIT 60", [channelId, channel.server_id, uid, uid]);
      return rows.map(r => JSON.parse(r.state) as ChessGame).map(g => ({ id: g.id, channelId, hostName: g.whiteName, whiteId: g.whiteId, blackId: g.blackId, status: g.status, openSeat: Boolean(g.openSeat && !g.blackId && g.status === 'pending'), mode: g.position.mode, minutes: g.minutes, increment: g.increment, paused: Boolean(g.pausedUntil), legacy: !g.channelId }));
    });
  }
  async list(uid: string, serverId: string) {
    if (!await this.service.db.one('SELECT user_id FROM members WHERE server_id=? AND user_id=?', [serverId, uid])) fail(403, 'FORBIDDEN', 'Server membership required.');
    const rows = await this.service.db.all('SELECT state FROM chess_games WHERE server_id=? ORDER BY updated_at DESC LIMIT 30', [serverId]);
    return rows.map(r => JSON.parse(r.state) as ChessGame).map(({ id, whiteId, blackId, whiteName, blackName, status, position, minutes, increment, result }) => ({ id, whiteId, blackId, whiteName, blackName, status, mode: position.mode, minutes, increment, result }));
  }
  async create(uid: string, b: Create) {
    const result = await this.service.mutate(uid, b.requestId, 'chess.create', b, async tx => {
      if (await arcadeBusy(tx,uid)) fail(409,'CAPACITY','Finish or leave your existing game first.');
      if (b.channelId) {
        const channel = await this.requireVoice(tx, uid, b.channelId);
        if (channel.server_id !== b.serverId) fail(400, 'INVALID_REQUEST', 'The game must use your current voice channel.');
        if (await tx.one("SELECT id FROM chess_games WHERE white_id=? AND channel_id IS NOT NULL AND status<>'finished'", [uid])) fail(409, 'CAPACITY', 'Open your existing game or close it before creating another.');
      }
      const names = [];
      for (const userId of [uid, ...(b.opponentId ? [b.opponentId] : [])]) {
        const row = await tx.one('SELECT u.display_name FROM members m JOIN users u ON u.id=m.user_id JOIN servers s ON s.id=m.server_id WHERE m.server_id=? AND m.user_id=? AND u.banned=0 AND (u.guest=0 OR s.allow_guests=1)', [b.serverId, userId]);
        if (!row) fail(403, 'FORBIDDEN', 'Both players must belong to this server.'); names.push(row!.display_name);
      }
      if (b.opponentId === uid) fail(400, 'INVALID_REQUEST', 'Choose another player.');
      if (b.opponentId && await tx.one('SELECT user_id FROM user_blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)', [uid, b.opponentId, b.opponentId, uid])) fail(403, 'FORBIDDEN', 'This challenge is unavailable.');
      const active = await tx.one("SELECT COUNT(*) AS n FROM chess_games WHERE status='playing' AND (white_id=? OR black_id=?)", [uid, uid]);
      const pending = await tx.one("SELECT COUNT(*) AS n FROM chess_games WHERE status='pending' AND (white_id=? OR black_id=?)", [uid, uid]);
      const total = await tx.one("SELECT (SELECT COUNT(*) FROM chess_games WHERE status<>'finished')+(SELECT COUNT(*) FROM game_sessions WHERE status<>'finished') AS n");
      if (Number(active!.n) >= 1 || Number(pending!.n) >= 3 || Number(total!.n) >= 60) fail(409, 'CAPACITY', 'Finish your current game or pending challenges first.');
      const now = this.now(), g: ChessGame = { channelId: b.channelId || null, openSeat: Boolean(b.openSeat), id: randomUUID(), serverId: b.serverId, whiteId: uid, blackId: b.opponentId || null, whiteName: names[0], blackName: names[1] || (b.openSeat ? 'Open seat' : `${b.difficulty} AI`), difficulty: b.difficulty || null, status: b.opponentId || b.openSeat ? 'pending' : 'playing', position: initialPosition(b.mode), revision: 1, minutes: b.minutes, increment: b.increment, remaining: [b.minutes * 60000, b.minutes * 60000], runningSince: now, pausedUntil: 0, missing: [], missingAt: {}, grace: [30000, 30000], result: null, drawBy: null, createdAt: now, updatedAt: now, log: [] };
      await tx.run("DELETE FROM chess_games WHERE id IN (SELECT id FROM chess_games WHERE status='finished' ORDER BY updated_at DESC LIMIT 10000 OFFSET 999)");
      await this.save(tx, g); return { id: g.id };
    });
    await this.changed(result.id);
    if (b.channelId) await this.presence(uid, this.online(uid));
    return this.get(uid, result.id);
  }
  async command(uid: string, id: string, b: Command) {
    const result = await this.service.mutate(uid, b.requestId, 'chess.command', { id, ...b }, async tx => {
      const g = await this.load(tx, id); await this.allowed(tx, uid, g);
      const joining = b.kind === 'join' && g.openSeat && g.status === 'pending' && !g.blackId && uid !== g.whiteId;
      if (b.kind === 'join' && !joining) fail(409, 'SEAT_TAKEN', 'The seat is no longer open. You can keep watching.');
      if (!joining && uid !== g.whiteId && uid !== g.blackId) fail(403, 'FORBIDDEN', 'Spectators cannot change a match.');
      if (g.revision !== b.revision) fail(409, 'STALE_GAME', 'The board changed. Review the latest position.');
      const now = this.now(); this.expire(g, now);
      if (g.status === 'finished') fail(409, 'GAME_FINISHED', 'The match has ended.');
      if (g.channelId && !['resign', 'cancel'].includes(b.kind)) await this.requireVoice(tx, uid, g.channelId);
      if (g.status === 'pending') {
        if (joining) {
          if (g.pausedUntil) fail(409, 'PAUSED', 'Waiting for the host to return to voice.');
          await this.requireVoice(tx, g.whiteId, g.channelId!);
          if (await tx.one('SELECT user_id FROM user_blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)', [uid, g.whiteId, g.whiteId, uid])) fail(403, 'FORBIDDEN', 'This challenge is unavailable.');
          if (await arcadeBusy(tx,uid)||await arcadeBusy(tx,g.whiteId)) fail(409,'CAPACITY','A player already has an active game.');
          for (const player of [uid, g.whiteId]) if (await tx.one("SELECT id FROM chess_games WHERE id<>? AND (white_id=? OR black_id=?) AND (status='playing' OR (status='pending' AND channel_id IS NOT NULL))", [id, player, player])) fail(409, 'CAPACITY', 'A player already has an active match.');
          const user = await tx.one('SELECT display_name FROM users WHERE id=?', [uid]);
          g.blackId = uid; g.blackName = user!.display_name; g.openSeat = false; g.status = 'playing'; g.runningSince = now;
        } else if (b.kind === 'accept' && uid === g.blackId) {
          if (!this.online(g.whiteId) || !this.online(g.blackId!)) fail(409, 'OFFLINE', 'Both players must be online to start.');
          if (await arcadeBusy(tx,uid)||await arcadeBusy(tx,g.whiteId)) fail(409,'CAPACITY','A player already has an active game.');
          for (const player of [g.whiteId, g.blackId]) if (await tx.one("SELECT id FROM chess_games WHERE status='playing' AND (white_id=? OR black_id=?)", [player, player])) fail(409, 'CAPACITY', 'A player already has an active match.');
          g.status = 'playing'; g.runningSince = now;
        } else if ((b.kind === 'decline' && uid === g.blackId) || (b.kind === 'cancel' && uid === g.whiteId)) { g.status = 'finished'; g.result = 'Challenge cancelled'; }
        else fail(400, 'INVALID_REQUEST', 'Accept, decline or cancel this challenge first.');
      } else if (b.kind === 'resign') { g.status = 'finished'; g.result = winner(uid === g.whiteId ? 1 : 0, 'resignation'); }
      else {
        if (g.pausedUntil) fail(409, 'PAUSED', 'Waiting for reconnection.'); chargeClock(g, now);
        if (b.kind === 'action') {
          if ((g.position.turn === 0 ? g.whiteId : g.blackId) !== uid) fail(403, 'WRONG_TURN', 'Wait for your turn.');
          if (!b.action) fail(400, 'INVALID_REQUEST', 'Choose a move.');
          this.move(g, b.action!);
        } else if (b.kind === 'offerDraw') { if (g.drawBy) fail(409, 'DRAW_PENDING', 'A draw offer is already pending.'); g.drawBy = uid; }
        else if (b.kind === 'acceptDraw' && g.drawBy && g.drawBy !== uid) { g.status = 'finished'; g.result = 'Draw by agreement'; }
        else if (b.kind === 'declineDraw' && g.drawBy && g.drawBy !== uid) g.drawBy = null;
        else if (b.kind === 'claimDraw' && (g.position.turn === 0 ? g.whiteId : g.blackId) === uid && g.position.mode === 'standard' && (g.position.half >= 100 || repetitionCount(g.position) >= 3)) { g.status = 'finished'; g.result = 'Draw claimed by rule'; }
        else fail(400, 'INVALID_REQUEST', 'That match action is unavailable.');
      }
      g.revision++; await this.save(tx, g); return { id };
    });
    await this.changed(result.id);
    if (b.kind === 'join') await this.reconcileVoice();
    return this.get(uid, result.id);
  }
  private move(g: ChessGame, a: ChessAction) {
    const color = g.position.turn;
    try { g.position = applyAction(g.position, a); } catch { fail(400, 'ILLEGAL_MOVE', 'That move or purchase is not legal.'); }
    g.remaining[color] += g.increment * 1000; g.drawBy = null;
    g.log.push(a.buy ? `${a.buy.toUpperCase()} @ ${squareName(a.to)}` : `${squareName(a.from!)}–${squareName(a.to)}${a.promotion ? '=' + a.promotion.toUpperCase() : ''}`);
    const result = outcome(g.position); if (result) { g.status = 'finished'; g.result = result; }
  }
  private expire(g: ChessGame, now: number) {
    if (g.status === 'pending' && (now >= g.createdAt + (g.openSeat ? 600000 : 120000) || (g.pausedUntil && now >= g.pausedUntil))) { g.status = 'finished'; g.result = 'Challenge expired'; }
    if (g.status !== 'playing') return;
    if (g.pausedUntil && now >= g.pausedUntil) { g.status = 'finished'; g.result = g.missing.length > 1 ? 'Draw after both players disconnected' : winner(g.missing[0] === g.whiteId ? 1 : 0, 'disconnection'); }
    else chargeClock(g, now);
  }
  async presence(uid: string, online: boolean) {
    const ids = [...this.active.values()].filter(g => (g.status === 'playing' || (g.status === 'pending' && g.channelId)) && (g.whiteId === uid || g.blackId === uid)).map(g => g.id);
    for (const id of ids) {
      const changed = await this.service.db.transaction(async tx => {
        const row = await tx.one('SELECT state FROM chess_games WHERE id=?', [id]); if (!row) { this.active.delete(id); return false; }
        const g = JSON.parse(row.state) as ChessGame, now = this.now(); if (g.status === 'finished') return false;
        const present = online && (!g.channelId || Boolean(await tx.one('SELECT user_id FROM voice_members WHERE user_id=? AND channel_id=?', [uid, g.channelId])));
        this.expire(g, now); const color = uid === g.whiteId ? 0 : 1;
        if (present && g.missing.includes(uid)) { g.grace[color] = Math.max(0, g.grace[color] - (now - g.missingAt[uid])); g.missing = g.missing.filter(v => v !== uid); delete g.missingAt[uid]; }
        else if (!present && !g.missing.includes(uid)) { g.missing.push(uid); g.missingAt[uid] = now; }
        else return false;
        g.pausedUntil = g.missing.length ? Math.min(...g.missing.map(v => g.missingAt[v] + g.grace[v === g.whiteId ? 0 : 1])) : 0;
        if (!g.pausedUntil) g.runningSince = now;
        this.expire(g, now); g.revision++; await this.save(tx, g); return true;
      });
      if (changed) await this.changed(id);
    }
  }
  async reconcileVoice() {
    const games = [...this.active.values()].filter(g => g.channelId);
    if (!games.length) return;
    const voice = new Map((await this.service.db.all('SELECT user_id,channel_id FROM voice_members')).map(r => [r.user_id, r.channel_id]));
    for (const g of games) for (const uid of [g.whiteId, ...(g.blackId ? [g.blackId] : [])]) {
      const present = voice.get(uid) === g.channelId && this.online(uid);
      if (present === g.missing.includes(uid)) await this.presence(uid, present);
    }
  }
  private async changed(id: string) {
    if (this.closed) return;
    const row = await this.service.db.one('SELECT state FROM chess_games WHERE id=?', [id]);
    if (!row) { this.active.delete(id); this.schedule(); return; }
    const g = JSON.parse(row.state) as ChessGame;
    const previous = this.active.get(id);
    const directoryChanged = !previous || previous.status !== g.status || previous.blackId !== g.blackId || Boolean(previous.pausedUntil) !== Boolean(g.pausedUntil);
    if (g.status === 'finished') this.active.delete(id); else this.active.set(id, g);
    await this.notify(g, directoryChanged).catch(this.onError); this.schedule();
    if (g.status === 'playing' && !g.pausedUntil && g.difficulty && !g.blackId && g.position.turn === 1) setImmediate(() => { if (!this.closed) void this.bot(id, g.revision).catch(this.onError); });
  }
  private async bot(id: string, revision: number) {
    await this.service.db.transaction(async tx => {
      const g = await this.load(tx, id); if (g.revision !== revision || g.status !== 'playing' || g.pausedUntil || !g.difficulty || g.blackId || g.position.turn !== 1) return;
      const now = this.now(); this.expire(g, now);
      if (g.status === 'playing') { const a = chooseAi(g.position, g.difficulty!); if (a) { chargeClock(g, this.now()); if (g.status === 'playing') this.move(g, a); } }
      g.revision++; await this.save(tx, g);
    }); await this.changed(id);
  }
  private schedule() {
    clearTimeout(this.timer); if (this.closed || !this.active.size) return;
    const deadline = Math.min(...[...this.active.values()].map(g => g.status === 'pending' ? Math.min(g.createdAt + (g.openSeat ? 600000 : 120000), g.pausedUntil || Infinity) : g.pausedUntil || g.runningSince + g.remaining[g.position.turn]));
    this.timer = setTimeout(() => { void this.tick().catch(e => { this.onError(e); if (!this.closed) { this.timer = setTimeout(() => { this.schedule(); }, 1000); this.timer.unref(); } }); }, Math.max(1, Math.ceil(deadline - this.now()))); this.timer.unref();
  }
  async tick() {
    for (const id of [...this.active.keys()]) {
      const changed = await this.service.db.transaction(async tx => {
        const row = await tx.one('SELECT state FROM chess_games WHERE id=?', [id]); if (!row) { this.active.delete(id); return false; }
        const g = JSON.parse(row.state) as ChessGame; this.expire(g, this.now());
        if (g.status !== 'finished') return false; g.revision++; await this.save(tx, g); return true;
      }); if (changed) await this.changed(id);
    }
    this.schedule();
  }
}
