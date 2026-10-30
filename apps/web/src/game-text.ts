import { t } from './i18n';
export function gameText(value:string){let m:RegExpMatchArray|null;
  if((m=value.match(/^Player (\d+) wins by departure$/)))return t('Player {number} wins by departure',{number:m[1]});
  if((m=value.match(/^Player (\d+) wins the round$/)))return t('Player {number} wins the round',{number:m[1]});
  if((m=value.match(/^Player (\d+) wins$/)))return t('Player {number} wins',{number:m[1]});
  if((m=value.match(/^Team (\d+) wins by departure$/)))return t('Team {number} wins by departure',{number:m[1]});
  if((m=value.match(/^Team (\d+) wins$/)))return t('Team {number} wins',{number:m[1]});
  if((m=value.match(/^Player (\d+) (folded|checked|called)$/)))return t(m[2]==='folded'?'Player {number} folded':m[2]==='checked'?'Player {number} checked':'Player {number} called',{number:m[1]});
  if((m=value.match(/^Player (\d+) raised to (\d+)$/)))return t('Player {number} raised to {amount}',{number:m[1],amount:m[2]});
  return t(value);
}
