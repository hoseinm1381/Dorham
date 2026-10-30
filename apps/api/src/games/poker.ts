import type { GameSettings } from '../../../../packages/contracts/src/games';
import { insist, integer, shuffle, type Engine } from './common';
// Original rules implementation. Cards are integers 0..51; suits never break ties.
export function rankFive(cards:number[]):number[] {
  const ranks=cards.map(c=>c%13+2).sort((a,b)=>b-a),counts=new Map<number,number>();for(const r of ranks)counts.set(r,(counts.get(r)||0)+1);
  const groups=[...counts].sort((a,b)=>b[1]-a[1]||b[0]-a[0]),flush=cards.every(c=>Math.floor(c/13)===Math.floor(cards[0]/13));
  const unique=[...new Set(ranks)],straight=unique.length===5?(unique[0]-unique[4]===4?unique[0]:unique.join(',')==='14,5,4,3,2'?5:0):0;
  if(flush&&straight)return [8,straight];
  if(groups[0][1]===4)return [7,groups[0][0],groups[1][0]];
  if(groups[0][1]===3&&groups[1][1]===2)return [6,groups[0][0],groups[1][0]];
  if(flush)return [5,...ranks];if(straight)return [4,straight];
  if(groups[0][1]===3)return [3,groups[0][0],...groups.slice(1).map(g=>g[0])];
  if(groups[0][1]===2&&groups[1][1]===2)return [2,Math.max(groups[0][0],groups[1][0]),Math.min(groups[0][0],groups[1][0]),groups[2][0]];
  if(groups[0][1]===2)return [1,groups[0][0],...groups.slice(1).map(g=>g[0])];return [0,...ranks];
}
export function compareRank(a:number[],b:number[]) { for(let i=0;i<Math.max(a.length,b.length);i++)if((a[i]||0)!==(b[i]||0))return (a[i]||0)-(b[i]||0);return 0; }
export function rankHand(cards:number[]) {insist(cards.length>=5&&cards.length<=7&&new Set(cards).size===cards.length);let best:number[]=[];for(let a=0;a<cards.length-4;a++)for(let b=a+1;b<cards.length-3;b++)for(let c=b+1;c<cards.length-2;c++)for(let d=c+1;d<cards.length-1;d++)for(let e=d+1;e<cards.length;e++){const rank=rankFive([cards[a],cards[b],cards[c],cards[d],cards[e]]);if(compareRank(rank,best)>0)best=rank;}return best;}
const live=(s:Engine)=>s.stack.map((chips:number,i:number)=>chips>0&&!s.departed[i]?i:-1).filter((i:number)=>i>=0);
const minimumRaise=(s:Engine)=>s.bet<s.blind?s.blind:s.bet+s.lastRaise;
function after(s:Engine,p:number,available:number[]):number {for(let i=1;i<=s.stack.length;i++){const q=(p+i)%s.stack.length;if(available.includes(q))return q;}return -1;}
function pay(s:Engine,p:number,amount:number) {const paid=Math.min(s.stack[p],amount);s.stack[p]-=paid;s.street[p]+=paid;s.committed[p]+=paid;}
function log(s:Engine,message:string){s.log.push(message);s.log=s.log.slice(-60);}
function finishHand(s:Engine,now:number,showdown:boolean) {
  const contenders=s.stack.map((_:number,i:number)=>!s.folded[i]?i:-1).filter((i:number)=>i>=0),levels=[...new Set<number>(s.committed)].filter(n=>n>0).sort((a,b)=>a-b);let previous=0;
  const payouts=Array(s.stack.length).fill(0),ranks=new Map<number,number[]>();if(showdown)for(const p of contenders)ranks.set(p,rankHand([...s.holes[p],...s.board]));
  const pots=[];
  for(const level of levels){const contributors=s.committed.map((n:number,i:number)=>n>=level?i:-1).filter((i:number)=>i>=0),amount=(level-previous)*contributors.length;previous=level;let eligible=contributors.filter((i:number)=>contenders.includes(i));
    // An uncalled overbet is returned, even if its player left during recovery.
    if(contributors.length===1){payouts[contributors[0]]+=amount;continue;}
    if(!eligible.length){for(const p of contributors)payouts[p]+=amount/contributors.length;continue;}
    if(showdown){let best=ranks.get(eligible[0])!;for(const p of eligible)if(compareRank(ranks.get(p)!,best)>0)best=ranks.get(p)!;eligible=eligible.filter((p:number)=>compareRank(ranks.get(p)!,best)===0);}
    const share=Math.floor(amount/eligible.length);for(const p of eligible)payouts[p]+=share;let odd=amount-share*eligible.length,p=s.dealer;while(odd--){p=after(s,p,eligible);payouts[p]++;}pots.push({amount,winners:eligible});
  }
  s.stack=s.stack.map((n:number,i:number)=>n+payouts[i]);s.payouts=payouts;s.pots=pots;s.showdown=showdown;s.phase='between';s.deadline=now+300000;s.turn=-1;s.handResult=payouts.map((v:number,i:number)=>v?`Player ${i+1}: +${v}`:'').filter(Boolean).join(' · ');
  if(live(s).length<=1){s.phase='ended';s.result=live(s).length?`Player ${live(s)[0]+1} wins`:'Table closed';s.deadline=0;}
}
function advance(s:Engine,now:number) {
  const contenders=s.stack.map((_:number,i:number)=>!s.folded[i]?i:-1).filter((i:number)=>i>=0);
  if(contenders.length<=1){finishHand(s,now,false);return;}
  const able=contenders.filter((i:number)=>s.stack[i]>0),needed=able.filter((i:number)=>!s.acted[i]||s.street[i]<s.bet);
  if(needed.length&&(able.length>1||s.street[able[0]]<s.bet)){s.turn=after(s,s.turn,needed);s.deadline=now+30000;return;}
  if(s.board.length===5){finishHand(s,now,true);return;}
  s.deck.pop(); // burn
  const count=s.board.length===0?3:1;for(let i=0;i<count;i++)s.board.push(s.deck.pop());
  s.street.fill(0);s.acted.fill(false);s.reopen.fill(0);s.bet=0;s.lastRaise=s.blind;
  if(able.length<=1){advance(s,now);return;}
  s.turn=after(s,s.dealer,able);s.deadline=now+30000;
}
export function pokerHand(s:Engine,now:number) {
  const seats=live(s);insist(seats.length>=2,'Two players with chips are required.');s.dealer=after(s,s.dealer,seats);s.hand=(s.hand||0)+1;s.deck=shuffle(Array.from({length:52},(_,i)=>i));s.holes=s.stack.map(()=>[]);s.board=[];s.folded=s.stack.map((chips:number,i:number)=>chips===0||s.departed[i]);s.street=s.stack.map(()=>0);s.committed=s.stack.map(()=>0);s.acted=s.stack.map(()=>false);s.reopen=s.stack.map(()=>0);s.log=[];s.pots=[];s.payouts=[];s.showdown=false;s.handResult=null;s.phase='betting';s.result=null;
  let p=s.dealer;for(let round=0;round<2;round++)for(let i=0;i<seats.length;i++){p=after(s,p,seats);s.holes[p].push(s.deck.pop());}
  const small=seats.length===2?s.dealer:after(s,s.dealer,seats),big=after(s,small,seats);pay(s,small,Math.floor(s.blind/2));pay(s,big,s.blind);s.bet=s.blind;s.lastRaise=s.blind;s.turn=big;s.deadline=now+30000;advance(s,now);
}
export function pokerStart(n:number,settings:GameSettings,now:number):Engine {const s:Engine={phase:'between',deadline:0,result:null,stack:Array(n).fill(settings.chips),departed:Array(n).fill(false),blind:settings.blind,dealer:-1,hand:0};pokerHand(s,now);return s;}
export function pokerJoin(s:Engine,settings:GameSettings,index=s.stack.length){insist(s.phase==='between');s.stack[index]=settings.chips;s.departed[index]=false;s.holes[index]=[];s.folded[index]=true;s.street[index]=0;s.committed[index]=0;s.acted[index]=false;s.reopen[index]=0;s.payouts[index]=0;}
export function pokerAction(s:Engine,seat:number,a:any,now:number) {
  if(a.type==='next'){insist(s.phase==='between');pokerHand(s,now);return;}
  insist(s.phase==='betting'&&s.turn===seat&&!s.folded[seat]&&s.stack[seat]>0,'Wait for your turn.');
  const owed=Math.max(0,s.bet-s.street[seat]);
  if(a.type==='fold'){s.folded[seat]=true;log(s,`Player ${seat+1} folded`);}
  else if(a.type==='check'){insist(owed===0,'Call or fold.');log(s,`Player ${seat+1} checked`);}
  else if(a.type==='call'){insist(owed>0,'You can check.');pay(s,seat,owed);log(s,`Player ${seat+1} called`);}
  else {insist(a.type==='raise');const to=integer(a.to,s.bet+1,s.street[seat]+s.stack[seat]);insist(!s.acted[seat]||s.bet>=s.reopen[seat],'A short all-in did not reopen raising.');const increase=s.bet<s.blind?to:to-s.bet,full=to>=minimumRaise(s);insist(full||to===s.street[seat]+s.stack[seat],'Raise at least the minimum, or go all-in.');pay(s,seat,to-s.street[seat]);s.bet=to;if(full){s.lastRaise=increase;s.acted.fill(false);}log(s,`Player ${seat+1} raised to ${to}`);}
  s.acted[seat]=true;s.reopen[seat]=s.bet+s.lastRaise;advance(s,now);
}
export function pokerView(s:Engine,seat:number) {
  const own=seat>=0,acting=own&&s.phase==='betting'&&s.turn===seat,call=acting?Math.max(0,s.bet-s.street[seat]):0;
  return {phase:s.phase,stack:s.stack,departed:s.departed,board:s.board,holes:s.holes.map((h:number[],i:number)=>i===seat||(s.showdown&&!s.folded[i])?h:h.map(()=>-1)),handRanks:s.holes.map((h:number[],i:number)=>h.length===2&&s.board.length>=3&&(i===seat||(s.showdown&&!s.folded[i]))?rankHand([...h,...s.board])[0]:null),folded:s.folded,street:s.street,committed:s.committed,dealer:s.dealer,turn:s.turn,hand:s.hand,blind:s.blind,bet:s.bet,pots:s.pots,payouts:s.payouts,handResult:s.handResult,log:s.log,
    controls:acting?{call:Math.min(call,s.stack[seat]),canCheck:call===0,canRaise:s.street[seat]+s.stack[seat]>s.bet&&(!s.acted[seat]||s.bet>=s.reopen[seat]),minRaise:minimumRaise(s),maxRaise:s.street[seat]+s.stack[seat]}:null};
}
export function pokerTimeout(s:Engine,now:number){pokerAction(s,s.turn,{type:s.street[s.turn]>=s.bet?'check':'fold'},now);}
export function pokerDepart(s:Engine,seat:number,now:number){s.departed[seat]=true;s.folded[seat]=true;if(s.phase==='betting'&&(s.turn===seat||s.folded.filter((v:boolean)=>!v).length<=1))advance(s,now);else if(s.phase==='between'&&live(s).length<2){s.phase='ended';s.result=live(s).length?`Player ${live(s)[0]+1} wins`:'Table closed';s.deadline=0;}}
