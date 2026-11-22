import { useState } from 'react';
import type { Picture } from '../../../../packages/contracts/src/games';
import type { PanelProps } from '../game-ui';
import { seatName } from '../game-experience';
import { t } from '../i18n';
import DrawingCanvas from './DrawingCanvas';
import './party-games.css';

type Entry = { author: number; type: 'text'; text: string } | { author: number; type: 'picture'; picture: Picture };

function AlbumReveal({ albums, view }: { albums: Entry[][]; view: PanelProps['view'] }) {
  const [choice, setChoice] = useState<number>();
  const album = choice ?? Math.max(0, view.self);
  const pages = albums[album] || [];
  const last = pages.at(-1);
  const opening = pages[0];

  return <section className="party-panel phone-reveal">
    <div className="party-panel-head">
      <h3>{t('The reveal')}</h3>
      <label>{t('Album')}
        <select aria-label={t('Album')} value={album} onChange={event => setChoice(Number(event.target.value))}>
          {view.seats.map((player, index) => <option key={player.id + '-' + index} value={index}>{player.name}</option>)}
        </select>
      </label>
    </div>
    <div className="game-actions phone-album-nav">
      <button type="button" className="secondary" disabled={album === 0}
        onClick={() => setChoice(album - 1)}>{t('Previous album')}</button>
      <span>{album + 1}/{albums.length}</span>
      <button type="button" className="secondary" disabled={album === albums.length - 1}
        onClick={() => setChoice(album + 1)}>{t('Next album')}</button>
    </div>
    {opening?.type === 'text' && last?.type === 'text' && opening !== last && <div className="phone-comparison" key={`comparison-${album}`}>
      <div><small>{t('Original sentence')}</small><bdi>{opening.text}</bdi></div>
      <div><small>{t('Final guess')}</small><bdi>{last.text}</bdi></div>
    </div>}
    <ol key={`pages-${album}`}>
      {pages.map((entry, index) => <li key={index}>
        <strong>{t(index === 0 ? 'Original sentence' : entry.type === 'picture' ? 'Drawing' : 'Guess')} · <bdi>{seatName(view, entry.author)}</bdi></strong>
        {entry.type === 'text' ? <p dir="auto">{entry.text}</p> : <DrawingCanvas picture={entry.picture}/>}
      </li>)}
    </ol>
  </section>;
}

export default function TelephonePanel({ state, view, disabled, busy, act }: PanelProps) {
  const [draft, setDraft] = useState({ token: '', text: '' });
  const answer = draft.token === state.token ? draft.text : '';
  if (state.phase === 'reveal') return <AlbumReveal albums={state.albums} view={view}/>;

  const writing = state.phase === 'write';
  const drawing = state.phase === 'draw';
  const label = t(writing ? 'Your sentence' : 'Your description');
  return <section className="party-panel telephone-panel">
    <div className="party-panel-head">
      <h3>{t(writing ? 'Write a sentence' : drawing ? 'Draw this sentence' : 'Describe this drawing')}</h3>
      <span>{t('Step {step} of {total}', { step: state.step + 1, total: state.total })}</span>
    </div>
    <div className="phone-progress" aria-label={t('Players finished')}>
      <span>{t('{count} of {total} pages submitted', { count: state.done.length, total: state.total })}</span>
      <div aria-hidden="true" className="phone-pages">{Array.from({ length: state.total }, (_, index) =>
        <span key={index} className={index < state.done.length ? 'submitted' : ''}>{index < state.done.length ? '✓' : ''}</span>)}</div>
    </div>
    {view.self < 0 ? <p>{t('Prompts and drawings stay private until the reveal. Watch the group’s progress here.')}</p>
      : state.submitted ? <p className="party-result" role="status">{t('Submitted. Waiting for the other players.')}</p>
        : <div key={state.token} className="phone-task">
          {state.previous?.type === 'text' && <blockquote dir="auto">{state.previous.text}</blockquote>}
          {state.previous?.type === 'picture' && <DrawingCanvas picture={state.previous.picture}/>}
          {writing && <p className="game-muted">{t('Write something fun and easy to draw.')}</p>}
          {drawing ? <>
            <DrawingCanvas key={state.token} picture={state.picture} editable={!disabled}
              onUndo={() => act({ type: 'undo', token: state.token })}
              onStroke={stroke => act({ type: 'stroke', token: state.token, stroke })}
              onClear={() => act({ type: 'clear', token: state.token })}/>
            <button type="button" className="primary" disabled={disabled || busy}
              onClick={() => { void act({ type: 'submit', token: state.token }); }}>
              {t(state.picture.points ? 'Submit drawing' : 'Submit blank drawing')}
            </button>
          </> : <form className="game-inline-form phone-submit" onSubmit={event => {
            event.preventDefault();
            if (!disabled && !busy && answer.trim()) {
              void act({ type: 'submit', token: state.token, text: answer })
                .then(ok => { if (ok) setDraft({ token: state.token, text: '' }); });
            }
          }}>
            <label>{label}<input aria-label={label} dir="auto" value={answer}
              onChange={event => setDraft({ token: state.token, text: event.target.value })}
              disabled={disabled || busy} maxLength={180} autoComplete="off" enterKeyHint="send"/></label>
            <button className="primary" disabled={disabled || busy || !answer.trim()}>{t('Submit')}</button>
          </form>}
          <p className="game-muted">{t('Keep your prompt private. The full chain will be revealed at the end.')}</p>
        </div>}
  </section>;
}
