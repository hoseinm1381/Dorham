import { useState, type KeyboardEvent } from 'react';
import type { PanelProps } from '../game-ui';
import { seatName } from '../game-experience';
import { t } from '../i18n';
import './party-games.css';

const labels = ['Team 1', 'Team 2', 'Neutral', 'Danger'];
const symbols = ['●', '◆', '–', '✕'];
type ClueFormProps = {
  board: string[];
  revealed: boolean[];
  disabled: boolean;
  act: PanelProps['act'];
};

function ClueForm({ board, revealed, disabled, act }: ClueFormProps) {
  const [clue, setClue] = useState('');
  const [amount, setAmount] = useState('1');
  const count = Number(amount);
  const word = clue.trim();
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase()
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/\s|\u200c|\u200d|ـ/g, '');
  const boardWord = board.some((value, index) => !revealed[index] && normalize(value) === normalize(word));
  const issue = /\s/.test(word) ? 'Use a single word for the clue.' : boardWord ? 'Do not use an unrevealed board word.' : null;
  const valid = word.length > 0 && !issue && Number.isInteger(count) && count >= 1 && count <= 9;

  return <form className="game-inline-form word-clue-form" onSubmit={event => {
    event.preventDefault();
    if (valid && !disabled) void act({ type: 'clue', text: word, count }).then(ok => { if (ok) setClue(''); });
  }}>
    <label>{t('One-word clue')}
      <input aria-label={t('One-word clue')} dir="auto" disabled={disabled} maxLength={40} autoComplete="off"
        value={clue} onChange={event => setClue(event.target.value)}/>
    </label>
    <label>{t('Word count')}
      <input aria-label={t('Word count')} type="number" min={1} max={9} step={1} disabled={disabled}
        value={amount} onChange={event => setAmount(event.target.value)}/>
    </label>
    <button className="primary" disabled={disabled || !valid}>{t('Give clue')}</button>
    {issue && <small className="word-clue-issue" role="status">{t(issue)}</small>}
  </form>;
}

function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
  const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
  const delta = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowUp: -5, ArrowDown: 5 }[event.key];
  if (!delta) return;
  const board = event.currentTarget.parentElement;
  for (let next = index + delta; next >= 0 && next < 25; next += delta) {
    if (Math.abs(delta) === 1 && Math.floor(index / 5) !== Math.floor(next / 5)) break;
    const target = board?.querySelector<HTMLButtonElement>(`[data-word-index="${next}"]`);
    if (target && !target.disabled) {
      event.preventDefault();
      target.focus();
      return;
    }
  }
}

export default function WordsPanel({ state, view, disabled, busy, act }: PanelProps) {
  const captain = state.captains.includes(view.self);
  const myTeam = view.self >= 0 ? view.self % 2 : -1;
  const active = state.phase === 'clue' || state.phase === 'guess';
  const canGuess = !disabled && !busy && state.phase === 'guess' && myTeam === state.team && !captain;
  const canClue = state.phase === 'clue' && state.captains[state.team] === view.self;
  const words: string[] = state.board;

  return <section className="party-panel words-panel">
    <div className="game-scores word-teams">
      {[0, 1].map(team => <div key={team} className={`team-label team-${team} ${active && team === state.team ? 'active' : ''}`}>
        <strong><span aria-hidden="true">{symbols[team]}</span> {t('Team {number}', { number: team + 1 })}</strong>
        <span>{t('{count} words left', { count: state.remaining[team] })}</span>
        <span>{t('Captain')} <bdi>{seatName(view, state.captains[team])}</bdi></span>
      </div>)}
    </div>
    {view.self >= 0 && <p className={`word-role team-label team-${myTeam}`}>
      {t('Your role')} · {t('Team {number}', { number: myTeam + 1 })} · {t(captain ? 'Captain' : 'Guesser')}
    </p>}
    {captain && active && <p className="game-muted">{t('You can see the secret key. Give only a word and a number; do not reveal the colors.')}</p>}
    {state.clue && <p key={state.history.length} className="word-clue" role="status">
      <span>{t('Clue')}</span><strong dir="auto">{state.clue.text} · {state.clue.count}</strong>
      <span>{t('{count} guesses left', { count: state.guesses })}</span>
    </p>}
    {canClue && <ClueForm key={state.token} board={words} revealed={state.revealed} disabled={disabled || busy} act={act}/>}
    <div className="word-board" role="group" aria-label={t('Word board')}>
      {words.map((word, index) => {
        const role: number | null = state.roles[index];
        const revealed = state.revealed[index];
        return <button type="button" key={index} data-word-index={index}
          className={`word-card role-${role === null ? 'hidden' : role} ${revealed ? 'revealed' : ''}`}
          aria-label={role === null ? word : t('{word}, {role}', { word, role: t(labels[role]) })}
          disabled={!canGuess || revealed} onKeyDown={event => moveFocus(event, index)}
          onClick={() => { void act({ type: 'word', index }); }}>
          <strong dir="auto">{word}</strong>
          {role !== null && <small><span aria-hidden="true">{symbols[role]}</span> {t(labels[role])}</small>}
        </button>;
      })}
    </div>
    {canGuess && <button type="button" className="secondary word-end"
      onClick={() => { void act({ type: 'pass' }); }}>{t('End guesses')}</button>}
    {state.history.length > 0 && <details><summary>{t('Clue history')}</summary>
      <ol>{state.history.map((clue: { team: number; text: string; count: number }, index: number) => <li key={index}>
        {t('Team {number}', { number: clue.team + 1 })} · <bdi>{clue.text}</bdi> · {clue.count}
      </li>)}</ol>
    </details>}
  </section>;
}
