import { messageParts } from '../../../packages/contracts/src/links';
import { EmojiText } from './EmojiPicker';
import { isSingleEmoji } from './emojis';
import { mentionTokens, type Mention, type MentionToken } from '../../../packages/contracts/src/mentions';
function MentionText({ text, tokens, mentions, me }: { text: string; tokens: MentionToken[]; mentions: Mention[]; me?: string }) {
  const parts = []; let position = 0;
  for (const token of tokens) {
    const user = mentions.find(m => m.username.toLowerCase() === token.username.toLowerCase());
    if (!user) continue;
    parts.push(<EmojiText key={`text-${token.start}`} text={text.slice(position, token.start)}/>);
    parts.push(<span key={token.start} className={`message-mention${user.userId === me ? ' self' : ''}`} title={user.displayName} dir="ltr">{text.slice(token.start, token.end)}</span>); position = token.end;
  }
  parts.push(<EmojiText key="tail" text={text.slice(position)}/>); return <>{parts}</>;
}
export function MessageContent({ content, origin, navigate, mentions = [], me }: { content: string; origin: string; navigate: (target: { serverId: string; channelId: string }) => void; mentions?: Mention[]; me?: string }) {
  const single = isSingleEmoji(content), text = single ? content.trim() : content, tokens = mentionTokens(text); let offset = 0;
  return <span className={`message-text${single ? ' single-emoji' : ''}`}>{messageParts(text, origin).map((part, i) => { const start = offset; offset += part.text.length; return part.url ? <a key={i} dir="ltr" href={part.url} target={part.channel ? undefined : '_blank'} rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={part.channel ? e => { e.preventDefault(); navigate(part.channel!); } : undefined}>{part.text}</a> : <MentionText key={i} text={part.text} tokens={tokens.filter(t => t.start >= start && t.end <= offset).map(t => ({ ...t, start: t.start - start, end: t.end - start }))} mentions={mentions} me={me}/>; })}</span>;
}
