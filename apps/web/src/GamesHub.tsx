import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { PublicUser, VoiceRoom } from '@dorham/contracts';
import { gameCatalog, type GameKind, type GameSummary } from '../../../packages/contracts/src/games';
import { gameClientFeature, supportsClientFeature, type ClientFeature } from '../../../packages/contracts/src/client-features';
import { ClientFeatureNotice } from './ClientFeatureNotice';
import { clientVersion } from './client-version';
import type { VoiceGame } from '../../../packages/contracts/src/chess';
import { t as tr } from './i18n';
import './arcade.css';
import { gameGuide } from './game-experience';
import { GameSoundButton, useGameSound } from './game-sound';
const ChessRoom=lazy(()=>import('./ChessRoom')),GameRoom=lazy(()=>import('./GameRoom'));
export function PlayerBadge({min,max}:{min:number;max:number}){return <span className="game-player-badge">{min===max?tr('{count} players',{count:max}):tr('{min}–{max} players',{min,max})}</span>;}
export default function GamesHub(props:{me:PublicUser;room:VoiceRoom|null;serverId:string|null;socket:Socket|null;connected:boolean;initialGameId:string|null;initialKind:GameKind|'chess'|null;games:VoiceGame[];arcade:GameSummary[];clientFeatures:ClientFeature[];close:()=>void;gameAudioSilenced:boolean}){
  const sound = useGameSound(props.gameAudioSilenced);
  const [selection,setSelection]=useState<{kind:GameKind|'chess';id:string|null}|null>(props.initialKind?{kind:props.initialKind,id:props.initialGameId}:null),dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(selection)return;const el=dialog.current!,previous=document.activeElement as HTMLElement;el.showModal();return()=>{el.close();previous?.focus();};},[selection]);
  const updates=props.clientFeatures.filter(feature=>!supportsClientFeature(feature,clientVersion));
  const gameAvailability=(kind:string)=>{
    const feature=props.clientFeatures.find(item=>item.gameKinds?.includes(kind));
    if(feature&&!supportsClientFeature(feature,clientVersion))return tr('App update required');
    if(!feature&&gameClientFeature(kind))return tr('Unavailable on this server');
    return '';
  };
  const live=[...props.arcade].sort((a,b)=>Number(b.seated)-Number(a.seated)||Number(b.status==='waiting')-Number(a.status==='waiting'));
  return selection?<Suspense fallback={<div className="games-load-error" role="status">{tr('Loading games…')}<button onClick={props.close}>{tr('Back to chat')}</button></div>}>{selection.kind==='chess'?<ChessRoom {...props} sound={sound} initialGameId={selection.id} startInSettings={!selection.id} onCatalog={()=>setSelection(null)}/>:<GameRoom {...props} sound={sound} kind={selection.kind} initialGameId={selection.id} onCatalog={()=>setSelection(null)}/>}</Suspense>:<dialog ref={dialog} onClickCapture={sound.unlock} className="arcade-dialog catalog-dialog" aria-label={tr('Games')} onCancel={e=>{e.preventDefault();props.close();}}><header><div><span className="eyebrow">DORHAM · {tr('PLAY TOGETHER')}</span><h2>{tr('Games')}</h2></div><nav className="game-nav"><GameSoundButton sound={sound}/><button className="secondary" onClick={props.close}>{tr('Back to chat')}</button></nav></header><p>{tr('Choose a game to play together in your current voice channel.')}</p><p className="game-muted">{tr('Player counts are seats. Others in the voice channel can watch.')}</p>{!props.connected&&<p role="status">{tr('Reconnecting. Game controls will return when connected.')}</p>}{live.length>0&&<section className="game-live-list" aria-label={tr('Games in this voice channel')}><h3>{tr('Games in this voice channel')}</h3>{live.map(g=><button key={g.id} disabled={!props.connected} onClick={()=>setSelection({kind:g.kind,id:g.id})}><strong>{tr(gameCatalog.find(item=>item.id===g.kind)!.name)} · {g.hostName}</strong><small>{tr('{joined}/{max} joined',{joined:g.players,max:g.maxPlayers})} · {tr(g.seated?'Resume your game':g.paused?'Reconnecting':g.status==='waiting'&&g.players<g.maxPlayers?'Seats open':'Watch game')}</small></button>)}</section>}{updates.map(feature=><ClientFeatureNotice key={feature.id} feature={feature}/>)}<div className="arcade-catalog">{gameCatalog.map(g=>{const unavailable=gameAvailability(g.id);return <button key={g.id} className="game-catalog-card" data-game={g.id} aria-label={tr(g.name)} disabled={!props.room||!props.connected||Boolean(unavailable)} onClick={()=>setSelection({kind:g.id,id:null})}><span className="game-catalog-icon" aria-hidden="true">{g.icon}</span><small className="game-category">{tr(gameGuide[g.id].tag)}</small><strong>{tr(g.name)}</strong><PlayerBadge min={g.min} max={g.max}/><small>{tr(g.description)}</small>{unavailable&&<small className="game-availability">{unavailable}</small>}{g.id==='chess'&&<small>{tr('Also playable against AI')}</small>}</button>;})}</div>{props.games.filter(g=>g.whiteId===props.me.id||g.blackId===props.me.id).map(g=><button key={g.id} className="secondary" onClick={()=>setSelection({kind:'chess',id:g.id})}>{tr('Resume your game')} · {tr('Chess')}</button>)}</dialog>;
}
