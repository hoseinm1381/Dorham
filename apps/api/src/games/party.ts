import type { GameSettings, Picture } from '../../../../packages/contracts/src/games';
import { freshPicture, insist, integer, normalizeAnswer, shuffle, stroke, text, words, type Engine } from './common';
function drawingTurn(s:Engine,settings:GameSettings,now:number) {
  while(s.round<s.order.length&&s.active?.[s.order[s.round]]===false)s.round++;
  if(s.round>=s.order.length){s.phase='ended';s.result='Drawing rounds complete';s.deadline=0;return;}
  s.drawer=s.order[s.round];s.word=s.words[s.round%s.words.length];s.picture=freshPicture();s.guessed=[];s.guesses=[];s.phase='drawing';s.token=`draw-${s.round}`;s.started=now;s.deadline=now+settings.seconds*1000;
}
export function drawingStart(n:number,settings:GameSettings,now:number):Engine {const s:Engine={phase:'drawing',deadline:0,result:null,round:0,order:Array.from({length:settings.rounds},()=>Array.from({length:n},(_,i)=>i)).flat(),words:words(settings),scores:Array(n).fill(0)};drawingTurn(s,settings,now);return s;}
function drawingReveal(s:Engine,now:number){s.phase='reveal';s.token=`reveal-${s.round}`;s.deadline=now+5000;}
export function drawingAction(s:Engine,seat:number,a:any,settings:GameSettings,now:number) {
  insist(s.phase==='drawing'&&a.token===s.token,'The drawing round has changed.');
  if(a.type==='stroke'||a.type==='clear'){insist(seat===s.drawer,'Only the drawer can draw.');if(a.type==='clear')s.picture=freshPicture();else stroke(s.picture,a.stroke);}
  else {insist(a.type==='guess'&&seat!==s.drawer&&!s.guessed.includes(seat),'Wait for the next drawing.');const answer=text(a.text,80),correct=normalizeAnswer(answer)===normalizeAnswer(s.word);if(correct){s.guessed.push(seat);s.scores[seat]+=Math.max(20,100-Math.floor((now-s.started)/1000));s.scores[s.drawer]+=10;s.guesses.push({seat,correct:true});if(s.guessed.length===(s.active?.filter(Boolean).length||s.scores.length)-1)drawingReveal(s,now);}else s.guesses.push({seat,text:answer,correct:false});s.guesses=s.guesses.slice(-30);}
}
export function drawingTick(s:Engine,settings:GameSettings,now:number){if(s.phase==='drawing')drawingReveal(s,now);else if(s.phase==='reveal'){s.round++;drawingTurn(s,settings,now);}}
export function drawingView(s:Engine,seat:number){const reveal=s.phase!=='drawing'||seat===s.drawer||s.guessed.includes(seat);return {phase:s.phase,token:s.token,round:s.round+1,total:s.order.length,drawer:s.drawer,word:reveal?s.word:null,wordLength:Array.from(s.word).length,picture:s.picture,scores:s.scores,guesses:s.guesses,guessed:s.guessed};}
type Entry = {author:number;type:'text';text:string}|{author:number;type:'picture';picture:Picture};
function phoneAdvance(s:Engine,settings:GameSettings,now:number) {
  const n=s.albums.length;
  for(let seat=0;seat<n;seat++) {
    const chain=(seat-s.step+n)%n;
    const entry:Entry=s.step%2?{author:seat,type:'picture',picture:s.pictures[seat]}:{author:seat,type:'text',text:s.answers[seat]||'…'};
    s.albums[chain].push(entry);
  }
  s.step++;s.done=Array.from({length:n},(_,i)=>s.active?.[i]===false?i:-1).filter(i=>i>=0);s.answers={};s.pictures=Array.from({length:n},freshPicture);
  if(s.step>=n){s.phase='reveal';s.deadline=0;s.result='Albums ready';}else{s.phase=s.step%2?'draw':'describe';s.token=`phone-${s.step}`;s.deadline=now+settings.seconds*1000;}
}
export function phoneStart(n:number,settings:GameSettings,now:number):Engine{return {phase:'write',deadline:now+settings.seconds*1000,result:null,step:0,token:'phone-0',albums:Array.from({length:n},()=>[]),done:[],answers:{},pictures:Array.from({length:n},freshPicture)};}
export function phoneAction(s:Engine,seat:number,a:any,settings:GameSettings,now:number) {
  insist(s.phase!=='reveal'&&a.token===s.token&&!s.done.includes(seat),'This page has already been submitted.');
  if(a.type==='stroke'||a.type==='clear'){insist(s.phase==='draw');if(a.type==='clear')s.pictures[seat]=freshPicture();else stroke(s.pictures[seat],a.stroke);}
  else {insist(a.type==='submit');if(s.phase!=='draw')s.answers[seat]=text(a.text);s.done.push(seat);if(s.done.length===s.albums.length)phoneAdvance(s,settings,now);}
}
export function phoneTick(s:Engine,settings:GameSettings,now:number){phoneAdvance(s,settings,now);}
export function phoneView(s:Engine,seat:number) {
  if(s.phase==='reveal')return {phase:s.phase,step:s.step,total:s.albums.length,albums:s.albums,done:s.done};
  const chain=seat>=0?(seat-s.step+s.albums.length)%s.albums.length:-1,previous=chain>=0?s.albums[chain].at(-1):null;
  return {phase:s.phase,token:s.token,step:s.step,total:s.albums.length,done:s.done,previous:previous?.type==='text'?{type:'text',text:previous.text}:previous?{type:'picture',picture:previous.picture}:null,picture:seat>=0?s.pictures[seat]:null,submitted:seat>=0&&s.done.includes(seat)};
}
function teamCaptain(team:number,n:number){return Array.from({length:n},(_,i)=>i).find(i=>i%2===team)!;}
export function wordsStart(n:number,settings:GameSettings,now:number):Engine {const team=shuffle([0,1])[0],roles=shuffle([...Array(9).fill(team),...Array(8).fill(1-team),...Array(7).fill(2),3]);return {phase:'clue',deadline:now+settings.seconds*1000,result:null,team,captains:[teamCaptain(0,n),teamCaptain(1,n)],board:words(settings).slice(0,25),roles,revealed:Array(25).fill(false),clue:null,guesses:0,history:[],turns:0,token:'words-0'};}
function switchTeam(s:Engine,settings:GameSettings,now:number){s.team=1-s.team;s.phase='clue';s.clue=null;s.guesses=0;s.turns++;s.token=`words-${s.turns}`;s.deadline=now+settings.seconds*1000;if(s.turns>=100){s.phase='ended';s.result='Round limit reached';s.deadline=0;}}
export function wordsAction(s:Engine,seat:number,a:any,settings:GameSettings,now:number) {
  insist(seat%2===s.team,'It is the other team’s turn.');
  if(a.type==='clue'){
    insist(s.phase==='clue'&&s.captains[s.team]===seat,'Only your captain can give a clue.');const clue=text(a.text,40);insist(!/\s/.test(clue),'Use a single word for the clue.');insist(!s.board.some((w:string,i:number)=>!s.revealed[i]&&normalizeAnswer(w)===normalizeAnswer(clue)),'Do not use an unrevealed board word.');const count=integer(a.count,1,9);s.clue={text:clue,count};s.guesses=count+1;s.phase='guess';s.deadline=now+settings.seconds*1000;s.history.push({team:s.team,text:clue,count});s.history=s.history.slice(-40);
  }else{
    insist(s.phase==='guess'&&s.captains[s.team]!==seat,'Guessers choose the words.');
    if(a.type==='pass'){switchTeam(s,settings,now);return;}
    insist(a.type==='word');const i=integer(a.index,0,24);insist(!s.revealed[i],'That word is already revealed.');s.revealed[i]=true;s.guesses--;
    if(s.roles[i]===3){s.result=`Team ${2-s.team} wins`;s.phase='ended';s.deadline=0;return;}
    for(const team of [0,1])if(s.roles.every((role:number,i:number)=>role!==team||s.revealed[i])){s.result=`Team ${team+1} wins`;s.phase='ended';s.deadline=0;return;}
    if(s.roles[i]!==s.team||s.guesses===0)switchTeam(s,settings,now);
  }
}
export function wordsTick(s:Engine,settings:GameSettings,now:number){switchTeam(s,settings,now);}
export function wordsView(s:Engine,seat:number){const captain=s.captains.includes(seat);return {phase:s.phase,token:s.token,team:s.team,captains:s.captains,board:s.board,roles:s.roles.map((r:number,i:number)=>captain||s.revealed[i]||s.phase==='ended'?r:null),revealed:s.revealed,clue:s.clue,guesses:s.guesses,history:s.history,remaining:[0,1].map(team=>s.roles.filter((r:number,i:number)=>r===team&&!s.revealed[i]).length)};}
