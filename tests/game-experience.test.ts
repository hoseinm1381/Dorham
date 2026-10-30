import { expect, it } from 'vitest';
import { act, depart, project, startEngine } from '../apps/api/src/games/engine';
import { dominoLegal } from '../apps/api/src/games/boards';
import type { GameSettings } from '../packages/contracts/src/games';
const settings:GameSettings={maxPlayers:8,seconds:60,rounds:1,language:'en',domino:'draw',chips:1000,blind:20};
const line={color:'#20232b',width:7,points:[[100,100],[200,200]]};
it('reassigns the mandatory domino opener after its owner leaves, without losing tiles',()=>{
  const s=startEngine('domino',4,settings,0),leader=s.turn,opening=s.opening;
  depart('domino',s,leader,settings,1);
  expect(s.active[s.turn]).toBe(true);expect(s.opening).not.toBe(opening);expect(dominoLegal(s,s.turn)).toHaveLength(1);
  act('domino',s,s.turn,{type:'tile',...dominoLegal(s,s.turn)[0]},settings,2);
  expect(s.chain).toHaveLength(1);expect(s.hands.flat().length+s.boneyard.length+s.chain.length).toBe(28);
});
it('does not reveal a drawing early when a successful guesser leaves',()=>{
  const s=startEngine('drawing',4,settings,0),token=s.token;
  act('drawing',s,1,{type:'guess',token,text:s.word},settings,100);
  depart('drawing',s,1,settings,200);
  act('drawing',s,2,{type:'guess',token,text:s.word},settings,300);
  expect(s.phase).toBe('drawing');expect(project('drawing',s,3).word).toBeNull();
  act('drawing',s,3,{type:'guess',token,text:s.word},settings,400);expect(s.phase).toBe('reveal');
});
it('reveals immediately once all remaining guessers are done after a departure',()=>{
  const s=startEngine('drawing',3,settings,0);
  act('drawing',s,1,{type:'guess',token:s.token,text:s.word},settings,100);
  depart('drawing',s,2,settings,200);expect(s.phase).toBe('reveal');expect(s.deadline).toBe(5200);
});
it('undoes only authorized drawings and restores the bounded ink budget',()=>{
  const s=startEngine('drawing',3,settings,0),token=s.token;
  act('drawing',s,0,{type:'stroke',token,stroke:line},settings,1);
  expect(()=>act('drawing',s,1,{type:'undo',token},settings,2)).toThrow();expect(s.picture.points).toBe(2);
  act('drawing',s,0,{type:'undo',token},settings,3);expect(s.picture).toEqual({points:0,strokes:[]});
  act('drawing',s,0,{type:'undo',token},settings,4);expect(s.picture.points).toBe(0);
  const phone=startEngine('telephone',3,settings,0);
  for(let p=0;p<3;p++)act('telephone',phone,p,{type:'submit',token:phone.token,text:'secret'},settings,1);
  act('telephone',phone,0,{type:'stroke',token:phone.token,stroke:line},settings,2);
  act('telephone',phone,1,{type:'undo',token:phone.token},settings,3);expect(phone.pictures[0].points).toBe(2);
  act('telephone',phone,0,{type:'undo',token:phone.token},settings,4);expect(phone.pictures[0].points).toBe(0);expect(project('telephone',phone,-1).picture).toBeNull();
});
it('identifies the actual winning line and final drop for horizontal, vertical and diagonal wins',()=>{
  for(const columns of [[0,1,0,1,0,1,0],[0,0,1,1,2,2,3],[0,1,1,2,4,2,2,3,4,3,5,3,3]]){
    const s=startEngine('four',2,settings,0);for(const column of columns)act('four',s,s.turn,{type:'drop',column},settings,1);
    const v=project('four',s,-1);expect(v.winning).toHaveLength(4);expect(v.winning).toContain(v.last);expect(v.winning.every((i:number)=>v.board[i]===s.winner)).toBe(true);
  }
});
it('shows only the actor’s hand category until a poker showdown',()=>{
  const s=startEngine('poker',3,settings,0);
  while(s.board.length===0){const v=project('poker',s,s.turn);act('poker',s,s.turn,{type:v.controls.canCheck?'check':'call'},settings,1);}
  expect(project('poker',s,-1).handRanks).toEqual([null,null,null]);
  const own=project('poker',s,1).handRanks;expect(own[0]).toBeNull();expect(typeof own[1]).toBe('number');expect(own[2]).toBeNull();
});
