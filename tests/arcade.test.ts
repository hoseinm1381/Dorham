import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, event } from './helpers';
import { GameService } from '../apps/api/src/games/service';
import { definition, type GameKind, type GameView } from '../packages/contracts/src/games';
async function fixture(n=5){const h=await harness({maxOnline:20}),users:Awaited<ReturnType<typeof h.register>>[]=[];for(let i=0;i<n;i++)users.push(await h.register('arcade_'+i));const server=(await h.api(users[0],'/servers',{name:'Arcade test'})).json(),invite=(await h.api(users[0],`/servers/${server.id}/invites`,{uses:20})).json();for(const u of users.slice(1))await h.api(u,'/invites/join',{code:invite.code});const boot=(await h.api(users[0],'/bootstrap')).json(),channel=boot.channels.find((c:any)=>c.serverId===server.id&&c.kind==='voice'),other=(await h.api(users[0],`/servers/${server.id}/channels`,{name:'Other games',kind:'voice'})).json(),sockets=[];for(const u of users)sockets.push(await h.connect(u));for(const s of sockets)await event(s,'voice:join',{channelId:channel.id,eligible:true});
  const create=async(kind:GameKind,extra:any={})=>h.api(users[0],'/games',{channelId:channel.id,kind,settings:{maxPlayers:definition(kind).max},...extra});
  const command=async(p:number,g:GameView,kind:string,action?:any,requestId?:string)=>h.api(users[p],`/games/${g.id}`,{kind,revision:g.revision,...(action?{action}:{}),...(requestId?{requestId}:{})});
  return {h,users,server,channel,other,sockets,create,command};
}
it('creates, advertises, seats and starts all seven kinds with enforced capacities and read-only spectators',async()=>{
  for(const kind of ['poker','domino','telephone','drawing','words','ludo','four'] as GameKind[]){const {h,users,channel,create,command}=await fixture(9);try{
    let g=(await create(kind)).json() as GameView;expect(g.status).toBe('waiting');expect(g.players).toBe(1);expect((await create(kind)).statusCode).toBe(409);
    const listing=(await h.api(users[1],`/games?channelId=${channel.id}`)).json();expect(listing.games[0]).toMatchObject({kind,minPlayers:definition(kind).min,maxPlayers:definition(kind).max,players:1});expect(listing.games[0]).not.toHaveProperty('state');
    expect((await command(0,g,'start')).statusCode).toBe(409);
    for(let p=1;p<definition(kind).min;p++){const rid=randomUUID(),before=g,r=await command(p,g,'join',undefined,rid);expect(r.statusCode,r.body).toBe(200);g=r.json();expect((await command(p,before,'join',undefined,rid)).json().revision).toBe(g.revision);}
    const joined=g;expect((await command(1,g,'start')).statusCode).toBe(409);g=(await command(0,g,'start')).json();expect(g.status).toBe('playing');expect(g.self).toBe(0);
    const watcher=(await h.api(users[8],`/games/${g.id}`)).json();expect(watcher.self).toBe(-1);expect(watcher.canPlay).toBe(false);expect((await command(8,g,'action',{type:'drop',column:0})).statusCode).toBe(403);
    expect((await command(0,joined,'start')).statusCode).toBe(409);
    if(kind==='poker'){expect(watcher.state.holes.flat().every((c:number)=>c===-1)).toBe(true);expect(watcher.state).not.toHaveProperty('deck');expect(g.state.holes[0].every((c:number)=>c>=0)).toBe(true);}
    if(kind==='words')expect(watcher.state.roles.every((r:any)=>r===null)).toBe(true);
    if(kind==='telephone'){expect(watcher.state.previous).toBeNull();expect(watcher.state.picture).toBeNull();expect(watcher.state).not.toHaveProperty('albums');}
    if(kind==='domino'){expect(watcher.state.hand).toEqual([]);expect(watcher.state).not.toHaveProperty('hands');}
  }finally{await h.close();}}
});
it('atomically resolves the last seat, deduplicates actions, and prevents playing Chess and an arcade game simultaneously',async()=>{
  const {h,users,server,create,command}=await fixture();try{
    let g=(await create('four')).json();const claims=await Promise.all([command(1,g,'join'),command(2,g,'join')]);expect(claims.filter(r=>r.statusCode===200)).toHaveLength(1);expect(claims.filter(r=>r.statusCode===409)).toHaveLength(1);g=claims.find(r=>r.statusCode===200)!.json();
    expect((await h.api(users[0],'/chess',{serverId:server.id,difficulty:'Easy',mode:'standard',minutes:3,increment:0})).statusCode).toBe(409);
    g=(await command(0,g,'start')).json();const previous=g,rid=randomUUID();g=(await command(0,g,'action',{type:'drop',column:0},rid)).json();expect((await command(0,previous,'action',{type:'drop',column:0},rid)).json().state.board).toEqual(g.state.board);expect((await command(0,previous,'action',{type:'drop',column:1},rid)).statusCode).toBe(409);
    await command(0,g,'leave');const chess=(await h.api(users[0],'/chess',{serverId:server.id,difficulty:'Easy',mode:'standard',minutes:3,increment:0})).json();expect(chess.status).toBe('playing');expect((await create('four')).statusCode).toBe(409);
  }finally{await h.close();}
});
it('requires the original voice channel, enforces blocking and limits, and recovers the lobby after a host leaves',async()=>{
  const {h,users,channel,other,sockets,create,command}=await fixture();try{
    expect((await create('four',{settings:{maxPlayers:8}})).statusCode).toBe(400);let g=(await create('domino')).json();await h.db.run('INSERT INTO user_blocks(user_id,blocked_id) VALUES(?,?)',[users[0].id,users[1].id]);expect((await command(1,g,'join')).statusCode).toBe(403);await h.db.run('DELETE FROM user_blocks WHERE user_id=?',[users[0].id]);g=(await command(1,g,'join')).json();
    await event(sockets[2],'voice:join',{channelId:other.id,eligible:true});expect((await h.api(users[2],`/games/${g.id}`)).statusCode).toBe(403);expect((await h.api(users[2],`/games?channelId=${channel.id}`)).statusCode).toBe(403);
    expect((await command(2,g,'join')).statusCode).toBe(403);await command(0,g,'leave');g=(await h.api(users[1],`/games/${g.id}`)).json();expect(g.hostId).toBe(users[1].id);expect(g.players).toBe(1);
  }finally{await h.close();}
});
it('pauses with a total reconnect budget, shifts turn deadlines, forfeits expired seats and survives restart',async()=>{
  const {h,users,sockets,channel,other,create,command}=await fixture();try{
    let time=Date.now();h.games.now=()=>time;let g=(await create('four')).json();g=(await command(1,g,'join')).json();g=(await command(0,g,'start')).json();const deadline=g.deadline;time+=3000;await event(sockets[0],'voice:join',{channelId:other.id,eligible:true});g=await h.games.get(users[0].id,g.id);expect(g.pausedUntil).toBe(time+30000);expect((await command(0,g,'action',{type:'drop',column:0})).statusCode).toBe(403);
    time+=9000;await event(sockets[0],'voice:join',{channelId:channel.id,eligible:true});g=await h.games.get(users[0].id,g.id);expect(g.pausedUntil).toBe(0);expect(g.deadline).toBe(deadline+9000);expect(g.seats[0].grace).toBe(21000);
    h.games.close();const restarted=new GameService(h.service);restarted.now=()=>time;restarted.online=uid=>h.games.online(uid);await restarted.initialize();try{g=await restarted.get(users[0].id,g.id);expect(g.pausedUntil).toBe(time+21000);await restarted.reconcileVoice();g=await restarted.get(users[0].id,g.id);expect(g.pausedUntil).toBe(0);time+=100;await event(sockets[0],'voice:join',{channelId:other.id,eligible:true});await restarted.reconcileVoice();time+=21001;await restarted.tick();g=await restarted.get(users[1].id,g.id);expect(g.status).toBe('finished');expect(g.result).toContain('departure');}finally{restarted.close();}
  }finally{await h.close();}
});
it('expires waiting lobbies, permits poker seats only between hands, and removes only inactive players on grace expiry',async()=>{
  const {h,users,sockets,other,create,command}=await fixture();try{
    let time=Date.now();h.games.now=()=>time;let g=(await create('four')).json();time+=600001;await h.games.tick();expect((await h.games.get(users[0].id,g.id)).status).toBe('finished');g=(await create('poker')).json();g=(await command(1,g,'join')).json();g=(await command(2,g,'join')).json();g=(await command(0,g,'start')).json();expect((await command(3,g,'join')).statusCode).toBe(409);
    while(g.state.phase==='betting'){const seat=g.state.turn;g=(await command(seat,g,'action',{type:'fold'})).json();}
    expect(g.state.phase).toBe('between');g=(await command(3,g,'join')).json();expect(g.players).toBe(4);expect(g.state.stack).toHaveLength(4);g=(await command(0,g,'action',{type:'next'})).json();await event(sockets[1],'voice:join',{channelId:other.id,eligible:true});time+=30001;await h.games.tick();g=await h.games.get(users[0].id,g.id);expect(g.seats[1].left).toBe(true);expect(g.players).toBe(3);expect(g.status).toBe('playing');
  }finally{await h.close();}
});
it('accepts concurrent private telephone submissions and returns only each actor’s authorized projection',async()=>{
  const {h,users,create,command}=await fixture();try{let g=(await create('telephone')).json();g=(await command(1,g,'join')).json();g=(await command(2,g,'join')).json();g=(await command(0,g,'start')).json();const token=g.state.token;
    const replies=await Promise.all([0,1,2].map(p=>command(p,g,'action',{type:'submit',token,text:'private-'+p})));expect(replies.every(r=>r.statusCode===200)).toBe(true);g=await h.games.get(users[0].id,g.id);expect(g.state.step).toBe(1);const v=(await h.api(users[3],`/games/${g.id}`)).json();expect(JSON.stringify(v)).not.toContain('private-');expect(g.state.previous.text).toBe('private-2');expect((await command(0,g,'action',{type:'submit',token,text:'old'})).statusCode).toBe(400);
  }finally{await h.close();}
});
it('streams bounded canvas deltas only to authorized watchers and never broadcasts a private telephone drawing',async()=>{
  for(const kind of ['drawing','telephone'] as const){const {h,sockets,create,command}=await fixture();try{
    let g=(await create(kind)).json();for(let p=1;p<definition(kind).min;p++)g=(await command(p,g,'join')).json();g=(await command(0,g,'start')).json();
    if(kind==='telephone')for(let p=0;p<3;p++)g=(await command(p,g,'action',{type:'submit',token:g.state.token,text:'secret '+p})).json();
    for(const socket of sockets)await event(socket,'game:watch',{id:g.id});const received:any[][]=sockets.map(()=>[]);sockets.forEach((socket,i)=>socket.on('game:canvas',e=>received[i].push(e)));
    const rid=randomUUID(),before=g,stroke={type:'stroke',token:g.state.token,stroke:{color:'#20232b',width:7,points:[[12,20],[40,60]]}};const response=await command(0,g,'action',stroke,rid);expect(response.statusCode,response.body).toBe(200);g=response.json();await new Promise(r=>setTimeout(r,30));
    expect(received[0]).toHaveLength(1);expect(received[0][0]).toMatchObject({id:g.id,revision:g.revision,requestId:rid,type:'stroke'});expect(received[0][0]).not.toHaveProperty('word');
    for(const i of [1,2,3,4])expect(received[i]).toHaveLength(kind==='drawing'?1:0);
    await command(0,before,'action',stroke,rid);expect((await h.db.one('SELECT state FROM game_sessions WHERE id=?',[g.id]))!.state).toContain('"points":2');
    const undo=await command(0,g,'action',{type:'undo',token:g.state.token});expect(undo.statusCode,undo.body).toBe(200);g=undo.json();expect(g.state.picture.points).toBe(0);
    await event(sockets[4],'game:unwatch',{id:g.id});const count=received[4].length;await command(0,g,'action',{type:'clear',token:g.state.token});await new Promise(r=>setTimeout(r,30));expect(received[4]).toHaveLength(count);
  }finally{await h.close();}}
});
it('does not refund an already-used absence allowance when restarting during a pause',async()=>{
  const {h,users,sockets,other,create,command}=await fixture();try{let time=Date.now();h.games.now=()=>time;let g=(await create('four')).json();g=(await command(1,g,'join')).json();g=(await command(0,g,'start')).json();await event(sockets[0],'voice:join',{channelId:other.id,eligible:true});time+=12000;h.games.close();const restarted=new GameService(h.service);restarted.now=()=>time;restarted.online=uid=>users.some((u,i)=>u.id===uid&&sockets[i].connected);await restarted.initialize();try{g=await restarted.get(users[1].id,g.id);expect(g.seats[0].grace).toBe(18000);await restarted.reconcileVoice();time+=18001;await restarted.tick();expect((await restarted.get(users[1].id,g.id)).status).toBe('finished');}finally{restarted.close();}}finally{await h.close();}
});
it('supports eight-player telephone and drawing rounds, eight-player word teams, and full four-seat boards',async()=>{
  for(const kind of ['telephone','drawing','words','domino','ludo'] as const){const {h,users,create,command}=await fixture(9);try{
    let time=Date.now();h.games.now=()=>time;let g=(await create(kind)).json();const n=definition(kind).max;for(let p=1;p<n;p++)g=(await command(p,g,'join')).json();expect(g.players).toBe(n);expect((await h.games.get(users[8].id,g.id)).canPlay).toBe(false);g=(await command(0,g,'start')).json();
    if(kind==='telephone'){
      for(let step=0;step<8;step++){time+=1000;g=await h.games.get(users[0].id,g.id);const token=g.state.token;
        if(step%2)await Promise.all(Array.from({length:8},(_,p)=>command(p,g,'action',{type:'stroke',token,stroke:{color:'#20232b',width:3,points:[[p,step]]}})));
        const snapshot=await h.games.get(users[0].id,g.id);const replies=await Promise.all(Array.from({length:8},(_,p)=>command(p,snapshot,'action',{type:'submit',token,text:`sentence ${p} ${step}`})));expect(replies.every(r=>r.statusCode===200)).toBe(true);
      }g=await h.games.get(users[8].id,g.id);expect(g.status).toBe('finished');expect(g.state.albums).toHaveLength(8);for(const album of g.state.albums){expect(album).toHaveLength(8);expect(new Set(album.map((v:any)=>v.author)).size).toBe(8);}
    }else if(kind==='drawing'){
      for(let turn=0;turn<8;turn++){g=await h.games.get(users[turn].id,g.id);const token=g.state.token,word=g.state.word;expect(word).toBeTruthy();for(let p=0;p<8;p++)if(p!==turn){time+=100;g=(await command(p,g,'action',{type:'guess',token,text:word})).json();}expect(g.state.phase).toBe('reveal');time+=5001;await h.games.tick();}
      g=await h.games.get(users[8].id,g.id);expect(g.status).toBe('finished');expect(g.state.scores.every((v:number)=>v>0)).toBe(true);
    }else if(kind==='words'){
      const team=g.state.team,captain=team,guesser=team+2;g=(await command(captain,g,'action',{type:'clue',text:'sharedhint',count:9})).json();const key=await h.games.get(users[captain].id,g.id),indices=key.state.roles.flatMap((r:number,i:number)=>r===team?[i]:[]);for(const index of indices){time+=1000;g=(await command(guesser,g,'action',{type:'word',index})).json();}expect(g.status).toBe('finished');expect(g.result).toBe(`Team ${team+1} wins`);
    }else {expect(g.state[kind==='ludo'?'tokens':'counts']).toHaveLength(4);expect(g.players).toBe(4);}
  }finally{await h.close();}}
});
