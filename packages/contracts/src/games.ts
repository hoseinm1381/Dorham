// Small catalog only: importing this must not load any game engine or screen.
export const quickGameCatalog = [
  { id: 'rps', name: 'Rock Paper Scissors', icon: '✊', min: 2, max: 16, description: 'Pick a hand and reveal together' },
  { id: 'high-low', name: 'High or Low', icon: '↕', min: 2, max: 16, description: 'Guess whether the next card is higher or lower' },
  { id: 'target-dice', name: 'Target Dice', icon: '🎲', min: 2, max: 16, description: 'Bank your dice or risk one more to reach twelve' },
  { id: 'odd-one', name: 'Odd One Out', icon: '◆', min: 2, max: 16, description: 'Spot the one symbol that is different' },
  { id: 'color-sequence', name: 'Color Sequence', icon: '🎨', min: 2, max: 16, description: 'Watch a pattern and repeat it from memory' },
  { id: 'memory-match', name: 'Memory Match', icon: '▤', min: 2, max: 8, description: 'Flip cards to find matching pairs' },
  { id: 'number-hunt', name: 'Number Hunt', icon: '#', min: 2, max: 8, description: 'Use higher and lower clues to find the secret number' },
  { id: 'treasure-grid', name: 'Treasure Grid', icon: '💎', min: 2, max: 4, description: 'Dig for treasure and follow the clues' },
] as const;
export type QuickGameKind = typeof quickGameCatalog[number]['id'];
export const isQuickGame = (kind: string): kind is QuickGameKind => quickGameCatalog.some(game => game.id === kind);

export const gameCatalog = [
  { id: 'chess', name: 'Chess', icon: '♟', min: 2, max: 2, description: 'Standard chess and Elixer Chess' },
  { id: 'poker', name: 'Texas Hold’em', icon: '♠', min: 2, max: 8, description: 'Poker with play chips only' },
  { id: 'domino', name: 'Dominoes', icon: '⚅', min: 2, max: 4, description: 'Draw and Block dominoes' },
  { id: 'telephone', name: 'Drawing Telephone', icon: '✎', min: 3, max: 8, description: 'Write, draw, guess, and reveal' },
  { id: 'drawing', name: 'Draw & Guess', icon: '▧', min: 2, max: 8, description: 'Draw a word for your friends to guess' },
  { id: 'words', name: 'Team Word Clues', icon: '▦', min: 4, max: 8, description: 'Two teams, secret words, clever clues' },
  { id: 'ludo', name: 'Ludo', icon: '⚄', min: 2, max: 4, description: 'Race your four tokens home' },
  { id: 'four', name: 'Four in a Row', icon: '●', min: 2, max: 2, description: 'Connect four counters to win' },
  ...quickGameCatalog,
] as const;
export type GameKind = Exclude<typeof gameCatalog[number]['id'], 'chess'>;
export const definition = (id: string) => gameCatalog.find(g => g.id === id)!;
export const playerLabel = (min: number, max: number) => min === max ? `${max} players` : `${min}–${max} players`;
export type GameSettings = { maxPlayers: number; seconds: number; rounds: number; language: 'en' | 'fa'; domino: 'draw' | 'block'; chips: number; blind: number };
export type GameSeat = { id: string; name: string; left: boolean; grace: number; missingAt: number };
export type GameSummary = { id: string; channelId: string; kind: GameKind; hostName: string; hostId: string; status: 'waiting' | 'playing' | 'finished'; players: number; maxPlayers: number; minPlayers: number; paused: boolean; seated: boolean };
export type Stroke = { color: string; width: number; points: [number, number][] };
export type Picture = { strokes: Stroke[]; points: number };
export type CanvasEvent={id:string;revision:number;serverNow:number;token:string;seat:number;requestId:string;type:'stroke'|'clear';stroke?:Stroke};
export type GameView = GameSummary & { revision: number; seats: GameSeat[]; settings: GameSettings; self: number; canPlay: boolean; canStart: boolean; deadline: number; serverNow: number; pausedUntil: number; result: string | null; state: Record<string, any> };
