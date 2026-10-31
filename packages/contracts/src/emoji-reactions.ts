import { z } from 'zod';
import ids from './emoji-ids.json';
// Keep existing reaction keys so history/counts are not split into duplicate art.
const legacy: Record<string, string> = { 'emoji-thumbs-up': '👍', 'emoji-heart': '❤️', 'emoji-laughing': '😂', 'emoji-party': '🎉', 'emoji-checkmark': '✅' };
export function reactionValue(id: string) { return legacy[id] || `:${id}:`; }
export const reactionValues: [string, ...string[]] = ['👀', ...ids.map(reactionValue)];
export const reactionEmojiSchema = z.enum(reactionValues);
const reverse = new Map(ids.map(id => [reactionValue(id), id]));
export const reactionEmojiId = (value: string) => reverse.get(value);
