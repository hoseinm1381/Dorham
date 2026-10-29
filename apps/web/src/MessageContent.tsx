import { messageParts } from '../../../packages/contracts/src/links';
export function MessageContent({ content, origin, navigate }: { content: string; origin: string; navigate: (target: { serverId: string; channelId: string }) => void }) {
  return <span className="message-text">{messageParts(content, origin).map((part, i) => part.url ? <a key={i} dir="ltr" href={part.url} target={part.channel ? undefined : '_blank'} rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={part.channel ? e => { e.preventDefault(); navigate(part.channel!); } : undefined}>{part.text}</a> : part.text)}</span>;
}
