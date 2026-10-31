import { messageParts } from '../../../packages/contracts/src/links';
import { EmojiText } from './EmojiPicker';
import { isSingleEmoji } from './emojis';
export function MessageContent({ content, origin, navigate }: { content: string; origin: string; navigate: (target: { serverId: string; channelId: string }) => void }) {
  const single = isSingleEmoji(content);
  return <span className={`message-text${single ? ' single-emoji' : ''}`}>{messageParts(single ? content.trim() : content, origin).map((part, i) => part.url ? <a key={i} dir="ltr" href={part.url} target={part.channel ? undefined : '_blank'} rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={part.channel ? e => { e.preventDefault(); navigate(part.channel!); } : undefined}>{part.text}</a> : <EmojiText key={i} text={part.text}/>)}</span>;
}
