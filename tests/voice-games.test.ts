import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, event } from './helpers';
async function fixture() {
  const h=await harness(),a=await h.register('host_games'),b=await h.register('play_games'),c=await h.register('watch_games'),o=await h.register('outside_games');
  const server=(await h.api(a,'/servers',{name:'Voice games'})).json(),invite=(await h.api(a,`/servers/${server.id}/invites`,{uses:10})).json();
  for(const u of [b,c])await h.api(u,'/invites/join',{code:invite.code});
  const channel=(await h.api(a,'/bootstrap')).json().channels.find((v:any)=>v.kind==='voice'),other=(await h.api(a,`/servers/${server.id}/channels`,{name:'Other voice',kind:'voice'})).json();
  const [sa,sb,sc]=await Promise.all([h.connect(a),h.connect(b),h.connect(c)]);
  const join=async(s:typeof sa,id=channel.id)=>event(s,'voice:join',{channelId:id,eligible:true});
  const create=async(extra:any={})=>h.api(a,'/chess',{serverId:server.id,channelId:channel.id,openSeat:true,mode:'standard',minutes:5,increment:2,...extra});
  return {h,a,b,c,o,server,channel,other,sa,sb,sc,join,create};
}
it('advertises a voice-bound open seat and starts clocks only after atomic Play; spectators stay read-only',async()=>{
  const {h,a,b,c,o,channel,sa,sb,sc,join,create}=await fixture();
  try{
    expect((await create()).statusCode).toBe(403);await join(sa);await join(sb);await join(sc);
    let time=Date.now();h.chess.now=()=>time;const created=await create();expect(created.statusCode).toBe(200);let g=created.json();expect(g.status).toBe('pending');expect(g.blackName).toBe('Open seat');
    time+=20000;expect((await h.chess.get(a.id,g.id)).remaining).toEqual([300000,300000]);
    const directory=(await h.api(b,`/chess?channelId=${channel.id}`)).json().games;expect(directory[0]).toMatchObject({id:g.id,openSeat:true,channelId:channel.id});
    expect((await h.api(o,`/chess/${g.id}`)).statusCode).toBe(403);expect((await h.api(o,`/chess?channelId=${channel.id}`)).statusCode).toBe(403);
    expect((await h.chess.get(b.id,g.id)).canPlay).toBe(true);
    const rid=randomUUID(),body={kind:'join',revision:g.revision,requestId:rid};g=(await h.api(b,`/chess/${g.id}`,body)).json();expect(g.status).toBe('playing');expect(g.blackId).toBe(b.id);expect(g.remaining).toEqual([300000,300000]);
    expect((await h.db.one('SELECT black_id FROM chess_games WHERE id=?',[g.id]))!.black_id).toBe(b.id);
    expect((await h.api(b,`/chess/${g.id}`,body)).json().revision).toBe(g.revision);
    const spectator=await h.chess.get(c.id,g.id);expect(spectator.canPlay).toBe(false);expect(spectator.actions).toEqual([]);
    expect((await h.api(c,`/chess/${g.id}`,{kind:'action',revision:g.revision,action:{from:52,to:36}})).statusCode).toBe(403);
    time+=3750;g=(await h.api(a,`/chess/${g.id}`,{kind:'action',revision:g.revision,action:{from:52,to:36}})).json();expect(g.remaining[0]).toBe(298250);
    expect((await h.api(b,`/chess?channelId=${channel.id}`)).json().games[0].openSeat).toBe(false);
  }finally{await h.close();}
});
it('resolves simultaneous seat claims without overwriting a player or granting another seat',async()=>{
  const {h,b,c,sa,sb,sc,join,create}=await fixture();try{
    await join(sa);await join(sb);await join(sc);const g=(await create()).json();
    const responses=await Promise.all([b,c].map(u=>h.api(u,`/chess/${g.id}`,{kind:'join',revision:g.revision})));
    expect(responses.map(r=>r.statusCode).filter(n=>n===200)).toHaveLength(1);
    const saved=await h.chess.get(b.id,g.id);expect([b.id,c.id]).toContain(saved.blackId);expect(saved.revision).toBe(2);
  }finally{await h.close();}
});
it('requires the original voice channel, pauses on channel moves, resumes with grace, and closes a departed host lobby',async()=>{
  const {h,a,b,c,channel,other,sa,sb,sc,join,create}=await fixture();try{
    await join(sa);await join(sb);await join(sc);let time=Date.now();h.chess.now=()=>time;let g=(await create()).json();g=(await h.api(b,`/chess/${g.id}`,{kind:'join',revision:g.revision})).json();
    await join(sc,other.id);expect((await h.api(c,`/chess/${g.id}`)).statusCode).toBe(403);expect((await h.api(c,`/chess?channelId=${channel.id}`)).statusCode).toBe(403);
    await join(sa,other.id);g=await h.chess.get(a.id,g.id);expect(g.pausedUntil).toBe(time+30000);expect(g.actions).toEqual([]);
    expect((await h.api(a,`/chess/${g.id}`,{kind:'action',revision:g.revision,action:{from:52,to:36}})).statusCode).toBe(403);
    time+=9000;await join(sa);g=await h.chess.get(a.id,g.id);expect(g.pausedUntil).toBe(0);expect(g.grace[0]).toBe(21000);
    g=(await h.api(a,`/chess/${g.id}`,{kind:'resign',revision:g.revision})).json();expect(g.status).toBe('finished');expect((await h.api(b,`/chess?channelId=${channel.id}`)).json().games).toEqual([]);
    g=(await create()).json();await event(sa,'voice:leave',{requestId:randomUUID()});time+=30001;await h.chess.tick();expect((await h.chess.get(a.id,g.id)).status).toBe('finished');
  }finally{await h.close();}
});
it('prevents duplicate hosted games and blocked joins while preserving existing server games',async()=>{
  const {h,a,b,c,server,channel,sa,sb,sc,join,create}=await fixture();try{
    await join(sa);await join(sb);await join(sc);const body={requestId:randomUUID()};const g=(await create(body)).json();expect((await create(body)).json().id).toBe(g.id);expect((await create()).statusCode).toBe(409);
    await h.db.run('INSERT INTO user_blocks(user_id,blocked_id) VALUES(?,?)',[a.id,b.id]);expect((await h.api(b,`/chess/${g.id}`,{kind:'join',revision:g.revision})).statusCode).toBe(403);
    await h.api(a,`/chess/${g.id}`,{kind:'cancel',revision:g.revision});
    await h.db.run('DELETE FROM user_blocks WHERE user_id=? AND blocked_id=?',[a.id,b.id]);
    const legacy=(await h.api(a,'/chess',{serverId:server.id,opponentId:b.id,mode:'standard',minutes:5,increment:0})).json();
    expect((await h.api(a,`/chess?channelId=${channel.id}`)).json().games[0]).toMatchObject({id:legacy.id,legacy:true});
    expect((await h.api(c,`/chess?channelId=${channel.id}`)).json().games).toEqual([]);
  }finally{await h.close();}
});
