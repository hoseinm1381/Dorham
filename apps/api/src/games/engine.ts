import { randomInt } from 'node:crypto';
import type { GameKind, GameSettings } from '../../../../packages/contracts/src/games';
import { insist, type Engine } from './common';
import { dominoStart, dominoAction, dominoView, fourStart, fourAction, ludoStart, ludoAction, ludoLegal, ludoOffset } from './boards';
import { pokerStart, pokerAction, pokerView, pokerTimeout, pokerDepart } from './poker';
import { drawingStart, drawingAction, drawingTick, drawingView, phoneStart, phoneAction, phoneTick, phoneView, wordsStart, wordsAction, wordsTick, wordsView } from './party';
export function startEngine(kind:GameKind,n:number,settings:GameSettings,now:number):Engine {
  const state=kind==='poker'?pokerStart(n,settings,now):kind==='domino'?dominoStart(n,settings,now):kind==='four'?fourStart(now):kind==='ludo'?ludoStart(n,now):kind==='drawing'?drawingStart(n,settings,now):kind==='telephone'?phoneStart(n,settings,now):wordsStart(n,settings,now);
  state.active=Array(n).fill(true);return state;
}
export function act(kind:GameKind,s:Engine,seat:number,a:any,settings:GameSettings,now:number) {
  insist(a&&typeof a.type==='string');
  if(kind==='poker')pokerAction(s,seat,a,now);else if(kind==='domino')dominoAction(s,seat,a,now);else if(kind==='four')fourAction(s,seat,a,now);else if(kind==='ludo')ludoAction(s,seat,a,now,()=>randomInt(1,7));else if(kind==='drawing')drawingAction(s,seat,a,settings,now);else if(kind==='telephone')phoneAction(s,seat,a,settings,now);else wordsAction(s,seat,a,settings,now);
}
export function project(kind:GameKind,s:Engine,seat:number):Record<string,any> {
  if(kind==='poker')return pokerView(s,seat);if(kind==='domino')return dominoView(s,seat);if(kind==='drawing')return drawingView(s,seat);if(kind==='telephone')return phoneView(s,seat);if(kind==='words')return wordsView(s,seat);
  if(kind==='four')return {phase:s.phase,board:s.board,turn:s.turn,winner:s.winner};
  return {phase:s.phase,tokens:s.tokens,turn:s.turn,die:s.die,offsets:s.tokens.map((_:any,i:number)=>ludoOffset(s,i)),legal:seat===s.turn&&s.phase==='move'?ludoLegal(s):[]};
}
export function timeout(kind:GameKind,s:Engine,settings:GameSettings,now:number) {
  if(kind==='drawing')drawingTick(s,settings,now);else if(kind==='telephone')phoneTick(s,settings,now);else if(kind==='words')wordsTick(s,settings,now);else if(kind==='poker'&&s.phase==='betting')pokerTimeout(s,now);
  else {s.phase='ended';s.result='Game ended after inactivity';s.deadline=0;}
}
export function depart(kind:GameKind,s:Engine,seat:number,settings:GameSettings,now:number) {
  s.active[seat]=false;const remaining:number[]=s.active.flatMap((v:boolean,i:number)=>v?[i]:[]);
  if(kind==='poker'){pokerDepart(s,seat,now);return;}
  if(remaining.length<2){s.phase='ended';s.result=remaining.length?`Player ${remaining[0]+1} wins by departure`:'Game closed';s.deadline=0;return;}
  if(kind==='drawing'){if(s.drawer===seat&&s.phase==='drawing')drawingTick(s,settings,now);}
  else if(kind==='telephone'){if(!s.done.includes(seat))s.done.push(seat);if(s.done.length===s.albums.length)phoneTick(s,settings,now);}
  else if(kind==='words'){
    const team=seat%2,teamSeats=remaining.filter(i=>i%2===team);if(teamSeats.length<2){s.phase='ended';s.result=`Team ${2-team} wins by departure`;s.deadline=0;}else if(s.captains[team]===seat)s.captains[team]=teamSeats[0];
  }else if(kind==='domino'){s.boneyard.push(...s.hands[seat]);s.hands[seat]=[];if(s.turn===seat){s.turn=remaining.find(i=>i>seat)??remaining[0];s.deadline=now+60000;}}
  else if(kind==='ludo'){s.tokens[seat]=[-1,-1,-1,-1];if(s.turn===seat){s.turn=remaining.find(i=>i>seat)??remaining[0];s.phase='roll';s.sixes=0;s.deadline=now+60000;}}
}
