import { AttachmentCard } from './AttachmentMedia';
import { compressPicture } from './image-compression';
import { t as tr, formatFileSize } from './i18n';
import { useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import type { Attachment, Channel, PublicUser, Tag, VoiceRoom } from '@dorham/contracts';
import { cancelAttachmentUpload, request, uploadAttachment, type UploadDraft } from './api';
import { readLocal, saveUpload, storageScope, subscribeStorage } from './offline-storage';
import { FolderOpen, Images, Paperclip, X } from 'lucide-react';
import { UploadAllowance } from './UploadAllowance';
import './android-attachments.css';

const fileTypes = '.pdf,.txt,.md,.csv,.json,.zip,.7z,.png,.jpg,.jpeg,.webp,.gif,.mp3,.ogg,.wav,.mp4,.webm';
type AndroidPicker = { open: boolean; close: () => void; setPending: (pending: boolean) => void };
const activeUploads = new Map<string, { scope: string; controller: AbortController; draft: UploadDraft; uploaded: number }>();
const announceUpload = (key: string) => window.dispatchEvent(new CustomEvent('dorham-upload-state', { detail: key }));
subscribeStorage(() => {
  const current = storageScope();
  for (const upload of activeUploads.values()) {
    if (upload.scope !== current) upload.controller.abort();
  }
});

export function FileComposer({ conversationId, files, change, error, androidPicker, fileInput, setPending, sharedImage, clearSharedImage }: { conversationId: string; files: Attachment[]; change: (files: Attachment[] | ((previous: Attachment[]) => Attachment[])) => void; error: (e: unknown) => void; androidPicker?: AndroidPicker; fileInput?: RefObject<HTMLInputElement | null>; setPending?: (pending: boolean) => void; sharedImage?: File; clearSharedImage?: () => void }) {
  const [busy, setBusy] = useState(false), [abort, setAbort] = useState<AbortController | null>(null), [picture, setPicture] = useState<{ original: File; compressed: File; url: string } | null>(null);
  const [usageRevision, setUsageRevision] = useState(0);
  const [paused, setPaused] = useState<UploadDraft>();
  const [uploaded, setUploaded] = useState(0);
  const [queued, setQueued] = useState(0);
  const scope = storageScope();
  const transferKey = JSON.stringify([scope, conversationId]);
  const element = useRef<HTMLDivElement>(null), locked = useRef(false), mounted = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null), galleryInput = useRef<HTMLInputElement>(null), filesInput = useRef<HTMLInputElement>(null);
  const queue = useRef<{ items: File[]; gallery: boolean }>({ items: [], gallery: false });
  const updatePending = setPending ?? androidPicker?.setPending;
  const pending = busy || Boolean(picture || paused) || queued > 0;
  useEffect(() => { updatePending?.(pending); return () => updatePending?.(false); }, [pending, updatePending]);
  useEffect(() => {
    const sheet = dialog.current;
    if (!sheet || !androidPicker?.open) return;
    sheet.showModal();
    return () => sheet.close();
  }, [androidPicker?.open]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { let active = true; void readLocal<UploadDraft>(scope, 'upload', conversationId).then(draft => { if (active && !locked.current) setPaused(draft); }); return () => { active = false; }; }, [scope, conversationId]);
  useEffect(() => {
    const adopt = () => {
      const running = activeUploads.get(transferKey);
      setAbort(running?.controller ?? null);
      setBusy(Boolean(running));
      if (running) { setPaused(running.draft); setUploaded(running.uploaded); }
      else void readLocal<UploadDraft>(scope, 'upload', conversationId).then(draft => {
        if (mounted.current && !activeUploads.has(transferKey)) setPaused(draft);
      });
    };
    const listener = (event: Event) => {
      if ((event as CustomEvent).detail === transferKey) adopt();
    };
    if (activeUploads.has(transferKey)) adopt();
    window.addEventListener('dorham-upload-state', listener);
    return () => window.removeEventListener('dorham-upload-state', listener);
  }, [transferKey, scope, conversationId]);
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
    if (storageScope() !== scope || activeUploads.has(transferKey)) return;
    const controller = new AbortController(); setAbort(controller); setBusy(true); setPicture(null);
    locked.current = true; setPaused(draft);
    const upload = { scope, controller, draft, uploaded: 0 };
    activeUploads.set(transferKey, upload);
    announceUpload(transferKey);
    let advance = false;
    void uploadAttachment(file, conversationId, controller.signal, bytes => {
      upload.uploaded = bytes; announceUpload(transferKey);
    }, draft).then(value => {
      if (storageScope() !== scope) return;
      advance = true;
      change(previous => previous.length < 4 && !previous.some(file => file.id === value.id) ? [...previous, value] : previous);
    }).catch(async cause => {
      if (storageScope() !== scope) return;
      if (cause.status === 410 || draft.reserved && !draft.reserved.resumable) {
        await cancelAttachmentUpload(conversationId, draft).catch(() => {});
        const restart = { file, requestId: crypto.randomUUID() };
        await saveUpload(scope, conversationId, restart).catch(() => {});
      }
      if (!controller.signal.aborted) error(cause);
    }).finally(() => {
      activeUploads.delete(transferKey);
      locked.current = false;
      announceUpload(transferKey);
      if (mounted.current) { setBusy(false); setAbort(null); setUploaded(0); setUsageRevision(value => value + 1); }
      if (advance && storageScope() === scope) void nextAndroidFile();
    });
  }
  async function nextAndroidFile() {
    const file = queue.current.items.shift();
    if (mounted.current) setQueued(queue.current.items.length);
    if (!file) return;
    locked.current = true;
    if (mounted.current) { setBusy(true); updatePending?.(true); }
    const upload = queue.current.gallery ? await compressPicture(file).catch(() => null) || file : file;
    if (storageScope() === scope) transfer(upload);
  }
  function selectAndroidFiles(input: HTMLInputElement, gallery: boolean) {
    const picked = [...(input.files || [])];
    input.value = '';
    if (locked.current || pending || !picked.length) return;
    const valid = picked.filter(file => file.size > 0 && file.size <= 100 * 1048576 &&
      fileTypes.split(',').includes(file.name.slice(file.name.lastIndexOf('.')).toLowerCase()));
    if (valid.length !== picked.length) error(new Error(tr('Some files were skipped. Choose a supported format up to 100 MiB.')));
    const remaining = 4 - files.length;
    if (valid.length > remaining) error(new Error(tr('You can attach up to four files to one message.')));
    queue.current = { items: valid.slice(0, remaining), gallery };
    void nextAndroidFile();
  }
  function showPicker(input: HTMLInputElement | null) {
    dialog.current?.close();
    androidPicker?.close();
    input?.click();
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
  function attachSharedImage() {
    if (!sharedImage || pending || files.length >= 4) return;
    clearSharedImage?.();
    void choose(sharedImage);
  }
  return <div className="file-composer" ref={element}>{sharedImage && <div className="upload-tools"><button type="button" className="secondary" disabled={pending || files.length >= 4} onClick={attachSharedImage}>{tr('Attach shared photo')}</button><button type="button" className="icon-button" aria-label={tr('Dismiss shared photo')} onClick={clearSharedImage}><X size={16}/></button></div>}<div className="upload-tools">{!androidPicker && <label className="upload-attach" title={tr('Attach file')}><Paperclip size={16}/><span className="upload-label">{tr('Attach file')}</span><input ref={fileInput} type="file" disabled={busy || Boolean(picture || paused) || files.length >= 4} accept={fileTypes} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void choose(file); }}/></label>}{busy && abort && <button type="button" className="secondary" onClick={() => abort.abort()}>{tr('Pause upload')}</button>}<UploadAllowance revision={usageRevision}/></div>
    {androidPicker && <>
      <input ref={galleryInput} type="file" hidden multiple accept="image/*,video/*" onChange={e => selectAndroidFiles(e.currentTarget, true)}/>
      <input ref={filesInput} type="file" hidden multiple accept={fileTypes} onChange={e => selectAndroidFiles(e.currentTarget, false)}/>
      <dialog ref={dialog} className="android-attachment-sheet" aria-label={tr('Add attachments')}
        onCancel={e => { e.preventDefault(); androidPicker.close(); }}
        onClick={e => { if (e.target === e.currentTarget) androidPicker.close(); }}>
        <div className="android-attachment-panel">
          <header><h2>{tr('Add attachments')}</h2><button type="button" className="icon-button" aria-label={tr('Close dialog')} onClick={androidPicker.close}><X size={20}/></button></header>
          {pending && <p role="status">{tr('Finish or cancel the current attachment first.')}</p>}
          <div className="android-attachment-options">
            <button type="button" disabled={pending} onClick={() => showPicker(galleryInput.current)}><Images size={23}/><span><strong>{tr('Gallery')}</strong><small>{tr('Photos and videos')}</small></span></button>
            <button type="button" disabled={pending} onClick={() => showPicker(filesInput.current)}><FolderOpen size={23}/><span><strong>{tr('Files')}</strong><small>{tr('Documents and original media')}</small></span></button>
          </div>
        </div>
      </dialog>
      {queued > 0 && <div className="attachment-queue">
        <span role="status">{tr('{count} attachments waiting', { count: String(queued) })}</span>
        <button type="button" className="secondary" onClick={() => { queue.current.items = []; setQueued(0); }}>{tr('Clear queue')}</button>
      </div>}
    </>}
    {paused && <div className="compression-preview"><strong dir="auto">{paused.file.name}</strong><progress aria-label={tr("Upload progress")} max={paused.file.size} value={uploaded}/>{!busy && <><button type="button" className="secondary" onClick={() => transfer(paused.file, paused)}>{tr("Resume upload")}</button><button type="button" className="secondary" onClick={() => { void cancelAttachmentUpload(conversationId, paused).then(() => { setPaused(undefined); setUploaded(0); setUsageRevision(value => value + 1); void nextAndroidFile(); }).catch(error); }}>{tr("Cancel upload")}</button></>}</div>}{picture && <div className="compression-preview"><img src={picture.url} alt={tr('Compressed picture preview')}/><p>{tr('Picture compressed on this device. Review quality before uploading.')}</p><p className="compression-sizes"><span>{tr("Original: {size}", { size: formatFileSize(picture.original.size) })}</span><br/><span>{tr("Compressed: {size}", { size: formatFileSize(picture.compressed.size) })}</span></p><button type="button" className="secondary" onClick={() => transfer(picture.compressed)}>{tr('Upload compressed picture')}</button><button type="button" className="secondary" onClick={() => transfer(picture.original)}>{tr('Upload original')}</button><button type="button" className="secondary" onClick={() => { locked.current = false; setPicture(null); }}>{tr('Cancel upload')}</button></div>}{files.map(a => <span className="attachment-draft" key={a.id}>{a.name}<button type="button" aria-label={tr('Remove attachment')} onClick={() => { void request(`/attachments/${a.id}`, {}, 'DELETE').then(() => change(previous => previous.filter(f => f.id !== a.id))).catch(error); }}>×</button></span>)}</div>;
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
