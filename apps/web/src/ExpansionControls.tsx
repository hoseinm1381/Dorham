import { AttachmentCard } from './AttachmentMedia';
import { compressPicture } from './image-compression';
import { t as tr, formatFileSize } from './i18n';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Attachment, Channel, PublicUser, Tag, VoiceRoom } from '@dorham/contracts';
import { cancelAttachmentUpload, request, uploadAttachment, type UploadDraft } from './api';
import { readLocal, storageScope } from './offline-storage';
import { Paperclip } from 'lucide-react';
import { UploadAllowance } from './UploadAllowance';

export function FileComposer({ conversationId, files, change, error }: { conversationId: string; files: Attachment[]; change: (files: Attachment[] | ((previous: Attachment[]) => Attachment[])) => void; error: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false), [abort, setAbort] = useState<AbortController | null>(null), [picture, setPicture] = useState<{ original: File; compressed: File; url: string } | null>(null);
  const [usageRevision, setUsageRevision] = useState(0);
  const [paused, setPaused] = useState<UploadDraft>();
  const [uploaded, setUploaded] = useState(0);
  const scope = storageScope();
  const element = useRef<HTMLDivElement>(null), locked = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { let active = true; void readLocal<UploadDraft>(scope, 'upload', conversationId).then(draft => { if (active && !locked.current) setPaused(draft); }); return () => { active = false; }; }, [scope, conversationId]);
  useEffect(() => () => { abort?.abort(); }, [abort]);
  useEffect(() => () => { if (picture) URL.revokeObjectURL(picture.url); }, [picture]);
  useEffect(() => {
    const composer = element.current?.closest('.composer-wrap');
    const paste = (event: Event) => {
      const e = event as ClipboardEvent;
      if (!(e.target instanceof HTMLTextAreaElement) || e.target.disabled) return;
      const item = [...(e.clipboardData?.items || [])].find(item => item.kind === 'file' && /^image\/(png|jpeg|webp|gif)$/.test(item.type));
      const file = item?.getAsFile(); if (!file) return;
      e.preventDefault(); void choose(file);
    };
    composer?.addEventListener('paste', paste); return () => composer?.removeEventListener('paste', paste);
  });
  function transfer(file: File, draft: UploadDraft = { file, requestId: crypto.randomUUID() }) {
    const controller = new AbortController(); setAbort(controller); setBusy(true); setPicture(null);
    locked.current = true; setPaused(draft);
    void uploadAttachment(file, conversationId, controller.signal, setUploaded, draft).then(value => {
      if (mounted.current) { change(previous => [...previous, value]); setPaused(undefined); setUploaded(0); }
    }).catch(async cause => {
      if (!mounted.current) return;
      if (cause.status === 410 || draft.reserved && !draft.reserved.resumable) {
        await cancelAttachmentUpload(conversationId, draft).catch(() => {}); setPaused(undefined);
      }
      if (!controller.signal.aborted) error(cause);
    }).finally(() => { locked.current = false; if (mounted.current) { setBusy(false); setAbort(null); setUsageRevision(value => value + 1); } });
  }
  async function choose(file: File) {
    if (locked.current || picture || paused) { error(new Error(tr('Finish or cancel the current attachment first.'))); return; }
    if (files.length >= 4) { error(new Error(tr('You can attach up to four files to one message.'))); return; }
    if (file.size > 100 * 1048576) { error(new Error('Files must be at most 100 MiB.')); return; }
    locked.current = true;
    setBusy(true);
    try { const compressed = await compressPicture(file); if (!mounted.current) return; if (compressed) { setPicture({ original: file, compressed, url: URL.createObjectURL(compressed) }); setBusy(false); } else transfer(file); }
    catch { if (mounted.current) transfer(file); }
  }
  return <div className="file-composer" ref={element}><div className="upload-tools"><label className="upload-attach" title={tr('Attach file')}><Paperclip size={16}/><span className="upload-label">{tr('Attach file')}</span><input type="file" disabled={busy || Boolean(picture || paused) || files.length >= 4} accept=".pdf,.txt,.md,.csv,.json,.zip,.7z,.png,.jpg,.jpeg,.webp,.gif,.mp3,.ogg,.wav,.mp4,.webm" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void choose(file); }}/></label>{busy && abort && <button type="button" className="secondary" onClick={() => abort.abort()}>{tr('Pause upload')}</button>}<UploadAllowance revision={usageRevision}/></div>{paused && <div className="compression-preview"><strong dir="auto">{paused.file.name}</strong><progress aria-label={tr("Upload progress")} max={paused.file.size} value={uploaded}/>{!busy && <><button type="button" className="secondary" onClick={() => transfer(paused.file, paused)}>{tr("Resume upload")}</button><button type="button" className="secondary" onClick={() => { void cancelAttachmentUpload(conversationId, paused).then(() => { setPaused(undefined); setUploaded(0); setUsageRevision(value => value + 1); }).catch(error); }}>{tr("Cancel upload")}</button></>}</div>}{picture && <div className="compression-preview"><img src={picture.url} alt={tr('Compressed picture preview')}/><p>{tr('Picture compressed on this device. Review quality before uploading.')}</p><p className="compression-sizes"><span>{tr("Original: {size}", { size: formatFileSize(picture.original.size) })}</span><br/><span>{tr("Compressed: {size}", { size: formatFileSize(picture.compressed.size) })}</span></p><button type="button" className="secondary" onClick={() => transfer(picture.compressed)}>{tr('Upload compressed picture')}</button><button type="button" className="secondary" onClick={() => transfer(picture.original)}>{tr('Upload original')}</button><button type="button" className="secondary" onClick={() => { locked.current = false; setPicture(null); }}>{tr('Cancel upload')}</button></div>}{files.map(a => <span className="attachment-draft" key={a.id}>{a.name}<button type="button" aria-label={tr('Remove attachment')} onClick={() => { void request(`/attachments/${a.id}`, {}, 'DELETE').then(() => change(previous => previous.filter(f => f.id !== a.id))).catch(error); }}>×</button></span>)}</div>;
}
export function MessageAttachments({ files, conversation, error }: { files?: Attachment[]; conversation: string; error: (e: unknown) => void }) {
  return <div className="message-attachments">{files?.map(file => <AttachmentCard key={file.id} file={file} conversation={conversation} error={error}/>)}</div>;
}
export function Tags({ tags }: { tags?: Tag[] }) { return <span className="user-tags">{tags?.map(t => <span key={t.id} style={{ borderColor: t.color }} dir="auto">{t.name}</span>)}</span>; }
export function VoicePolicy({ channel, refresh, error }: { channel: Channel; refresh: () => Promise<void>; error: (e: unknown) => void }) {
  const [locked, setLocked] = useState(Boolean(channel.locked)), [limit, setLimit] = useState(channel.userLimit || 16), [mode, setMode] = useState(channel.tagMode || 'ANY'), [required, setRequired] = useState<string[]>(channel.requiredTags || []), [tags, setTags] = useState<Tag[]>([]);
  useEffect(() => { void request(`/servers/${channel.serverId}/tags`).then(v => setTags(v.tags)).catch(error); }, [channel.serverId]);
  if (channel.kind !== 'voice' || !channel.permissions.manageChannels) return null;
  return <form className="settings-voice-policy" onSubmit={e => { e.preventDefault(); void request(`/voice/${channel.id}/policy`, { locked, userLimit: limit, tagMode: mode, requiredTags: required }, 'PATCH').then(refresh).catch(error); }}><label className="check-row"><input type="checkbox" checked={locked} onChange={e => setLocked(e.target.checked)}/>{tr("Lock new joins")}</label><label>{tr("User limit")}<input type="number" min={1} max={16} required value={limit} onChange={e => setLimit(Number(e.target.value))}/></label><label>{tr("Required tags")}<select value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="ANY">{tr("Any selected tag")}</option><option value="ALL">{tr("All selected tags")}</option></select></label>{tags.map(t => <label className="check-row" key={t.id}><input type="checkbox" checked={required.includes(t.id)} onChange={e => setRequired(old => e.target.checked ? [...old, t.id] : old.filter(id => id !== t.id))}/>{t.name}</label>)}<p>{tr("No selected tags means normal role permissions apply. Owners retain access. Removing a required member tag disconnects that member immediately.")}</p><button className="secondary">{tr("Save voice settings")}</button></form>;
}
export function VoiceModeration({ room, channels, account, open }: {
  room: VoiceRoom;
  channels: Channel[];
  account: string;
  open: (user: PublicUser, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const channel = channels.find(c => c.id === room.channelId);
  const members = room.members.filter(member => member.user.id !== account && member.user.kind !== 'music');
  if (!channel?.permissions.moderate || members.length === 0) return null;
  return <details><summary>{tr('Voice moderation')}</summary>
    <div className="voice-moderation">
      {members.map(({ user }) => <button key={user.id} className="secondary" aria-haspopup="menu" onClick={event => open(user, event)}>
        <bdi>{user.displayName}</bdi>
      </button>)}
    </div>
  </details>;
}
