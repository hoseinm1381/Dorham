// Small catalog only: importing this must not load any game engine or screen.
export const gameCatalog = [
  { id: 'chess', name: 'Chess', icon: '♟', min: 2, max: 2, description: 'Standard chess and Elixer Chess' },
  { id: 'poker', name: 'Texas Hold’em', icon: '♠', min: 2, max: 8, description: 'Poker with play chips only' },
  { id: 'domino', name: 'Dominoes', icon: '⚅', min: 2, max: 4, description: 'Draw and Block dominoes' },
  { id: 'telephone', name: 'Drawing Telephone', icon: '✎', min: 3, max: 8, description: 'Write, draw, guess, and reveal' },
  { id: 'drawing', name: 'Draw & Guess', icon: '▧', min: 2, max: 8, description: 'Draw a word for your friends to guess' },
  { id: 'words', name: 'Team Word Clues', icon: '▦', min: 4, max: 8, description: 'Two teams, secret words, clever clues' },
  { id: 'ludo', name: 'Ludo', icon: '⚄', min: 2, max: 4, description: 'Race your four tokens home' },
  { id: 'four', name: 'Four in a Row', icon: '●', min: 2, max: 2, description: 'Connect four counters to win' }
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
