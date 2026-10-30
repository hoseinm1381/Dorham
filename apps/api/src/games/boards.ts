import type { GameSettings } from '../../../../packages/contracts/src/games';
import { insist, integer, shuffle, type Engine } from './common';
export function fourStart(now: number): Engine { return { phase: 'turn', deadline: now + 60000, result: null, board: Array(42).fill(-1), turn: 0, moves: 0 }; }
export function fourAction(s: Engine, seat: number, a: any, now: number) {
  insist(s.phase === 'turn' && seat === s.turn && a.type === 'drop'); const col = integer(a.column, 0, 6);
  let row = 5; while (row >= 0 && s.board[row * 7 + col] !== -1) row--; insist(row >= 0, 'That column is full.');
  const index = row * 7 + col; s.board[index] = seat; s.moves++; s.last=index;
  for (const [dx, dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
    const line = [index];
    for (const sign of [-1,1]) for (let d = 1; d < 4; d++) { const x = col + dx * d * sign, y = row + dy * d * sign; if (x < 0 || x > 6 || y < 0 || y > 5 || s.board[y*7+x] !== seat) break; line.push(y*7+x); }
    if (line.length >= 4) { s.result = `Player ${seat+1} wins`; s.phase = 'ended'; s.winner = seat; s.winning=line; }
  }
  if (!s.result && s.moves === 42) { s.result = 'Draw'; s.phase = 'ended'; }
  s.turn = 1-seat; s.deadline = s.result ? 0 : now+60000;
}
export const dominoTiles: [number,number][] = Array.from({length:7},(_,a)=>Array.from({length:7-a},(_,b)=>[a,a+b] as [number,number])).flat();
function dominoRound(s: Engine, n: number, now: number) {
  const deck = shuffle(Array.from({length:28},(_,i)=>i)); s.hands = Array.from({length:n},(_,i)=>s.active?.[i]===false?[]:deck.splice(0,7)); s.boneyard=deck; s.chain=[]; s.passes=0; s.phase='turn'; s.roundResult=null; s.opening=-1;
  dominoOpening(s);s.deadline=now+60000;s.round=(s.round||0)+1;
}
// Recompute the mandatory opener if its owner leaves before placing it.
export function dominoOpening(s:Engine){let best=-1,leader=0;s.opening=-1;s.hands.forEach((hand:number[],p:number)=>{if(s.active?.[p]===false)return;hand.forEach(t=>{const [a,b]=dominoTiles[t],weight=a===b?100+a:a+b;if(weight>best){best=weight;leader=p;s.opening=t;}});});s.turn=leader;s.passes=0;}
export function dominoStart(n:number,settings:GameSettings,now:number):Engine { const s:Engine={phase:'turn',deadline:0,result:null,scores:Array(n).fill(0),mode:settings.domino};dominoRound(s,n,now);return s; }
export function dominoLegal(s:Engine,seat:number) { const hand:number[]=s.hands[seat]||[]; if(!s.chain.length)return hand.filter(t=>t===s.opening).map(tile=>({tile,end:'right'})); const left=s.chain[0][0],right=s.chain.at(-1)[1];return hand.flatMap(tile=>{const pair=dominoTiles[tile];return [...(pair.includes(left)?[{tile,end:'left'}]:[]),...(pair.includes(right)?[{tile,end:'right'}]:[])];}); }
function dominoScore(s:Engine,now:number) {
  const sums=s.hands.map((h:number[])=>h.reduce((sum,t)=>sum+dominoTiles[t][0]+dominoTiles[t][1],0)),low=Math.min(...sums.filter((_:number,i:number)=>s.active?.[i]!==false)),winners=sums.map((v:number,i:number)=>v===low&&s.active?.[i]!==false?i:-1).filter((i:number)=>i>=0);
  s.roundResult=winners.length===1?`Player ${winners[0]+1} wins the round`:'Round drawn';
  if(winners.length===1)s.scores[winners[0]]+=sums.reduce((sum:number,v:number,i:number)=>sum+(i===winners[0]?0:v),0);
  if(winners.length===1&&s.scores[winners[0]]>=100){s.result=`Player ${winners[0]+1} wins`;s.phase='ended';}else s.phase='between';
  s.deadline=now+300000;
}
export function dominoAction(s:Engine,seat:number,a:any,now:number) {
  if(a.type==='next'){insist(s.phase==='between');dominoRound(s,s.hands.length,now);return;}
  insist(s.phase==='turn'&&seat===s.turn,'Wait for your turn.');
  const legal=dominoLegal(s,seat);
  if(a.type==='draw'){insist(s.mode==='draw'&&legal.length===0&&s.boneyard.length>0,'You must play an available tile.');s.hands[seat].push(s.boneyard.pop());s.deadline=now+60000;return;}
  if(a.type==='pass'){insist(legal.length===0&&(s.mode==='block'||s.boneyard.length===0),'Play or draw a tile first.');s.passes++;}
  else {insist(a.type==='tile');const tile=integer(a.tile,0,27);insist(legal.some(m=>m.tile===tile&&m.end===a.end),'That tile does not fit.');const pair=dominoTiles[tile].slice();if(s.chain.length){if(a.end==='left'){if(pair[1]!==s.chain[0][0])pair.reverse();}else if(pair[0]!==s.chain.at(-1)[1])pair.reverse();}if(a.end==='left')s.chain.unshift(pair);else s.chain.push(pair);s.hands[seat].splice(s.hands[seat].indexOf(tile),1);s.passes=0;}
  if(!s.hands[seat].length||s.passes>=(s.active?.filter(Boolean).length||s.hands.length))dominoScore(s,now);else{do{s.turn=(s.turn+1)%s.hands.length;}while(s.active?.[s.turn]===false);s.deadline=now+60000;}
}
export function dominoView(s:Engine,seat:number) {return {phase:s.phase,turn:s.turn,chain:s.chain,hand:seat>=0?s.hands[seat]:[],counts:s.hands.map((h:number[])=>h.length),boneyard:s.boneyard.length,scores:s.scores,round:s.round,roundResult:s.roundResult,legal:s.phase==='turn'&&seat===s.turn?dominoLegal(s,seat):[],mode:s.mode};}
export function ludoStart(n:number,now:number):Engine{return {phase:'roll',deadline:now+60000,result:null,tokens:Array.from({length:n},()=>[-1,-1,-1,-1]),turn:0,die:0,sixes:0,rolls:0};}
const ludoNext=(s:Engine,seat:number)=>{let p=seat;do{p=(p+1)%s.tokens.length;}while(s.active?.[p]===false);return p;};
export const ludoOffset=(s:Engine,seat:number)=>(s.tokens.length===2?seat*26:seat*13);
const safe = new Set([0,8,13,21,26,34,39,47]);
export const ludoLegal=(s:Engine)=>s.tokens[s.turn].flatMap((v:number,i:number)=>(v===-1?s.die===6:v<56&&v+s.die<=56)?[i]:[]);
export function ludoAction(s:Engine,seat:number,a:any,now:number,roll:()=>number) {
  insist(seat===s.turn,'Wait for your turn.');
  if(a.type==='roll'){
    insist(s.phase==='roll');s.die=roll();s.rolls++;s.sixes=s.die===6?s.sixes+1:0;
    if(s.sixes===3){s.turn=ludoNext(s,seat);s.sixes=0;s.phase='roll';}
    else if(ludoLegal(s).length)s.phase='move';else{s.turn=ludoNext(s,seat);s.sixes=0;}
  }else{
    insist(a.type==='token'&&s.phase==='move');const token=integer(a.piece,0,3);insist(ludoLegal(s).includes(token),'That token cannot move.');
    let value=s.tokens[seat][token];value=value===-1?0:value+s.die;s.tokens[seat][token]=value;
    if(value<51){const cell=(value+ludoOffset(s,seat))%52;if(!safe.has(cell))s.tokens.forEach((hand:number[],p:number)=>{if(p!==seat)hand.forEach((v,i)=>{if(v>=0&&v<51&&(v+ludoOffset(s,p))%52===cell)hand[i]=-1;});});}
    if(s.tokens[seat].every((v:number)=>v===56)){s.result=`Player ${seat+1} wins`;s.phase='ended';s.winner=seat;}
    else {s.phase='roll';if(s.die!==6){s.turn=ludoNext(s,seat);s.sixes=0;}}
  }
  s.deadline=s.result?0:now+60000;
}
