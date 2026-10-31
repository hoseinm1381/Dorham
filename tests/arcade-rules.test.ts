import { expect, it } from 'vitest';
import { compareRank, pokerAction, pokerHand, pokerStart, pokerTimeout, pokerView, rankFive, rankHand } from '../apps/api/src/games/poker';
import { dominoAction, dominoLegal, dominoStart, dominoTiles, dominoView, fourAction, fourStart, ludoAction, ludoStart } from '../apps/api/src/games/boards';
import { act, depart, project, startEngine, timeout } from '../apps/api/src/games/engine';
import { normalizeAnswer, stroke, freshPicture } from '../apps/api/src/games/common';
import { definition, gameCatalog, playerLabel, type GameSettings, type GameKind } from '../packages/contracts/src/games';
const settings:GameSettings={maxPlayers:8,seconds:60,rounds:1,language:'en',domino:'draw',chips:1000,blind:20};
const card=(rank:number,suit=0)=>suit*13+rank-2;
it('has explicit seat limits for every catalog game, including existing Chess',()=>{
  expect(gameCatalog).toHaveLength(8);expect(new Set(gameCatalog.map(g=>g.id)).size).toBe(8);expect(definition('telephone')).toMatchObject({min:3,max:8});expect(definition('domino')).toMatchObject({min:2,max:4});expect(playerLabel(2,8)).toBe('2–8 players');expect(playerLabel(2,2)).toBe('2 players');
});
it('ranks poker categories, wheel straights, kickers and best five out of seven without suit tie-breaks',()=>{
  const categories=[
    [card(14),card(11,1),card(9,2),card(7,3),card(3)],
    [card(14),card(14,1),card(9,2),card(7,3),card(3)],
    [card(14),card(14,1),card(9,2),card(9,3),card(3)],
    [card(14),card(14,1),card(14,2),card(7,3),card(3)],
    [card(14),card(2,1),card(3,2),card(4,3),card(5)],
    [card(14),card(11),card(9),card(7),card(3)],
    [card(14),card(14,1),card(14,2),card(7,3),card(7)],
    [card(14),card(14,1),card(14,2),card(14,3),card(3)],
    [card(10),card(11),card(12),card(13),card(14)]
  ];categories.forEach((c,i)=>expect(rankFive(c)[0]).toBe(i));expect(rankFive(categories[4])).toEqual([4,5]);for(let i=1;i<9;i++)expect(compareRank(rankFive(categories[i]),rankFive(categories[i-1]))).toBeGreaterThan(0);
  expect(rankHand([...categories[8],card(2,1),card(2,2)])).toEqual([8,14]);expect(compareRank(rankFive(categories[8]),rankFive(categories[8].map(c=>c+13)))).toBe(0);
  expect(()=>rankHand([0,0,1,2,3])).toThrow();
});
it('runs hundreds of poker hands with legal betting, unique cards, redacted views and chip conservation',()=>{
  let hands=0;
  for(const n of [2,3,4,8])for(let sample=0;sample<25;sample++){
    const s=pokerStart(n,settings,0),total=n*settings.chips;for(let hand=0;hand<3&&s.phase!=='ended';hand++){
      if(s.phase==='between')pokerHand(s,hand*100000);let moves=0;
      while(s.phase==='betting'){
        expect(++moves).toBeLessThan(250);const p=s.turn,v=pokerView(s,p),c=v.controls!;
        expect(v.holes.filter((h:number[],i:number)=>i!==p).flat().every((x:number)=>x===-1)).toBe(true);expect(pokerView(s,-1).holes.flat().every((x:number)=>x===-1)).toBe(true);
        if(c.canRaise&&(moves+sample)%5===0)pokerAction(s,p,{type:'raise',to:Math.min(c.maxRaise,c.minRaise)},moves);else pokerAction(s,p,{type:c.canCheck?'check':(moves+sample)%11===0?'fold':'call'},moves);
        if(s.phase==='betting')expect(s.stack.reduce((a:number,b:number)=>a+b,0)+s.committed.reduce((a:number,b:number)=>a+b,0)).toBe(total);
      }
      expect(s.stack.reduce((a:number,b:number)=>a+b,0)).toBe(total);expect(s.stack.every((x:number)=>Number.isInteger(x)&&x>=0)).toBe(true);const cards=[...s.board,...s.holes.flat(),...s.deck];expect(new Set(cards).size).toBe(cards.length);hands++;
    }
  }expect(hands).toBeGreaterThan(200);
});
it('settles unequal all-ins into side pots, handles odd ties, and keeps folded cards hidden',()=>{
  const s=pokerStart(3,settings,0);s.stack=[100,200,500];s.dealer=-1;pokerHand(s,0);const starting=s.stack.reduce((a:number,b:number)=>a+b,0)+s.committed.reduce((a:number,b:number)=>a+b,0);
  while(s.phase==='betting'){const c=pokerView(s,s.turn).controls!;pokerAction(s,s.turn,{type:c.canRaise?'raise':c.canCheck?'check':'call',to:c.maxRaise},10);}
  expect(s.stack.reduce((a:number,b:number)=>a+b,0)).toBe(starting);expect(s.pots.some((p:any)=>p.amount===300)).toBe(true);expect(s.pots.some((p:any)=>p.amount===200)).toBe(true);
  const tied=pokerStart(3,settings,0);tied.board=[8,9,10,11,12];tied.deck=[];tied.holes=[[13,14],[15,16],[17,18]];tied.street=[0,0,0];tied.committed=[5,5,5];tied.stack=[995,995,995];tied.bet=0;tied.acted=[false,false,false];tied.turn=0;tied.folded=[false,false,true];
  pokerAction(tied,0,{type:'check'},1);pokerAction(tied,1,{type:'check'},2);expect(tied.payouts).toEqual([7,8,0]);expect(pokerView(tied,-1).holes[2]).toEqual([-1,-1]);
});
it('does not reopen raising after a short all-in, enforces minimum raises and heads-up order, and times out safely',()=>{
  const heads=pokerStart(2,settings,0);expect(heads.turn).toBe(heads.dealer);expect(()=>pokerAction(heads,heads.turn,{type:'check'},1)).toThrow();pokerAction(heads,heads.turn,{type:'call'},1);pokerAction(heads,heads.turn,{type:'check'},2);expect(heads.turn).toBe(1-heads.dealer);
  const s=pokerStart(3,settings,0);s.turn=0;s.street=[100,100,100];s.committed=[100,100,100];s.stack=[900,50,900];s.bet=100;s.lastRaise=100;s.acted=[true,false,false];s.reopen=[200,0,0];s.folded=[false,false,false];pokerAction(s,0,{type:'check'},1);pokerAction(s,1,{type:'raise',to:150},2);pokerAction(s,2,{type:'call'},3);expect(s.turn).toBe(0);expect(pokerView(s,0).controls?.canRaise).toBe(false);expect(()=>pokerAction(s,0,{type:'raise',to:300},4)).toThrow();pokerTimeout(s,5);expect(s.folded[0]).toBe(true);
  const short=pokerStart(3,settings,0);short.turn=0;short.board=short.deck.splice(-3);short.street=[0,0,0];short.committed=[0,0,0];short.stack=[5,900,900];short.bet=0;short.lastRaise=20;short.acted=[false,false,false];short.reopen=[0,0,0];short.folded=[false,false,false];pokerAction(short,0,{type:'raise',to:5},1);expect(pokerView(short,1).controls?.minRaise).toBe(20);pokerAction(short,1,{type:'raise',to:20},2);expect(short.bet).toBe(20);expect(short.lastRaise).toBe(20);
});
it('plays Draw and Block dominoes for 2–4 without duplicated tiles, leaks, illegal passes or stalled rounds',()=>{
  for(const mode of ['draw','block'] as const)for(const n of [2,3,4]){
    const s=dominoStart(n,{...settings,domino:mode},0);let moves=0;
    while(s.phase==='turn'){
      expect(++moves).toBeLessThan(200);const legal=dominoLegal(s,s.turn);if(legal.length){expect(()=>dominoAction(s,s.turn,{type:'pass'},moves)).toThrow();dominoAction(s,s.turn,{type:'tile',...legal[0]},moves);}else if(mode==='draw'&&s.boneyard.length)dominoAction(s,s.turn,{type:'draw'},moves);else dominoAction(s,s.turn,{type:'pass'},moves);
      const pairs=[...s.hands.flat(),...s.boneyard].map((i:number)=>dominoTiles[i].join(','));for(const pair of s.chain)pairs.push(pair.slice().sort((a:number,b:number)=>a-b).join(','));expect(pairs).toHaveLength(28);expect(new Set(pairs).size).toBe(28);
      expect(dominoView(s,-1).hand).toEqual([]);expect(dominoView(s,0)).not.toHaveProperty('hands');
    }expect(s.roundResult).toBeTruthy();if(s.phase==='between'){dominoAction(s,0,{type:'next'},1000);expect(s.round).toBe(2);}
  }
});
it('wins Four in a Row and enforces gravity, seat and column bounds',()=>{const s=fourStart(0);for(const c of [0,1,0,1,0,1,0])fourAction(s,s.turn,{type:'drop',column:c},1);expect(s.winner).toBe(0);expect(s.phase).toBe('ended');expect(s.board[35]).toBe(0);expect(()=>fourAction(fourStart(0),1,{type:'drop',column:0},1)).toThrow();expect(()=>fourAction(fourStart(0),0,{type:'drop',column:8},1)).toThrow();});
it('handles Ludo sixes, opposing seats, capture, safe squares and exact home finishes',()=>{
  let s=ludoStart(2,0);ludoAction(s,0,{type:'roll'},1,()=>5);expect(s.turn).toBe(1);ludoAction(s,1,{type:'roll'},2,()=>6);expect(s.phase).toBe('move');ludoAction(s,1,{type:'token',piece:0},3,()=>6);expect(s.tokens[1][0]).toBe(0);expect(s.turn).toBe(1);
  s=ludoStart(2,0);s.phase='move';s.tokens=[[9,-1,-1,-1],[36,-1,-1,-1]];s.die=1;ludoAction(s,0,{type:'token',piece:0},1,()=>1);expect(s.tokens[1][0]).toBe(-1);
  s=ludoStart(2,0);s.phase='move';s.tokens=[[6,-1,-1,-1],[34,-1,-1,-1]];s.die=2;ludoAction(s,0,{type:'token',piece:0},1,()=>2);expect(s.tokens[1][0]).toBe(34);
  s=ludoStart(2,0);s.phase='move';s.tokens[0]=[56,56,56,55];s.die=2;expect(()=>ludoAction(s,0,{type:'token',piece:3},1,()=>2)).toThrow();s.die=1;ludoAction(s,0,{type:'token',piece:3},1,()=>1);expect(s.result).toBe('Player 1 wins');
  s=ludoStart(2,0);s.tokens[0]=[0,-1,-1,-1];for(let i=0;i<2;i++){ludoAction(s,0,{type:'roll'},i,()=>6);ludoAction(s,0,{type:'token',piece:0},i,()=>6);}ludoAction(s,0,{type:'roll'},3,()=>6);expect(s.turn).toBe(1);
});
it('keeps telephone albums private, cycles every author once, and reveals complete chains after all steps',()=>{
  const s=startEngine('telephone',3,settings,0);for(let step=0;step<3;step++){
    for(let p=0;p<3;p++){const v=project('telephone',s,p),watch=project('telephone',s,-1);expect(watch).not.toHaveProperty('albums');expect(watch.previous).toBeNull();if(step===1){expect(v.previous.text).toContain('secret-');act('telephone',s,p,{type:'stroke',token:s.token,stroke:{color:'#20232b',width:3,points:[[1,2],[10,20]]}},settings,10);}else if(step===2)expect(v.previous.picture.points).toBe(2);act('telephone',s,p,{type:'submit',token:s.token,text:`secret-${step}-${p}`},settings,20);}
  }expect(s.phase).toBe('reveal');for(const album of project('telephone',s,-1).albums){expect(album).toHaveLength(3);expect(new Set(album.map((e:any)=>e.author)).size).toBe(3);}
});
it('bounds drawing payloads, rejects stale-phase strokes, normalizes Persian guesses and awards private answers safely',()=>{
  const picture=freshPicture();expect(()=>stroke(picture,{color:'url(evil)',width:3,points:[[1,2]]})).toThrow();for(let i=0;i<10;i++)stroke(picture,{color:'#20232b',width:3,points:Array.from({length:100},()=>[10,20])});expect(()=>stroke(picture,{color:'#20232b',width:3,points:[[1,2]]})).toThrow();expect(normalizeAnswer(' كليد‌ ')).toBe(normalizeAnswer('کلید'));
  const s=startEngine('drawing',3,settings,0);expect(project('drawing',s,-1).word).toBeNull();const token=s.token;act('drawing',s,1,{type:'guess',token,text:s.word},settings,1000);expect(project('drawing',s,1).word).toBe(s.word);expect(project('drawing',s,2).word).toBeNull();expect(s.guesses[0]).toEqual({seat:1,correct:true});act('drawing',s,2,{type:'guess',token,text:s.word},settings,2000);expect(s.phase).toBe('reveal');timeout('drawing',s,settings,7000);expect(()=>act('drawing',s,0,{type:'stroke',token,stroke:{}},settings,8000)).toThrow();
});
it('restricts word keys to captains, validates clue/guess roles, switches turns and resolves the danger card',()=>{
  const s=startEngine('words',4,settings,0),team=s.team,captain=s.captains[team],guesser=team+2;expect(project('words',s,-1).roles.every((r:any)=>r===null)).toBe(true);expect(project('words',s,captain).roles).toEqual(s.roles);expect(()=>act('words',s,guesser,{type:'clue',text:'hint',count:1},settings,1)).toThrow();expect(()=>act('words',s,captain,{type:'clue',text:s.board[0],count:1},settings,1)).toThrow();act('words',s,captain,{type:'clue',text:'hint',count:1},settings,1);expect(()=>act('words',s,captain,{type:'word',index:0},settings,2)).toThrow();const danger=s.roles.indexOf(3);act('words',s,guesser,{type:'word',index:danger},settings,2);expect(s.result).toBe(`Team ${2-team} wins`);
});
it('handles departures and phase deadlines without exposing hidden state or leaving abandoned turns',()=>{
  for(const kind of ['poker','domino','telephone','drawing','words','ludo','four'] as GameKind[]){const n=definition(kind).min,s=startEngine(kind,n,settings,0);depart(kind,s,0,settings,100);expect(s.active[0]).toBe(false);if(kind==='four'||kind==='ludo'||kind==='domino')expect(s.result).toBeTruthy();}
  const phone=startEngine('telephone',4,settings,0);depart('telephone',phone,3,settings,1);timeout('telephone',phone,settings,60000);expect(phone.step).toBe(1);expect(phone.done).toContain(3);expect(project('telephone',phone,-1).previous).toBeNull();
});
