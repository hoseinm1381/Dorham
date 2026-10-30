import type { GameKind, GameView } from '../../../packages/contracts/src/games';
import { t } from './i18n';

export const gameGuide: Record<GameKind|'chess', {tag:string;goal:string;steps:string[]}> = {
  chess:{tag:'Strategy',goal:'Protect your king and checkmate your opponent.',steps:['Choose Standard for familiar chess, or Elixer to buy pieces with coins.','Select a piece, then a marked square. Elixer purchases go on your home two ranks.','Human-match clocks start when someone takes the open seat. Closing the viewer keeps your match and voice connected.']},
  poker:{tag:'Cards',goal:'Win the pot with the best five-card hand, or make everyone else fold.',steps:['Your two cards are private. Combine them with the five community cards.','Call matches the current bet. Raise to is your total bet for this street.','The host deals the next hand. New players can take a seat between hands.']},
  domino:{tag:'Strategy',goal:'Empty your hand or finish with the fewest pips. First to 100 points wins.',steps:['Select a highlighted tile, then choose the left or right end.','The highest double opens. Draw until you can play, or pass in Block mode.','A blocked round awards the other hands’ pips to the sole lowest hand.']},
  telephone:{tag:'Party',goal:'Turn a sentence into drawings and guesses, then discover what changed.',steps:['Everyone writes a funny sentence in private.','Draw the sentence you receive, then describe the next drawing. Submit before time runs out.','At the end, browse each album together. There are no winners or points.']},
  drawing:{tag:'Drawing',goal:'Draw a secret word while your friends race to guess it.',steps:['The drawer sees the word. Everyone else types guesses below the canvas.','Faster correct guesses earn more points. The drawer earns points for each correct guess.','Use the eraser or Undo to fix a drawing. Keep the word secret in voice chat.']},
  words:{tag:'Teams',goal:'Help your team find all its words without choosing the danger word.',steps:['Seats alternate teams. The first player in each team is captain and sees the secret key.','The captain gives one word and a number. Teammates get that number plus one guesses.','A neutral or opposing word ends the turn. The danger word immediately loses.']},
  ludo:{tag:'Strategy',goal:'Race all four tokens into your home lane before the other players.',steps:['Roll a six to bring a token out. Select a highlighted token or its larger button below the board.','Six grants another roll; three consecutive sixes lose the turn. Stars are safe from capture.','Land on an opponent to send it home. You need an exact roll to finish.']},
  four:{tag:'Quick play',goal:'Connect four counters horizontally, vertically, or diagonally.',steps:['Choose a column. Your counter falls to the lowest empty space.','Block your opponent’s lines while building your own.','A full board without four in a row is a draw.']}
};
export function GameGuide({kind}:{kind:GameKind|'chess'}){const guide=gameGuide[kind];return <details className="game-guide"><summary>{t('How to play')}</summary><p>{t(guide.goal)}</p><ol>{guide.steps.map(step=><li key={step}>{t(step)}</li>)}</ol></details>;}
export function seatName(view:GameView,index:number){return view.seats[index]?.name||t('Player {number}',{number:index+1});}
export function TurnPrompt({view}:{view:GameView}){
  const s=view.state;
  let message:string,mine=false;
  if(view.status==='waiting')message=view.players<view.minPlayers?t('Waiting for {count} more players',{count:view.minPlayers-view.players}):t('Enough players have joined. The host can start.');
  else if(view.status==='finished')message=t('Play again to open a fresh lobby. Everyone chooses whether to join.');
  else if(view.pausedUntil)message=t('Waiting for disconnected players. Your game clock is paused.');
  else if(s.phase==='between')message=t('Waiting for {name} to start the next round',{name:view.hostName});
  else if(view.kind==='telephone'){mine=view.self>=0&&!s.submitted;message=view.self<0?t('Watch the group’s progress. The albums stay private until the reveal.'):s.submitted?t('Submitted. Waiting for the other players.'):t(s.phase==='draw'?'Your turn: draw the sentence you received.':s.phase==='write'?'Your turn: write a funny sentence.':'Your turn: describe the drawing you received.');}
  else if(view.kind==='drawing'){mine=s.phase==='drawing'&&view.self===s.drawer;message=s.phase==='reveal'?t('The word is revealed. The next drawing starts shortly.'):mine?t('Your turn: draw your secret word.'):s.guessed.includes(view.self)?t('You guessed it. Wait for the next drawing.'):t('{name} is drawing. Type your guess below.',{name:seatName(view,s.drawer)});}
  else if(view.kind==='words'){mine=view.self>=0&&view.self%2===s.team&&(s.phase==='clue'?s.captains[s.team]===view.self:!s.captains.includes(view.self));message=t(s.phase==='clue'?'Team {number}: waiting for the captain’s clue.':'Team {number}: discuss the clue, then choose a word.',{number:s.team+1});}
  else{mine=view.self===s.turn;message=mine?t(view.kind==='ludo'?(s.phase==='roll'?'Your turn: roll the dice.':'Your turn: choose a token to move.'):view.kind==='poker'?'Your turn: check, call, raise, or fold.':view.kind==='domino'?'Your turn: play a matching tile, draw, or pass.':'Your turn: choose a column.'):t('Waiting for {name}',{name:seatName(view,s.turn)});}
  return <p className={`game-turn-prompt ${mine&&!view.pausedUntil?'your-turn':''}`} role="status">{message}</p>;
}
