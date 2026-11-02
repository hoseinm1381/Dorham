// Snapshot the historical TypeScript engines as an independent Go compatibility oracle.
// Seed randomness only inside this offline generator; production randomness is unchanged.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import {writeFileSync} from 'node:fs';
import type {GameSettings} from '../packages/contracts/src/games';
import {initialPosition,legalActions,advanceLegalAction,positionKey,outcome,inCheck,repetitionCount} from '../packages/contracts/src/chess';
import {startEngine,act,project,timeout,depart} from '../apps/api/src/games/engine';
import {dominoLegal,ludoAction} from '../apps/api/src/games/boards';
import {rankHand,pokerView} from '../apps/api/src/games/poker';
const crypto = createRequire(import.meta.url)('node:crypto');
let seed=11007;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
crypto.randomInt=(min:number,max?:number)=>{if(max===undefined){max=min;min=0;}return min+Math.floor(random()*(max-min));};syncBuiltinESMExports();Math.random=random;
const clone=(v:any)=>JSON.parse(JSON.stringify(v));
const settings:GameSettings={maxPlayers:8,seconds:60,rounds:2,language:'fa',domino:'draw',chips:1000,blind:20};
const fixtures:any={chess:[],transitions:[],views:[],ranks:[]};
for(const mode of ['standard','elixer'] as const)for(let sample=0;sample<4;sample++){
 let s=initialPosition(mode);
 for(let i=0;i<55;i++){
 const actions=legalActions(s);fixtures.chess.push({state:clone(s),actions,key:positionKey(s),outcome:outcome(s),check:inCheck(s),repetition:repetitionCount(s)});
 if(!actions.length)break;s=advanceLegalAction(s,actions[(i*13+sample*19)%actions.length]);
 }
}
function view(kind:any,s:any){for(let p=-1;p<(s.active?.length||0);p++)fixtures.views.push({kind,state:clone(s),seat:p,expected:clone(project(kind,s,p))});}
function change(kind:any,s:any,seat:number,a:any,now:number,type='action',roll=0){const before=clone(s);let error:string|null=null;try{if(type==='timeout')timeout(kind,s,settings,now);else if(type==='depart')depart(kind,s,seat,settings,now);else if(kind==='ludo'&&a.type==='roll')ludoAction(s,seat,a,now,()=>roll);else act(kind,s,seat,a,settings,now);}catch(e){error=(e as Error).message;}fixtures.transitions.push({kind,state:before,seat,action:a,now,type,roll,settings,expected:clone(s),error});view(kind,s);}
for(const kind of ['four','domino','ludo','poker','drawing','telephone','words'] as const){
 const n=kind==='words'?4:kind==='telephone'?4:kind==='four'?2:3;
 const s=startEngine(kind,n,settings,1000);view(kind,s);
 if(kind==='four'){for(const column of [0,1,0,1,0,1,0])change(kind,s,s.turn,{type:'drop',column},2000);}
 if(kind==='domino'){let i=0;while(s.phase==='turn'&&i++<180){const moves=dominoLegal(s,s.turn);const a=moves.length?{type:'tile',...moves[0]}:s.boneyard.length?{type:'draw'}:{type:'pass'};change(kind,s,s.turn,a,2000+i);}}
 if(kind==='ludo'){for(let i=0;i<100;i++){if(s.phase==='roll')change(kind,s,s.turn,{type:'roll'},2000+i,'action',i%3?6:1);else {const v=project(kind,s,s.turn);if(v.legal.length)change(kind,s,s.turn,{type:'token',piece:v.legal[0]},2000+i);}}}
 if(kind==='poker'){let i=0;while(s.phase==='betting'&&i++<100){const c=pokerView(s,s.turn).controls!;const a=c.canRaise&&i%5===0?{type:'raise',to:c.minRaise}:{type:c.canCheck?'check':i%11===0?'fold':'call'};change(kind,s,s.turn,a,2000+i);}}
 if(kind==='drawing'){for(let round=0;round<5;round++){change(kind,s,s.drawer,{type:'stroke',token:s.token,stroke:{color:'#e45b63',width:7,points:[[0,1000],[50,20]]}},2000);change(kind,s,s.drawer,{type:'undo',token:s.token},2001);change(kind,s,s.drawer,{type:'clear',token:s.token},2002);for(let p=0;p<n;p++)if(p!==s.drawer)change(kind,s,p,{type:'guess',token:s.token,text:s.word},3000);change(kind,s,0,{},s.deadline,'timeout');}}
 if(kind==='telephone'){for(let step=0;step<n;step++){for(let p=0;p<n;p++){if(s.phase==='draw')change(kind,s,p,{type:'stroke',token:s.token,stroke:{color:'#20232b',width:3,points:[[5,10]]}},2000);change(kind,s,p,{type:'submit',token:s.token,text:`secret-${step}-${p}`},3000);}}}
 if(kind==='words'){for(let i=0;i<6&&s.phase!=='ended';i++){const team=s.team;change(kind,s,s.captains[team],{type:'clue',text:'hint',count:2},2000);const index=s.roles.findIndex((r:number,j:number)=>r===team&&!s.revealed[j]);change(kind,s,team+2,{type:'word',index},3000);change(kind,s,team+2,{type:'pass'},4000);}}
 const d=startEngine(kind,n,settings,1000);change(kind,d,0,{},2000,'depart');change(kind,d,1,{},3000,'depart');
 const t=startEngine(kind,n,settings,1000);change(kind,t,0,{},61000,'timeout');
}
for(let i=0;i<400;i++){const deck=Array.from({length:52},(_,i)=>i).sort(()=>Math.random()-.5);const cards=deck.slice(0,5+i%3);fixtures.ranks.push({cards,expected:rankHand(cards)});}
writeFileSync('apps/api-go/internal/backend/games_contract_fixtures.json',JSON.stringify(fixtures));
console.log(Object.fromEntries(Object.entries(fixtures).map(([k,v])=>[k,(v as any[]).length])));
