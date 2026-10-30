import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness } from './helpers';
import { ChessService } from '../apps/api/src/chess';
import type { ChessView } from '../packages/contracts/src/chess';
async function fixture() {
  const h=await harness(), a=await h.register('chess_white'), b=await h.register('chess_black'), spectator=await h.register('chess_watch'), outsider=await h.register('chess_outside');
  const server=(await h.api(a,'/servers',{name:'Chess test'})).json(); const invite=(await h.api(a,`/servers/${server.id}/invites`,{uses:10})).json();
  for(const u of [b,spectator]) await h.api(u,'/invites/join',{code:invite.code});
  const sa=await h.connect(a), sb=await h.connect(b);
  const create=async (mode='standard') => (await h.api(a,'/chess',{serverId:server.id,opponentId:b.id,mode,minutes:3,increment:2})).json() as ChessView;
  const command=async (u:typeof a,g:ChessView,kind:string,action?:any,requestId?:string) => h.api(u,`/chess/${g.id}`,{revision:g.revision,kind,...(action?{action}:{}),...(requestId?{requestId}:{})});
  return {h,a,b,spectator,outsider,server,sa,sb,create,command};
}
it('authorizes challenges and spectators, validates all actions and atomically deduplicates moves',async()=>{
  const {h,a,b,spectator,outsider,server,create,command}=await fixture();
  try {
    let g=await create(); expect(g.status).toBe('pending'); expect(g.actions).toHaveLength(0);
    expect((await h.api(outsider,`/chess/${g.id}`)).statusCode).toBe(403);
    expect((await h.api(outsider,`/chess?serverId=${server.id}`)).statusCode).toBe(403);
    expect((await command(a,g,'accept')).statusCode).toBe(400);
    g=(await command(b,g,'accept')).json(); expect(g.status).toBe('playing');
    const watch=(await h.api(spectator,`/chess/${g.id}`)).json(); expect(watch.actions).toHaveLength(0);
    expect((await command(spectator,g,'action',{from:52,to:36})).statusCode).toBe(403);
    expect((await command(b,g,'action',{from:12,to:28})).statusCode).toBe(403);
    expect((await command(a,g,'action',{from:52,to:28})).statusCode).toBe(400);
    const rid=randomUUID(), original=g;
    g=(await command(a,g,'action',{from:52,to:36},rid)).json(); expect(g.position.board[36]).toBe('P'); expect(g.position.turn).toBe(1);
    const replay=(await command(a,original,'action',{from:52,to:36},rid)).json(); expect(replay.revision).toBe(g.revision); expect(replay.log).toHaveLength(1);
    expect((await command(a,original,'action',{from:51,to:35},rid)).statusCode).toBe(409);
    expect((await command(a,original,'resign')).statusCode).toBe(409);
    await h.api(a,`/servers/${server.id}/members/${spectator.id}`,{remove:true},'PATCH'); expect((await h.api(spectator,`/chess/${g.id}`)).statusCode).toBe(403);
  } finally {await h.close();}
});
it('uses exact elapsed server time and increments; pauses with a bounded total reconnection budget',async()=>{
  const {h,a,b,create,command}=await fixture();
  try {
    let time=Date.now(); h.chess.now=()=>time; let g=await create(); g=(await command(b,g,'accept')).json();
    time+=7523; const va=(await h.api(a,`/chess/${g.id}`)).json(), vb=(await h.api(b,`/chess/${g.id}`)).json(); expect(va.remaining).toEqual(vb.remaining); expect(va.remaining[0]).toBe(172477);
    g=(await command(a,g,'action',{from:52,to:36})).json(); expect(g.remaining[0]).toBe(174477);
    time+=1000; await h.chess.presence(b.id,false); g=await h.chess.get(a.id,g.id); expect(g.pausedUntil).toBe(time+30000); expect(g.remaining[1]).toBe(179000);
    time+=12000; await h.chess.presence(b.id,true); g=await h.chess.get(a.id,g.id); expect(g.pausedUntil).toBe(0); expect(g.remaining[1]).toBe(179000); expect(g.grace[1]).toBe(18000);
    time+=500; await h.chess.presence(b.id,false); g=await h.chess.get(a.id,g.id); expect(g.pausedUntil).toBe(time+18000);
    time+=18001; await h.chess.tick(); g=await h.chess.get(a.id,g.id); expect(g.result).toBe('White wins by disconnection');
  }finally{await h.close();}
});
it('expires challenges and clocks without polling and restores games paused on server restart',async()=>{
  const {h,a,b,create,command}=await fixture();let restarted:ChessService|undefined;
  try{
    let time=Date.now();h.chess.now=()=>time;let g=await create();time+=120001;await h.chess.tick();expect((await h.chess.get(a.id,g.id)).result).toBe('Challenge expired');
    g=await create();g=(await command(b,g,'accept')).json();time+=180001;await h.chess.tick();expect((await h.chess.get(a.id,g.id)).result).toBe('Black wins by timeout');
    g=await create();g=(await command(b,g,'accept')).json();h.chess.close();restarted=new ChessService(h.service);restarted.now=()=>time;await restarted.initialize();const restored=await restarted.get(a.id,g.id);expect(restored.pausedUntil).toBe(time+30000);expect(restored.position).toEqual(g.position);expect(restored.remaining).toEqual(g.remaining);
    await restarted.presence(a.id,true);await restarted.presence(b.id,true);expect((await restarted.get(a.id,g.id)).pausedUntil).toBe(0);
  }finally{restarted?.close();await h.close();}
});
it('supports Elixer, draw consent, blocked challenges and disables Expert at the API',async()=>{
  const {h,a,b,server,create,command}=await fixture();
  try{
    expect((await h.api(a,'/chess',{serverId:server.id,difficulty:'Expert',mode:'elixer',minutes:3,increment:0})).statusCode).toBe(400);
    let g=await create('elixer');g=(await command(b,g,'accept')).json();expect(g.position.board.filter(Boolean)).toHaveLength(2);
    expect((await command(a,g,'action',{buy:'q',to:56})).statusCode).toBe(400);g=(await command(a,g,'action',{buy:'n',to:57})).json();expect(g.position.coins[0]).toBe(1);
    expect((await command(b,g,'acceptDraw')).statusCode).toBe(400);g=(await command(a,g,'offerDraw')).json();expect((await command(a,g,'acceptDraw')).statusCode).toBe(400);g=(await command(b,g,'acceptDraw')).json();expect(g.result).toBe('Draw by agreement');
    await h.db.run('INSERT INTO user_blocks(user_id,blocked_id) VALUES(?,?)',[b.id,a.id]);expect((await h.api(a,'/chess',{serverId:server.id,opponentId:b.id,mode:'standard',minutes:3,increment:0})).statusCode).toBe(403);
  }finally{await h.close();}
});
it('plays all three AI levels on the server and commits the reply as a legal next turn',async()=>{
  const {h,a,server}=await fixture();
  try{
    for(const difficulty of ['Easy','Medium','Hard']){
      let g=(await h.api(a,'/chess',{serverId:server.id,difficulty,mode:'elixer',minutes:3,increment:0})).json();
      g=(await h.api(a,`/chess/${g.id}`,{kind:'action',revision:g.revision,action:{buy:'n',to:57}})).json();
      for(let tries=0;tries<30&&g.position.ply<2;tries++){await new Promise(r=>setTimeout(r,10));g=(await h.api(a,`/chess/${g.id}`)).json();}
      expect(g.position.ply).toBe(2);expect(g.position.turn).toBe(0);expect(g.log).toHaveLength(2);
      expect((await h.api(a,`/chess/${g.id}`,{kind:'resign',revision:g.revision})).statusCode).toBe(200);
    }
  }finally{await h.close();}
});
