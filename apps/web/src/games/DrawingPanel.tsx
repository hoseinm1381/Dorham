import { useState } from 'react';
import type { PanelProps } from '../game-ui';
import { seatName } from '../game-experience';
import { t } from '../i18n';
import DrawingCanvas from './DrawingCanvas';
import './party-games.css';

type Guess = { seat: number; correct: boolean; text?: string };

export default function DrawingPanel({ state, view, disabled, busy, act }: PanelProps) {
  const [draft, setDraft] = useState({ token: '', text: '' });
  const answer = draft.token === state.token ? draft.text : '';
  const drawing = state.phase === 'drawing';
  const own = view.self === state.drawer;
  const guessed = state.guessed.includes(view.self);
  const canGuess = drawing && view.self >= 0 && !own && !guessed;
  const history: Guess[] = state.guesses;
  const activeGuessers = view.seats.filter((seat, index) => index !== state.drawer && !seat.left).length;
  const scores = view.seats.map((player, seat) => ({ player, seat, score: state.scores[seat] }))
    .sort((left, right) => right.score - left.score || left.seat - right.seat);
  const guessFeedback = history.at(-1)?.seat === view.self && history.at(-1)?.correct === false;

  return <section className="party-panel draw-guess-panel">
    <div className="party-panel-head">
      <h3>{t('Round {number}', { number: Math.min(state.round, state.total) })}/{state.total}</h3>
      {drawing && <span dir="auto">{t('{name} is drawing', { name: seatName(view, state.drawer) })}</span>}
    </div>
    <div className={`draw-guess-prompt ${drawing ? '' : 'word-reveal'}`}>
      <p className="drawing-word">
        {state.word ? <>{t(own && drawing ? 'Your word' : 'The word')} <strong dir="auto">{state.word}</strong></>
          : t('{count} letters', { count: state.wordLength })}
      </p>
      {drawing && <span>{t('{count} of {total} guessed it', { count: state.guessed.length, total: activeGuessers })}</span>}
    </div>
    <DrawingCanvas key={state.token} picture={state.picture} editable={!disabled && own && drawing}
      onUndo={() => act({ type: 'undo', token: state.token })}
      onStroke={stroke => act({ type: 'stroke', token: state.token, stroke })}
      onClear={() => act({ type: 'clear', token: state.token })}/>
    {canGuess && <form className="game-inline-form draw-guess-form" onSubmit={event => {
      event.preventDefault();
      if (!disabled && !busy && answer.trim()) {
        void act({ type: 'guess', token: state.token, text: answer })
          .then(ok => { if (ok) setDraft({ token: state.token, text: '' }); });
      }
    }}>
      <label>{t('Your guess')}
        <input aria-label={t('Your guess')} dir="auto" autoComplete="off" enterKeyHint="send"
          maxLength={80} value={answer} disabled={disabled || busy}
          onChange={event => setDraft({ token: state.token, text: event.target.value })}/>
      </label>
      <button className="primary" disabled={disabled || busy || !answer.trim()}>{t('Guess')}</button>
      {guessFeedback && <p className="draw-guess-feedback" role="status">{t('Keep guessing!')}</p>}
    </form>}
    {drawing && guessed && <p className="party-result" role="status">{t('Guessed it!')}</p>}
    <div className="draw-guess-lower">
      <div>
        <h3>{t('Scores')}</h3>
        <ol className="game-leaderboard" aria-label={t('Scores')}>
          {scores.map(({ player, seat, score }, rank) => <li key={player.id + '-' + seat}>
            <b>{rank + 1}</b><bdi>{player.name}</bdi><strong>{score} {t('points')}</strong>
          </li>)}
        </ol>
      </div>
      {history.length > 0 && <div>
        <h3>{t('Guesses')}</h3>
        <ol className="guess-log">
          {history.slice().reverse().map((guess, index) => <li key={history.length - index} className={guess.correct ? 'correct' : ''}>
            <bdi>{seatName(view, guess.seat)}</bdi>
            <span dir="auto">{guess.correct ? t('Guessed it!') : guess.text}</span>
          </li>)}
        </ol>
      </div>}
    </div>
  </section>;
}
