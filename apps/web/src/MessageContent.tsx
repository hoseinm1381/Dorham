import { messageParts } from '../../../packages/contracts/src/links';
import { EmojiText } from './EmojiPicker';
import { catalogEmojiToken, isSingleEmoji } from './emojis';
import { useFeatures } from './Features';
import { mentionTokens, type Mention, type MentionToken } from '../../../packages/contracts/src/mentions';
import { useMemo } from 'react';
import { TtsProgress } from './TtsProgress';
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
export function MessageContent({ content, origin, navigate, mentions = [], me, messageId }: { content: string; origin: string; navigate: (target: { serverId: string; channelId: string }) => void; mentions?: Mention[]; me?: string; messageId?: string }) {
  const { byId } = useFeatures();
  const trimmed = content.trim(), custom = catalogEmojiToken.exec(trimmed);
  const single = custom ? byId.get(custom[1])?.kind === 'emoji' : isSingleEmoji(content);
  const parsed = useMemo(() => {
    const text = single ? content.trim() : content, tokens = mentionTokens(text); let offset = 0;
    return messageParts(text, origin).map(part => { const start = offset; offset += part.text.length; return { ...part, tokens: tokens.filter(t => t.start >= start && t.end <= offset).map(t => ({ ...t, start: t.start - start, end: t.end - start })) }; });
  }, [content, origin, single]);
  return <span className={`message-text${single ? ' single-emoji' : ''}`}>{parsed.map((part, i) => part.url ? <a key={i} dir="ltr" href={part.url} target={part.channel ? undefined : '_blank'} rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={part.channel ? e => { e.preventDefault(); navigate(part.channel!); } : undefined}>{part.text}</a> : <MentionText key={i} text={part.text} tokens={part.tokens} mentions={mentions} me={me}/>)}{messageId && <TtsProgress messageId={messageId}/>}</span>;
}
