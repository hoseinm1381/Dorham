import type { GameView } from '../../../packages/contracts/src/games';
export type PanelProps={view:GameView;state:Record<string,any>;disabled:boolean;busy:boolean;audioSilenced?:boolean;audioVolume?:number;act:(action:Record<string,any>)=>Promise<boolean>};
