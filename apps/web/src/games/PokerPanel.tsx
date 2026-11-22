import { useState } from 'react';
import type { PanelProps } from '../game-ui';
import { seatName } from '../game-experience';
import { formatNumber, t } from '../i18n';
import { gameText } from '../game-text';
import './party-games.css';

const ranks = ['High card', 'One pair', 'Two pairs', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
const cardRank = (value: number) => value % 13 === 8 ? '10' : '23456789TJQKA'[value % 13];
const courtRanks: Record<string, string> = { J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };
const suits = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];
const cardArt = import.meta.glob<string>('./assets/cards/*.svg', { eager: true, import: 'default', query: '?url&no-inline' });

function Card({ value }: { value: number | undefined }) {
  if (value === undefined) return <span className="poker-card empty" role="img" aria-label={t('Undealt card')}/>;
  const hidden = value === -1;
  const suit = Math.floor(value / 13);
  const file = hidden ? 'B-1' : `${'SHDC'[suit]}-${cardRank(value)}`;
  const shortRank = cardRank(value);
  const rank = courtRanks[shortRank] ? t(courtRanks[shortRank], {}, 'poker') : formatNumber(value % 13 + 2);
  const label = hidden ? t('Hidden card') : t('{rank} of {suit}', { rank, suit: t(suits[suit]) });
  return <span className={`poker-card ${hidden ? 'back' : 'face'}`} role="img" aria-label={label}>
    <img src={cardArt[`./assets/cards/${file}.svg`]} alt="" draggable={false}/>
  </span>;
}

type BettingControls = { canCheck: boolean; call: number; canRaise: boolean; minRaise: number; maxRaise: number };

function RaiseControls({ controls, bet, pot, disabled, stack, act }: {
  controls: BettingControls; bet: number; pot: number; disabled: boolean; stack: number; act: PanelProps['act'];
}) {
  const min = Math.min(controls.minRaise, controls.maxRaise);
  const [amount, setAmount] = useState(String(min));
  const [allIn, setAllIn] = useState(false);
  const raise = Number(amount);
  const valid = amount.trim() !== '' && Number.isInteger(raise) && raise >= min && raise <= controls.maxRaise;
  const preset = (value: number) => setAmount(String(Math.min(controls.maxRaise, Math.max(min, Math.round(value)))));

  return <details className="poker-raise">
    <summary>{t('Raise options')}</summary>
    <form onSubmit={event => {
      event.preventDefault();
      if (!disabled && valid) void act({ type: 'raise', to: raise });
    }}>
      <label>{t('Raise to')}
        <input type="number" aria-label={t('Raise to')} min={min} max={controls.maxRaise} step="1" inputMode="numeric"
          value={amount} disabled={disabled} onChange={event => setAmount(event.target.value)}/>
      </label>
      <button className="primary" disabled={disabled || !valid}>{t('Raise')}</button>
      <div className="poker-presets">
        <button type="button" disabled={disabled || controls.minRaise > controls.maxRaise} onClick={() => preset(min)}>{t('Minimum raise')}</button>
        <button type="button" disabled={disabled || controls.minRaise > controls.maxRaise} onClick={() => preset(bet + (pot + controls.call) / 2)}>{t('Half pot')}</button>
        <button type="button" disabled={disabled || controls.minRaise > controls.maxRaise} onClick={() => preset(bet + pot + controls.call)}>{t('Pot')}</button>
      </div>
      <button type="button" className="secondary" disabled={disabled} onClick={() => setAllIn(true)}>{t('All-in')}</button>
    </form>
    {allIn && <div className="poker-all-in" role="group" aria-label={t('All-in')}>
      <p>{t('Go all-in with {count} chips?', { count: stack })}</p>
      <button type="button" className="secondary" onClick={() => setAllIn(false)}>{t('Cancel')}</button>
      <button type="button" className="primary" disabled={disabled} onClick={() => {
        void act({ type: 'raise', to: controls.maxRaise }).then(ok => { if (ok) setAllIn(false); });
      }}>{t('Confirm all-in')}</button>
    </div>}
  </details>;
}

export default function PokerPanel({ state, view, disabled, busy, act }: PanelProps) {
  const controls: BettingControls | undefined = state.controls;
  const unavailable = disabled || busy;
  const betting = state.phase === 'betting';
  const pot = (state.committed as number[]).reduce((a, b) => a + b, 0);
  const payout: number[] = state.payouts || [];
  const receiving = payout.flatMap((amount, seat) => amount ? [{ amount, seat }] : []);
  const latestAction = (state.log as string[]).at(-1);
  function renderPlayer(i: number) {
    const player = view.seats[i];
    const own = i === view.self;
    return <article key={player.id + '-' + i} className={`${betting && state.turn === i ? 'current' : ''} ${state.folded[i] ? 'folded' : ''} ${own ? 'poker-self' : ''}`}>
      <header><strong dir="auto">{player.name}</strong>
        {state.dealer === i && <span className="poker-dealer" aria-label={t('Dealer')}>D</span>}
      </header>
      {own && <small>{t('Your cards')}</small>}
      <div className="poker-hand">{(state.holes[i] || []).map((card: number, j: number) =>
        <Card key={`${state.hand}-${j}-${card}`} value={card}/>)}</div>
      <span>{formatNumber(state.stack[i])} {t('chips')} · {t('Bet')} {formatNumber(state.street[i])}</span>
      {state.handRanks?.[i] != null && <small className="poker-hand-rank">{t(ranks[state.handRanks[i]])}</small>}
      {state.folded[i] && <small>{t('Folded')}</small>}
    </article>;
  }

  return <section className="party-panel poker-panel">
    <div className="poker-table party-poker-table">
      <div className="party-panel-head">
        <strong>{t('Hand {number}', { number: state.hand })}</strong>
        <span>{t('Big blind')} {formatNumber(state.blind)}</span>
      </div>
      <span className="poker-street">{t(state.board.length === 0 ? 'Pre-flop' : state.board.length === 3 ? 'Flop' : state.board.length === 4 ? 'Turn' : 'River')}</span>
      <div className="poker-community" aria-label={t('Community cards')}>
        {Array.from({ length: 5 }, (_, i) => <Card key={`${state.hand}-${i}-${state.board[i]}`} value={state.board[i]}/>)}
      </div>
      <div className="poker-pot"><span>{t('Pot')}</span><strong>{formatNumber(pot)}</strong>
        {betting && <span>{t('Current bet')} {formatNumber(state.bet)}</span>}
      </div>
    </div>
    {view.self >= 0 && <div className="poker-players poker-private">{renderPlayer(view.self)}</div>}
    {controls && <div className="poker-controls">
      <div className="poker-actions">
        <button type="button" className="primary" disabled={unavailable} onClick={() => {
          void act({ type: controls.canCheck ? 'check' : 'call' });
        }}>{controls.canCheck ? t('Check', {}, 'poker') : `${t('Call')} ${formatNumber(controls.call)}`}</button>
        <button type="button" className="secondary" disabled={unavailable}
          onClick={() => { void act({ type: 'fold' }); }}>{t('Fold')}</button>
      </div>
      {controls.canRaise && <RaiseControls key={`${state.hand}:${state.board.length}:${controls.minRaise}:${controls.maxRaise}`}
        controls={controls} bet={state.bet} pot={pot} stack={state.stack[view.self]} disabled={unavailable} act={act}/>}
    </div>}
    {state.handResult && <div className="poker-result party-result" role="status">
      <strong>{t('Hand result')}</strong>
      {receiving.length > 0 && <ul>
        {receiving.map(({ seat, amount }) => <li key={seat}><bdi>{seatName(view, seat)}</bdi><span>+{formatNumber(amount)} {t('chips')}</span></li>)}
      </ul>}
      {state.phase === 'between' && view.seats[view.self]?.id === view.hostId && <button type="button" className="primary"
        disabled={unavailable} onClick={() => { void act({ type: 'next' }); }}>{t('Next hand')}</button>}
    </div>}
    <div className="poker-players">{view.seats.map((_, i) => i !== view.self ? renderPlayer(i) : null)}</div>
    {latestAction && betting && <p className="party-activity" role="status">{gameText(latestAction)}</p>}
    <details><summary>{t('Hand history')}</summary>
      <ol>{(state.log as string[]).map((item, i) => <li key={i}>{gameText(item)}</li>)}</ol>
    </details>
    <p className="game-muted">{t('Play chips only. No purchases, cash value, or payouts.')}</p>
  </section>;
}
