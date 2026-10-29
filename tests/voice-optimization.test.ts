import { it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TrackSource } from 'livekit-server-sdk';
import { SingleFlight } from '../apps/api/src/single-flight';
import { readSnapshot } from '../apps/api/src/read-snapshot';
import { Sfu } from '../apps/api/src/sfu';
import { harness, event } from './helpers';
import { VoiceInputState, matchesBinding, validBinding } from '../packages/contracts/src/voice-hotkeys';
import { waitForCondition } from '../packages/media/src/wait-condition';

it('coalesces concurrent work but reruns a mutation arriving during an active pass', async () => {
  let release!: () => void, passes = 0; const gate = new Promise<void>(resolve => { release = resolve; });
  const flight = new SingleFlight(async () => { passes++; if (passes === 1) await gate; });
  const a = flight.run(), b = flight.run(); await Promise.resolve(); expect(passes).toBe(1);
  const c = flight.run(); release(); await Promise.all([a,b,c]); expect(passes).toBe(2);
  const retry = new SingleFlight(vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined));
  await expect(retry.run()).rejects.toThrow('offline'); await expect(retry.run()).resolves.toBeUndefined();
});
it('shares reads only within one transaction and invalidates after writes', async () => {
  let value = 1; const read = vi.fn(async () => ({ value })); const tx: any = { all: async () => [], one: read, run: async () => { value++; } };
  const snapshot = readSnapshot(tx); await snapshot.one('select value'); await snapshot.one('select value'); expect(read).toHaveBeenCalledTimes(1);
  await snapshot.run('update value'); expect(await snapshot.one('select value')).toEqual({ value: 2 }); expect(read).toHaveBeenCalledTimes(2);
  await readSnapshot(tx).one('select value'); expect(read).toHaveBeenCalledTimes(3);
});
it('acknowledges completed passes without starving behind continuous new changes', async () => {
  const releases: (() => void)[] = []; let passes = 0;
  const flight = new SingleFlight(() => { passes++; return new Promise<void>(resolve => releases.push(resolve)); });
  const first = flight.run(); await Promise.resolve(); const second = flight.run(); releases.shift()!();
  await first; expect(passes).toBe(2); const third = flight.run(); releases.shift()!(); await second;
  expect(passes).toBe(3); releases.shift()!(); await third;
});
it('keeps voice snapshots private, returns lightweight SFU heartbeats, and only updates changed SFU grants', async () => {
  const h = await harness();
  try {
    const owner = await h.register('opt_owner'), member = await h.register('opt_member'), outsider = await h.register('opt_outsider');
    const server = (await h.api(owner,'/servers',{ name: 'Optimization' })).json(), invite = (await h.api(owner,`/servers/${server.id}/invites`,{})).json(); await h.api(member,'/invites/join',{ code: invite.code });
    const voice = (await h.api(owner,'/bootstrap')).json().channels.find((c:any)=>c.kind==='voice'), socket = await h.connect(member), joined = await event(socket,'voice:join',{channelId:voice.id,eligible:true});
    h.config.mediaTransport = 'livekit'; expect(await event(socket,'voice:heartbeat',{eligible:true})).toEqual({alive:true});
    const views = await h.service.voiceSnapshot([{socketId:socket.id!,userId:member.id,channelId:voice.id},{socketId:'outsider',userId:outsider.id,channelId:voice.id}]); expect(views[0].room?.members).toHaveLength(1); expect(views[1].directory).toEqual([]); expect(views[1].room).toBeNull();
    const permission = {canSubscribe:true,canPublish:true,canPublishSources:[TrackSource.MICROPHONE],canPublishData:false,canUpdateMetadata:false}; const participant = {identity:`${member.id}:${joined.epoch}`,permission};
    const update = vi.fn(async (_room, _identity, body) => { participant.permission = body.permission; }); const remove = vi.fn();
    const sfu = new Sfu({...h.config,mediaTransport:'mesh'},h.service); sfu.client = {listRooms:async()=>[{name:voice.id}],listParticipants:async()=>[participant],updateParticipant:update,removeParticipant:remove} as any;
    await sfu.synchronize(); await sfu.synchronize(); expect(update).toHaveBeenCalledTimes(0);
    await event(socket,'share:start',{requestId:randomUUID()}); await sfu.synchronize(); expect(update).toHaveBeenCalledTimes(1); expect(participant.permission.canPublishSources).toContain(TrackSource.SCREEN_SHARE);
    await sfu.synchronize(); expect(update).toHaveBeenCalledTimes(1);
    await h.api(owner,`/voice/${voice.id}/moderate`,{userId:member.id,action:'deafen'}); await sfu.synchronize(); expect(participant.permission).toMatchObject({canSubscribe:false}); expect(participant.permission.canPublishSources).not.toContain(TrackSource.MICROPHONE);
    await h.api(owner,`/voice/${voice.id}/moderate`,{userId:member.id,action:'kick'}); await sfu.synchronize(); expect(remove).toHaveBeenCalledTimes(1);
  } finally { await h.close(); }
});
it('push-to-talk and toggle modes fail closed and ignore key-repeat transitions', () => {
  const s = new VoiceInputState(); expect(s.muted).toBe(false); s.configure('push'); expect(s.muted).toBe(true); s.down(); expect(s.muted).toBe(false); s.down(); s.up(); expect(s.muted).toBe(true);
  s.down(); s.manual(); expect(s.muted).toBe(true); s.up(); s.manual(); expect(s.muted).toBe(true); s.down(); expect(s.muted).toBe(false); s.release(); expect(s.muted).toBe(true);
  s.configure('toggle'); s.down(); expect(s.muted).toBe(false); s.down(); expect(s.muted).toBe(false); s.up(); expect(s.muted).toBe(false); s.down(); expect(s.muted).toBe(true); s.up(); s.down(); s.release(); expect(s.muted).toBe(true);
  const binding = {code:'KeyV',ctrl:true,shift:true,alt:false}; expect(validBinding(binding)).toBe(true); expect(validBinding({...binding,code:'__proto__'})).toBe(false); expect(validBinding({...binding,code:'F4',alt:true})).toBe(false);
  expect(matchesBinding(binding,{code:'KeyV',ctrlKey:true,shiftKey:true,altKey:false,metaKey:false})).toBe(true); expect(matchesBinding(binding,{code:'KeyV',ctrlKey:true,shiftKey:false,altKey:false,metaKey:false})).toBe(false);
});
it('waits for asynchronous SFU publishing permission and cleans up on success, timeout and cancellation', async () => {
  let ready = false, check = () => {}; const unsubscribe = vi.fn(), subscribe = (listener: () => void) => { check = listener; return unsubscribe; };
  const controller = new AbortController(), waiting = waitForCondition(() => ready, subscribe, controller.signal);
  ready = true; check(); await waiting; expect(unsubscribe).toHaveBeenCalledTimes(1);
  await expect(waitForCondition(() => false, subscribe, controller.signal, 10)).rejects.toThrow('not confirmed'); expect(unsubscribe).toHaveBeenCalledTimes(2);
  const cancelled = waitForCondition(() => false, subscribe, controller.signal); controller.abort(); await expect(cancelled).rejects.toThrow('cancelled'); expect(unsubscribe).toHaveBeenCalledTimes(3);
});
