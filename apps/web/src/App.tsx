import { useMemberModeration } from './MemberContextMenu';
import { MemberListRow } from './MemberListRow';
import { MusicVoiceButton, MusicBotRow } from './MusicQuickControls';
import { initialMusicLevel, MUSIC_ID, useMusicListening } from './music-state';
import { AndroidDownloadStatus } from './AndroidDownloadStatus';
import { notifyAndroidMessage, consumeAndroidLink, useAndroidNotifications, AndroidChatNotifications, allowAndroidMessageAlert } from './AndroidNotifications';
import { MobileSheet, MobileCallBar, MobileNavigation, ParticipantList, useMobileLayout, voiceMemberStatus, VoiceMemberStatusIcon } from './MobileExperience';
import { CopyMessageButton } from './CopyMessageButton';
import { WindowsOverlayBridge } from './WindowsVoiceOverlay';
import { FeatureAnnouncements, FeatureContext, RankBadge, useFeatureState } from './Features';
import { showSoundboard, Soundboard, useSoundboard } from './Soundboard';
import { useVoiceTts } from './VoiceTts';
import { reactionValue, reactionEmojiId } from '../../../packages/contracts/src/emoji-reactions';
import { EmojiGlyph, EmojiPicker } from './EmojiPicker';
import { MessageComposer } from './MessageComposer';
import { acceptLatencies, latencyStore, speakingStore, SpeakingButton } from './LiveStatus';
import { ReleaseActions } from './ReleaseActions';
import { readBoostNoise } from './microphone-preferences';
import { SignedInPasswordReset } from './SignedInPasswordReset';
import { RecoverySetup, rememberRecoveryCodes, takeInviteLanding } from './RecoverySetup';
import { readVoiceClarity } from './voice-clarity-preferences';
import { ServerIconControl } from './ServerIconControl';
import { DirectMessagesHome, orderedDirectChats } from './DirectMessagesHome';
import { DirectCallBanner, useDirectCall } from './DirectCall';
import { ScreenShareSetup } from './ScreenShareSetup';
import './update-075.css';
import { GamesProvider, GamesButton, VoiceGames } from './ChessLauncher';
import { readMicrophoneGain } from './microphone-preferences';
import { GamingVoice } from './GamingVoice';
import { useStreamAudience } from './StreamAudience';
import { useAudioRouting, readAudioChoices, saveVoiceLevel } from './AudioDevices';
import { ChannelPermissions } from './ChannelPermissions';
import { MessageHistory } from './MessageHistory';
import { useConversationDraftActions, draftStore } from './useConversationDraft';
import { useVoiceInput } from './VoiceInput';
import { ConnectionPing } from './ConnectionPing';
import { connectionProbeSchema } from '../../../packages/contracts/src/connection';
import { normalizePeopleSearch } from '../../../packages/contracts/src/persian';
import { VoiceMembershipCues } from '../../../packages/contracts/src/voice-notifications';
import { Avatar } from './UserAvatar';
import { AvatarPicker } from './AvatarPicker';
import { AudioSettings } from './AudioSettings';
import { readNoiseRemoval } from './noise-removal-preferences';
import { AccountSettings } from './AccountSettings';
import { ServerSettings, type ServerSection } from './ServerSettings';
import { unlockSounds, playCue } from './notifications';
import './social.css';
import { t as tr } from './i18n';
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { activateStorage, readLocal, rememberedAccount, removeLocal, retainLocalConversations, saveHistory, saveLocalSession, signOutStorage, storageAccountChanged, storageScope, storageSettings, subscribeStorage, type OfflineHistory } from './offline-storage';
import { setMediaTransferPolicy } from '../../../packages/media/src/network-pressure';
import { QueuedMessages, useOutbox } from './outbox';
import { StorageSettings } from './StorageSettings';
import { WhatsNew, useUpdateNotice } from './WhatsNew';
import { AppearanceSettings } from './Appearance';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { PanelRightClose, PanelRightOpen, MessageCircle, Plus, Hash, Volume2, Settings, Mic, MicOff, Headphones, HeadphoneOff, MonitorUp, AudioLines, Phone, PhoneOff, X, ChevronDown, Users, Search, Reply, Pencil, Trash2, Copy, Check, ArrowRight, Radio, ShieldCheck, Menu, Activity, Download, Globe, Sparkles } from 'lucide-react';
import type { Channel, Server, PublicUser, Message, ConversationEvent, VoiceRoom, VoicePresence, ServerMember } from '@dorham/contracts';
import { DeferredTransport } from '../../../packages/media/src/deferred';
import { ack } from '../../../packages/media/src/signaling';
import type { MediaTransport, RemoteScreen, MediaEvents } from '@dorham/media';
import type { Socket } from 'socket.io-client';
import { request, initialize, serverUrl, assetUrl, signOut, connectSocket, maintainSession, forgetSession } from './api';
import { readAudioProcessingPreferences } from './AudioProcessingControls';
import './voice-layout.css';
import { MessageContent } from './MessageContent';
import { AccessEntry, TemporaryPassword } from './AccountControls';
import { MessageAttachments, Tags, VoiceModeration } from './ExpansionControls';
import { formatMessageTime, useLanguage, setLanguage, currentLanguage, translatedError, formatNumber } from './i18n';
import './expansion.css';
import { channelLink } from '../../../packages/contracts/src/links';
import { readScreenPreferences, saveScreenPreferences, screenSummary } from './ScreenShareSettings';

const MusicPanel = lazy(() => import('./MusicPanel').then(module => ({ default: module.MusicPanel })));

type Snapshot = { me: PublicUser; servers: Server[]; channels: Channel[]; dms: { id: string; user: PublicUser; lastMessageAt?: number; blocked?: boolean; blockedByMe?: boolean }[]; blockedUsers?: PublicUser[]; users: PublicUser[]; deletedUserIds?: string[]; unread: Record<string, { sequence: number; readSequence: number }>; mediaTransport: 'mesh' | 'livekit'; directCalls?: boolean; screenPolicy?: { maxBitrate: number; maxFrameRate: number }; voicePresence?: VoicePresence[]; bootstrapVersion?: string };
type UnchangedSnapshot = { unchanged: true; bootstrapVersion: string; voicePresence?: VoicePresence[] };
const missingBrowserShareAudio = 'Sharing without sound. Enable audio in the browser picker next time.';
const deletedAuthor = (id: string): PublicUser => ({ id, username: '', displayName: tr('Deleted account'), bio: '', avatar: null, status: 'offline', deleted: true });
type ModalType = 'server' | 'join' | 'settings' | 'manage' | 'people' | 'diagnostics' | null;

function IconButton({ title, children, onClick, active = false, danger = false, disabled = false }: { title: string; children: ReactNode; onClick?: () => void; active?: boolean; danger?: boolean; disabled?: boolean }) { return <button type="button" title={title} aria-label={title} className={`icon-button ${active ? 'active' : ''} ${danger ? 'danger' : ''}`} onClick={onClick} disabled={disabled}>{children}</button>; }
function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null), closeRef = useRef(close); closeRef.current = close;
  useLayoutEffect(() => { const node = dialog.current!, previous = document.activeElement as HTMLElement | null; node.showModal(); return () => { node.close(); if (previous?.isConnected) previous.focus(); }; }, []);
  return <dialog ref={dialog} aria-modal="true" aria-label={title} className="modal-backdrop" onCancel={e => { e.preventDefault(); closeRef.current(); }} onMouseDown={e => { if (e.target === e.currentTarget) closeRef.current(); }}><div className={`modal ${wide ? 'wide' : ''}`}><header><div><span className="eyebrow">{tr('YOUR SPACE')}</span><h2>{title}</h2></div><IconButton title={tr('Close dialog')} onClick={close}><X/></IconButton></header>{children}</div></dialog>;
}

function Auth({ onLogin, onError, compact }: { onLogin: () => Promise<void>; onError: (error: unknown) => void; compact: boolean }) {
  const [register, setRegister] = useState(false), [busy, setBusy] = useState(false), [username, setUsername] = useState(''), [displayName, setDisplayName] = useState(''), [password, setPassword] = useState('');
  async function submit(e: FormEvent) { e.preventDefault(); setBusy(true); try { const auth = await request(`/auth/${register ? 'register' : 'login'}`, { username, password, ...(register ? { displayName, language: currentLanguage() } : {}) }); rememberRecoveryCodes(auth.user.id, auth.recoveryCodes); await onLogin(); } catch (e) { onError(e); } finally { setBusy(false); } }
  return <div className={compact ? "auth-page phone-web-auth" : "auth-page"}><section className="auth-story"><div className="brand"><img src="./icon.svg" alt="" />dorham<span>{tr("BETA")}</span></div><div className="story-copy"><span className="eyebrow">{tr("GOOD COMPANY. GREAT CONVERSATIONS.")}</span><h1>{tr("A little")}<br /><em>{tr("closer.")}</em></h1><p>{tr("Your people, your own space.")}<br />{tr("Drop in, catch up, and share what’s happening.")}</p><div className="orbit-art" aria-hidden="true"><div className="orbit one"/><div className="orbit two"/><div className="orbit three"/><div className="orb center"><Volume2 size={48}/></div><div className="orb a"><MessageCircle/></div><div className="orb b"><MonitorUp/></div><div className="orb c"><Headphones/></div><div className="orbit-label"><i/> {tr("A conversation starts here")}</div></div></div><footer><span><ShieldCheck size={15}/> {tr("Your community, on your terms")}</span><span>{tr("Text · Voice · Shared screens")}</span></footer></section><section className="auth-form-wrap"><form className="auth-form" onSubmit={e => { void submit(e); }}><span className="pill"><i/> {tr("A SPACE FOR YOUR PEOPLE")}</span><h2>{register ? tr("Make yourself at home.") : tr("Welcome back.")}</h2><p>{register ? tr("Create an account and find your people.") : tr("Good to see you. Pick up where you left off.")}</p>{register && <label>{tr("Display name")}<input required maxLength={48} autoComplete="nickname" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder={tr("What should we call you?")}/></label>}<label>{tr("Username")}<input required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_]+" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} placeholder={tr("Your username")}/></label><label>{tr("Password")}<input required type="password" minLength={8} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder={tr("At least 8 characters")}/></label><button className="primary" disabled={busy}>{busy ? tr("Connecting…") : register ? tr("Create account") : tr("Let’s get you in")}<ArrowRight size={18}/></button><div className="auth-switch">{register ? tr("Already part of the conversation?") : tr("New around here?")} <button type="button" onClick={() => setRegister(!register)}>{register ? tr("Sign in") : tr("Create an account")}</button></div><div className="auth-note"><ShieldCheck size={17}/><span>{tr("No ads. No noise.")}<br />{tr("Just a place to be together.")}</span></div></form><AccessEntry onLogin={onLogin} error={onError} prepare={async () => { }}/><ReleaseActions/></section></div>;
}

export function App() {
  const android = Capacitor.getPlatform() === 'android';
  const mobileLayout = useMobileLayout(), compact = mobileLayout !== 'wide';
  const compactWeb = !android && !window.desktop && compact;
  const [membersOpen, setMembersOpen] = useState(false), [voicePreview, setVoicePreview] = useState<Channel | null>(null);
  const language = useLanguage();
  useEffect(() => { void window.desktop?.setLanguage?.(language); }, [language]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [loading, setLoading] = useState(true), [toast, setToast] = useState(''), [online, setOnline] = useState<Set<string>>(new Set()), [connected, setConnected] = useState(false);
  useAndroidNotifications(snapshot?.me.id, language);
  const [serverId, setServerId] = useState<string | null>(null), [conversationId, setConversationId] = useState<string | null>(null), [messages, setMessages] = useState<Message[]>([]), [hasMore, setHasMore] = useState(false), [historyBusy, setHistoryBusy] = useState(false);
  const [historyJump, setHistoryJump] = useState(0);
  const [authReady, setAuthReady] = useState(false), [cachedView, setCachedView] = useState(false);
  const [restoringSession, setRestoringSession] = useState(false);
  const openedHistory = useRef(''), sessionGeneration = useRef(0);
  const synchronizing = useRef(new Set<string>());
  const [invitedVoice, setInvitedVoice] = useState<Channel | null>(null);
  const { read: readDraft, setDraft, setReply, setEditing, setPendingFiles, setPendingSend } = useConversationDraftActions(snapshot?.me.id, serverUrl() || location.origin, conversationId);
  const [sending, setSending] = useState(false), [typing, setTyping] = useState<Record<string, number>>({});
  const unreadStart = useRef({ key: '', sequence: 0 });
  if (unreadStart.current.key !== `${snapshot?.me.id}:${conversationId}`) unreadStart.current = { key: `${snapshot?.me.id}:${conversationId}`, sequence: snapshot?.unread[conversationId || '']?.readSequence || 0 };
  const readPending = useRef<Record<string, number>>({}), readTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const historyRequest = useRef<AbortController | null>(null);
  const authors = useMemo(() => {
    const users = new Map(snapshot?.users.map(u => [u.id, u]) || []);
    for (const id of snapshot?.deletedUserIds || []) users.set(id, deletedAuthor(id));
    return users;
  }, [snapshot?.users, snapshot?.deletedUserIds]);
  const [membersCollapsed, setMembersCollapsed] = useState(() => { try { return localStorage.getItem('dorham-members-collapsed') === 'true'; } catch { return false; } }), [previewOwn, setPreviewOwn] = useState(() => { try { return localStorage.getItem('dorham-own-screen-preview') === 'true'; } catch { return false; } }), [localScreen, setLocalScreen] = useState<RemoteScreen | null>(null);
  const [messageNotice, setMessageNotice] = useState<{ conversationId: string; author: string; serverId?: string; channel?: string } | null>(null);
  const liveMessageSequences = useRef<Record<string, number>>({}), voiceCues = useRef(new VoiceMembershipCues()), joining = useRef(false);
  useEffect(() => { const unlock = () => unlockSounds(); window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock); return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); }; }, []);
  const [viewerOpen, setViewerOpen] = useState(false), [chatOpen, setChatOpen] = useState(false), [shareSetup, setShareSetup] = useState(false);
  const [modal, setModal] = useState<ModalType>(null), [profile, setProfile] = useState<PublicUser | null>(null), [members, setMembers] = useState<ServerMember[]>([]), [search, setSearch] = useState(''), [mobileNav, setMobileNav] = useState(false);
  const [serverSettings, setServerSettings] = useState<{ section?: ServerSection; kind?: 'text' | 'voice' }>();
  function openServerSettings(section?: ServerSection, kind?: 'text' | 'voice') {
    setServerSettings({ section, kind });
    setModal('manage');
  }
  const [membersServer, setMembersServer] = useState<string | null>(null);
  const [memberRevision, setMemberRevision] = useState(0);
  const readObscured = useRef(false); readObscured.current = Boolean(modal || profile);
  const [ttsSend, setTtsSend] = useState(false), [ttsEnabled, setTtsEnabled] = useState(true);
  const [room, setRoom] = useState<VoiceRoom | null>(null), [voiceStatus, setVoiceStatus] = useState(''), [listenOnly, setListenOnly] = useState(false), [screens, setScreens] = useState<Record<string, RemoteScreen>>({}), [deafened, setDeafened] = useState(false), [volumes, setVolumes] = useState<Record<string, number>>({}), [sharingBusy, setSharingBusy] = useState(false), [voiceBusy, setVoiceBusy] = useState(false), [screenPreferences,setScreenPreferences]=useState(readScreenPreferences), [stats, setStats] = useState<Record<string, any>>({});
  const setSpeaking = speakingStore.replace;
  useEffect(() => { setShareSetup(false); }, [room?.channelId]);
  const socket = useRef<Socket | null>(null), media = useRef<MediaTransport | null>(null), current = useRef<string | null>(null), sequence = useRef<Record<string, number>>({}), snapshotRef = useRef<Snapshot | null>(null), roomRef = useRef<VoiceRoom | null>(null), scroll = useRef<HTMLDivElement>(null), bottom = useRef<HTMLDivElement>(null), lastTyping = useRef(0), refreshPromise = useRef<Promise<void> | null>(null), refreshPending = useRef(false);
  useEffect(() => {
    const revoked = () => {
      const origin = serverUrl() || location.origin, account = snapshotRef.current?.me.id || rememberedAccount(origin);
      if (account) { draftStore().clear(account, origin); void signOutStorage(origin, account).catch(() => {}); }
      sessionGeneration.current++; setAuthReady(false); setCachedView(false); setRestoringSession(false); void forgetSession(); void media.current?.leave(); socket.current?.disconnect(); setSnapshot(null); setMessages([]); setServerId(null); setConversationId(null); setModal(null); setRoom(null); setScreens({});
    };
    const accountChanged = (event: StorageEvent) => { const account = snapshotRef.current?.me.id; if (account && storageAccountChanged(event, serverUrl() || location.origin, account)) revoked(); };
    window.addEventListener('dorham-session-revoked', revoked);
    window.addEventListener('storage', accountChanged);
    return () => { window.removeEventListener('dorham-session-revoked', revoked); window.removeEventListener('storage', accountChanged); };
  }, []);
  current.current = conversationId; snapshotRef.current = snapshot; roomRef.current = room;
  function error(e: any) { setToast(translatedError(e)); }
  const [audioTesting, setAudioTesting] = useState(false);
  useEffect(() => { const changed = (e: Event) => setAudioTesting(Boolean((e as CustomEvent).detail)); window.addEventListener('dorham-audio-test', changed); return () => window.removeEventListener('dorham-audio-test', changed); }, []);
  const direct = useDirectCall(error);
  const directActive = direct.call?.phase === 'active';
  const voiceTarget = useRef<Pick<MediaTransport, 'setMuted'>>(null);
  voiceTarget.current = { setMuted: async value => {
    if (direct.isActive()) await direct.setMuted(value);
    else await media.current?.setMuted(value);
  } };
  const voiceInput = useVoiceInput(voiceTarget, Boolean(room) || directActive, error, setToast), muted = voiceInput.muted || audioTesting || listenOnly;
  const inCall = Boolean(room) || directActive;
  const dataSaver = useSyncExternalStore(subscribeStorage, () => storageSettings().dataSaver);
  useEffect(() => {
    setMediaTransferPolicy(inCall, dataSaver);
    if (Capacitor.getPlatform() === 'android' && inCall) void registerPlugin<{ setDataSaver(options: { enabled: boolean }): Promise<void> }>('DorhamMedia').setDataSaver({ enabled: dataSaver }).catch(() => {});
  }, [inCall, dataSaver]);
  useEffect(() => () => setMediaTransferPolicy(false, false), []);
  useEffect(() => { window.desktop?.setInCall(inCall); }, [inCall]);
  useEffect(() => {
    if (modal !== 'diagnostics') return;
    let stopped = false;
    const collect = () => { if (!document.hidden) void media.current?.getStats().then(value => { if (!stopped) setStats(value); }).catch(() => {}); };
    collect(); const timer = setInterval(collect, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [modal, room?.channelId]);
  async function run(fn: () => Promise<unknown>) { try { await fn(); } catch (e) { error(e); } }
  function rememberSnapshot(data: Snapshot) {
    const origin = serverUrl() || location.origin;
    const old = rememberedAccount(origin);
    if (old && old !== data.me.id) void signOutStorage(origin, old).catch(() => {});
    const scope = activateStorage(origin, data.me.id);
    const allowed = new Set([...data.channels.map(channel => channel.conversationId).filter(Boolean), ...data.dms.map(dm => dm.id)] as string[]);
    draftStore().retain(data.me.id, origin, allowed);
    const { me, servers, channels, dms, users, unread, mediaTransport, blockedUsers, deletedUserIds, directCalls, screenPolicy, bootstrapVersion } = data;
    void saveLocalSession(scope, { me, servers, channels, dms, users, unread, mediaTransport, blockedUsers, deletedUserIds, directCalls, screenPolicy, bootstrapVersion }).catch(() => {});
    void retainLocalConversations(scope, allowed).catch(() => {});
    setAuthReady(true); setRestoringSession(false); setSnapshot(data);
  }
  async function refresh() {
    if (refreshPromise.current) { refreshPending.current = true; return refreshPromise.current; }
    const generation = sessionGeneration.current;
    refreshPromise.current = (async () => { do { refreshPending.current = false;
       let response: Snapshot | UnchangedSnapshot;
       const known = snapshotRef.current?.bootstrapVersion || '';
       try { response = await request<Snapshot | UnchangedSnapshot>(`/bootstrap?sync=1&known=${encodeURIComponent(known)}`); }
       catch (e: any) { if (e.code !== 'PASSWORD_CHANGE_REQUIRED') throw e; const identity = await request('/auth/me'); if (generation === sessionGeneration.current) rememberSnapshot({ me: identity.user, servers: [], channels: [], dms: [], users: [], unread: {}, mediaTransport: 'livekit' }); return; }
       if (generation !== sessionGeneration.current) return;
       if ('unchanged' in response) {
         const retained = response;
         setSnapshot(previous => previous?.bootstrapVersion === retained.bootstrapVersion ? { ...previous, voicePresence: retained.voicePresence } : previous);
         setAuthReady(true); setRestoringSession(false);
         void request('/presence').then(presence => { if (generation === sessionGeneration.current) { setOnline(new Set(presence.online)); acceptLatencies(presence.latencies); } }).catch(() => {});
         continue;
       }
       const data = response;
       rememberSnapshot(data);
      setConversationId(previous => previous && !data.channels.some(c => c.conversationId === previous) && !data.dms.some(d => d.id === previous) ? null : previous);
      const users = new Map(data.users.map(u => [u.id, u])); users.set(data.me.id, data.me);
      const deleted = new Set(data.deletedUserIds);
      setMessages(old => old.map(m => {
        const author = deleted.has(m.author.id) ? deletedAuthor(m.author.id) : users.get(m.author.id) || m.author;
        const mentions = m.mentions?.some(mention => deleted.has(mention.userId)) ? m.mentions.filter(mention => !deleted.has(mention.userId)) : m.mentions;
        const reactions = m.reactions.some(reaction => reaction.userIds.some(id => deleted.has(id)))
          ? m.reactions.map(reaction => ({ ...reaction, userIds: reaction.userIds.filter(id => !deleted.has(id)) })).filter(reaction => reaction.userIds.length)
          : m.reactions;
        return { ...m, author, mentions, reactions };
      }));
      setProfile(old => old && !deleted.has(old.id) ? users.get(old.id) || old : null);
      setRoom(old => old ? { ...old, members: old.members.map(m => ({ ...m, user: users.get(m.user.id) || m.user })) } : null);
       if (data.me.language) setLanguage(data.me.language);
       void request('/presence').then(presence => { if (generation === sessionGeneration.current) { setOnline(new Set(presence.online)); acceptLatencies(presence.latencies); } }).catch(() => {});
      } while (refreshPending.current); })();
    try { await refreshPromise.current; } finally { refreshPromise.current = null; }
  }
  async function loadHistory(cv: string, older = false) {
    if (historyBusy && older) return; setHistoryBusy(true);
    historyRequest.current?.abort(); const controller = new AbortController(); historyRequest.current = controller;
    try {
      const data = await request(`/conversations/${cv}/messages${older && messages.length ? `?before=${messages[0].sequence}` : ''}`, undefined, 'GET', true, { signal: controller.signal });
      if (current.current !== cv || controller.signal.aborted) return;
      setMessages(previous => older ? [...data.messages, ...previous.filter(m => !data.messages.some((n: Message) => n.id === m.id))].slice(0, 2000) : data.messages); setHasMore(data.hasMore);
       if (!older) { openedHistory.current = cv; sequence.current[cv] = data.sequence; setCachedView(false); setHistoryJump(n => n + 1); }
    } catch (e: any) {
      if (!controller.signal.aborted && current.current === cv) {
        if (e.status === 403 || e.status === 404) { setMessages([]); openedHistory.current = ''; setCachedView(false); void removeLocal(storageScope(), 'history', cv).catch(() => {}); }
        if (openedHistory.current !== cv || e.status === 403) error(e);
      }
    } finally { if (historyRequest.current === controller) { historyRequest.current = null; setHistoryBusy(false); } }
  }
  async function markRead(cv: string, seq: number) {
    if (document.visibilityState !== 'visible' || !document.hasFocus() || readObscured.current) return;
    if (seq <= (snapshotRef.current?.unread[cv]?.readSequence || 0)) return;
    await request(`/conversations/${cv}/read`, { sequence: seq });
    setSnapshot(s => s ? { ...s, unread: { ...s.unread, [cv]: { sequence: s.unread[cv]?.sequence || seq, readSequence: Math.max(seq, s.unread[cv]?.readSequence || 0) } } } : s);
  }
  function visibleRead(seq: number) {
    const cv = current.current; if (modal || profile || !cv || seq <= (snapshotRef.current?.unread[cv]?.readSequence || 0)) return;
    readPending.current[cv] = Math.max(seq, readPending.current[cv] || 0);
    if (!readTimer.current) readTimer.current = setTimeout(() => { readTimer.current = undefined; const pending = readPending.current; readPending.current = {}; if (document.hasFocus() && document.visibilityState === 'visible' && current.current) { const value = pending[current.current]; if (value) void markRead(current.current, value).catch(error); } }, 500);
  }
  useEffect(() => () => clearTimeout(readTimer.current), []);
  function applyEvent(event: ConversationEvent) {
    const cv = event.conversationId;
    if (cv === current.current) {
      if (event.sequence <= (sequence.current[cv] || 0)) return;
      if (event.sequence > (sequence.current[cv] || 0) + 1) { void synchronize(cv); return; }
      sequence.current[cv] = event.sequence;
      if (event.kind === 'message') { const m = event.payload as Message; setMessages(previous => { const found = previous.some(old => old.id === m.id); if (found) return previous.map(old => old.id === m.id ? m : old); const readingOld = scroll.current && scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight > 100; return previous.length >= 2000 && readingOld ? previous : [...previous, m].slice(-2000); }); }
    }
    const m = event.payload as Message;
    if (event.kind === 'message' && m.createdAt && (event.direct || snapshotRef.current?.dms.some(dm => dm.id === cv))) {
      setSnapshot(s => s ? { ...s, dms: s.dms.map(dm => dm.id === cv ? { ...dm, lastMessageAt: Math.max(dm.lastMessageAt || 0, m.createdAt) } : dm) } : s);
      if (!snapshotRef.current?.dms.some(dm => dm.id === cv)) void refresh().catch(error);
    }
    if (event.kind === 'message' && m.sequence === event.sequence && !m.deleted) setSnapshot(s => s ? { ...s, unread: { ...s.unread, [cv]: { sequence: Math.max(event.sequence, s.unread[cv]?.sequence || 0), readSequence: s.unread[cv]?.readSequence || 0 } } } : s);
  }
  async function synchronize(cv: string) {
    if (synchronizing.current.has(cv)) return;
    synchronizing.current.add(cv);
    try { let after = sequence.current[cv] || 0; for (let page = 0; page < 10; page++) { const result = await request(`/conversations/${cv}/messages?after=${after}`); if (current.current !== cv) return; if (result.reset) { await loadHistory(cv); return; } for (const event of result.events) applyEvent(event); if (!result.events.length || result.events.at(-1).sequence >= result.sequence) { setCachedView(false); return; } after = result.events.at(-1).sequence; } await loadHistory(cv); }
    catch (e: any) { if (current.current === cv && (e.status === 403 || e.status === 404)) await loadHistory(cv); }
    finally { synchronizing.current.delete(cv); }
  }
  useEffect(() => {
    let active = true;
    const resume = () => { void request('/auth/me').then(refresh).catch(() => {}); };
    void initialize().then(async () => {
      const origin = serverUrl() || location.origin, account = rememberedAccount(origin), generation = sessionGeneration.current;
      if (account) {
        if (active) setRestoringSession(true);
        const cached = await readLocal<Snapshot>(JSON.stringify([origin, account]), 'session', 'bootstrap').catch(() => undefined);
        if (active && generation === sessionGeneration.current && cached?.me.id === account && !cached.me.mustChangePassword && rememberedAccount(origin) === account) {
          activateStorage(origin, account); setSnapshot(cached); setCachedView(true); setLoading(false);
          if (cached.me.language) setLanguage(cached.me.language);
          const last = localStorage.getItem(`dorham-last-chat:${storageScope()}`);
          const channel = cached.channels.find(item => item.conversationId === last);
          if (!location.search && last && (channel || cached.dms.some(dm => dm.id === last))) { setServerId(channel?.serverId || null); setConversationId(last); }
        }
      }
      try { await request('/auth/me'); if (active) await refresh(); }
      catch { /* A cached account stays available while the server reconnects. */ }
    }).catch(() => {}).finally(() => { if (active) setLoading(false); });
    window.addEventListener('online', resume);
    return () => { active = false; window.removeEventListener('online', resume); };
  }, []);
  const outbox = useOutbox(storageScope(), authReady && !snapshot?.me.mustChangePassword, applyEvent);
  useEffect(() => {
    if (authReady || (!restoringSession && !snapshot?.me.id)) return;
    const timer = setInterval(() => { if (navigator.onLine !== false && document.visibilityState === 'visible') void request('/auth/me').then(refresh).catch(() => {}); }, 8000);
    return () => clearInterval(timer);
  }, [authReady, restoringSession, snapshot?.me.id]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), toast === missingBrowserShareAudio ? 2500 : 7000); return () => clearTimeout(t); }, [toast]);
  const userId = snapshot?.me.id;
  const [musicChannel, setMusicChannel] = useState<string>();
  const musicListening = useMusicListening(userId || null, room, media);
  const musicBot = room?.members.find(member => member.user.id === MUSIC_ID);
  const openMusic = () => { if (room?.musicAvailable) setMusicChannel(room.channelId); };
  const [removingMusic, setRemovingMusic] = useState(false);
  const removeMusic = () => {
    if (!room?.musicAvailable || !musicBot || removingMusic) return;
    setRemovingMusic(true);
    void run(() => request('/voice/' + encodeURIComponent(room.channelId) + '/music', { action: 'stop' }))
      .finally(() => setRemovingMusic(false));
  };
  const musicBotActions = { serverDeafened: musicBot?.serverDeafened, remove: removeMusic, removing: removingMusic };
  useEffect(() => { setMusicChannel(undefined); }, [room?.channelId, userId]);
  const conversationServer = snapshot?.channels.find(channel => channel.conversationId === conversationId)?.serverId || '';
  useEffect(() => { if (android) window.dispatchEvent(new CustomEvent('dorham-native-call', { detail: Boolean(room) })); }, [android, Boolean(room)]);
  useEffect(() => { latencyStore.replace({}); speakingStore.replace({}); }, [userId]);
  useAudioRouting(media, Boolean(room), userId, error);
  useEffect(() => { liveMessageSequences.current = {}; setMessageNotice(null); }, [userId]);
  useEffect(() => { if (messageNotice?.conversationId === conversationId && document.visibilityState === 'visible') setMessageNotice(null); }, [conversationId]);
  useEffect(() => {
    if (!authReady || !userId || snapshotRef.current?.me.mustChangePassword) return;
    setDeafened(false); setVolumes(readAudioChoices(userId).levels);
    const s = connectSocket(); socket.current = s;
    const detachDirectCall = direct.attach(s, userId);
    const emit = <K extends keyof MediaEvents>(kind: K, payload: MediaEvents[K]) => {
      if (kind === 'room') { const value = payload as VoiceRoom | null;
        for (const cue of voiceCues.current.transition(value?.channelId || null, value?.members.filter(m => m.user.id !== MUSIC_ID).map(m => m.user.id))) playCue(cue, snapshotRef.current?.me.status === 'busy');
        setRoom(value); if (value && snapshotRef.current?.me.id) { const levels = readAudioChoices(snapshotRef.current.me.id).levels; for (const member of value.members) if (member.user.id !== MUSIC_ID && levels[member.user.id] !== undefined) media.current?.setVolume(member.user.id, levels[member.user.id] / 100); } if (!value) { setListenOnly(false); setLocalScreen(null); setScreens({}); setSpeaking({}); } else setScreens(old => Object.fromEntries(Object.entries(old).filter(([key]) => value.shares.some(share => share.id === key)))); }
      if (kind === 'listenOnly') setListenOnly(payload as boolean);
      if (kind === 'notice') setToast(payload as string);
      if (kind === 'browserShareWithoutAudio') setToast(missingBrowserShareAudio);
      if (kind === 'localScreen') setLocalScreen(payload as RemoteScreen | null);
      if (kind === 'screen') { const screen = payload as RemoteScreen; setScreens(old => ({ ...old, [screen.leaseId]: screen })); }
      if (kind === 'screenRemoved') setScreens(old => Object.fromEntries(Object.entries(old).filter(([key]) => key !== payload)));
      if (kind === 'speaking') { const v = payload as MediaEvents['speaking']; setSpeaking(old => old[v.userId] === v.speaking ? old : { ...old, [v.userId]: v.speaking }); }
      if (kind === 'status') setVoiceStatus(payload as string);
      if (kind === 'error') error(payload);
      if (kind === 'stats') setStats(payload as Record<string, any>);
    };
    const options = { socket: s, userId, emit, initialMusicVolume: () => initialMusicLevel(userId) / 100, dataSaver: () => storageSettings().dataSaver, serverOrigin: serverUrl(), channelName: (id: string) => snapshotRef.current?.channels.find(channel => channel.id === id)?.name || 'Voice channel', audioProcessing: readAudioProcessingPreferences(), noiseRemoval: readNoiseRemoval(), microphoneGain: readMicrophoneGain(), boostNoise: readBoostNoise(), voiceClarity: readVoiceClarity(), screenPolicy: snapshotRef.current?.screenPolicy }; const transport = new DeferredTransport(Capacitor.getPlatform() === 'android' ? 'native' : snapshotRef.current?.mediaTransport === 'livekit' ? 'livekit' : 'mesh', options); media.current = transport;
    s.on('connection:probe', (body: unknown, reply: unknown) => { if (typeof reply === 'function' && connectionProbeSchema.safeParse(body).success) reply({ version: 1 }); });
    s.on('connection:latencies', acceptLatencies);
    s.on('connect', () => { setConnected(true); void refresh().catch(error); if (current.current && openedHistory.current === current.current) void synchronize(current.current); });
    let retryConnection: ReturnType<typeof setTimeout> | undefined, disposed = false;
    const retrySocket = () => {
      if (disposed || s.active || s.connected || retryConnection || navigator.onLine === false) return;
      retryConnection = setTimeout(() => {
        retryConnection = undefined;
        void request('/auth/me').then(() => { if (!disposed && !s.active && !s.connected) s.connect(); }).catch(retrySocket);
      }, 4000);
    };
    window.addEventListener('online', retrySocket);
    s.on('disconnect', () => { setConnected(false); latencyStore.replace({}); retrySocket(); });
    s.on('connect_error', e => { setConnected(false); error(e); retrySocket(); });
    s.on('voice:directory', (voicePresence: VoicePresence[]) => { for (const cue of voiceCues.current.directory(voicePresence.map(entry => ({ ...entry, members: entry.members.filter(m => m.user.id !== MUSIC_ID) })), userId)) playCue(cue, snapshotRef.current?.me.status === 'busy'); setSnapshot(old => old ? { ...old, voicePresence } : old); });
    s.on('capacity', data => error(data.message)); s.on('state:changed', () => { void refreshMemberState().catch(error); });
    s.on('presence', p => setOnline(old => { const next = new Set(old); if (p.online) next.add(p.userId); else next.delete(p.userId); return next; }));
    s.on('conversation:event', (event: ConversationEvent) => {
      if (event.sequence > (liveMessageSequences.current[event.conversationId] || 0)) {
        liveMessageSequences.current[event.conversationId] = event.sequence;
        const m = event.payload as Message;
        const channel = snapshotRef.current?.channels.find(c => c.conversationId === event.conversationId);
        const mention = event.kind === 'message' && Boolean(channel && m.mentions?.some(u => u.userId === userId));
        const direct = event.direct || snapshotRef.current?.dms.some(dm => dm.id === event.conversationId);
        if (event.kind === 'message' && m.sequence === event.sequence && m.author?.id !== userId && !m.deleted && !snapshotRef.current?.blockedUsers?.some(u => u.id === m.author.id) && (direct || mention) && (current.current !== event.conversationId || document.visibilityState !== 'visible' || !document.hasFocus() || readObscured.current) && allowAndroidMessageAlert(event.conversationId)) {
          if (snapshotRef.current?.me.status !== 'busy') void notifyAndroidMessage(event.conversationId, m.author.displayName);
          setMessageNotice({ conversationId: event.conversationId, author: snapshotRef.current?.users.find(u => u.id === m.author.id)?.displayName || m.author.displayName, ...(mention && channel ? { serverId: channel.serverId, channel: channel.name } : {}) }); playCue('message', snapshotRef.current?.me.status === 'busy');
        }
      }
      applyEvent(event);
    }); s.on('typing', t => { if (t.conversationId === current.current) setTyping(old => ({ ...old, [t.userId]: t.active ? Date.now() + 5000 : 0 })); });
    const meter = setInterval(() => { setTyping(old => Object.values(old).some(expiry => expiry <= Date.now()) ? Object.fromEntries(Object.entries(old).filter(([, expiry]) => expiry > Date.now())) : old); }, 5000);
    const pulse = () => { void maintainSession().catch(error); };
    const authTimer = setInterval(pulse, 60000); window.addEventListener('dorham-native-pulse', pulse);
    return () => { disposed = true; clearTimeout(retryConnection); window.removeEventListener('online', retrySocket); clearInterval(authTimer); window.removeEventListener('dorham-native-pulse', pulse); clearInterval(meter); detachDirectCall(); void transport.destroy(); s.removeAllListeners(); s.disconnect(); socket.current = null; media.current = null; };
  }, [authReady, userId, snapshot?.me.mustChangePassword]);
  useEffect(() => {
    let disposed = false;
    const scope = storageScope();
    setTyping({}); setMessages([]); setHasMore(false); setCachedView(false); openedHistory.current = '';
    if (conversationId && scope) {
      const id = conversationId;
      try { localStorage.setItem(`dorham-last-chat:${scope}`, id); } catch { /* The cache is optional. */ }
      void readLocal<OfflineHistory>(scope, 'history', id).then(async saved => {
        if (disposed || current.current !== id || storageScope() !== scope) return;
        if (openedHistory.current === id) return;
        if (saved) {
          openedHistory.current = id;
          sequence.current[id] = saved.sequence;
          setMessages(saved.messages); setHasMore(saved.hasMore); setCachedView(true); setHistoryJump(n => n + 1);
          if (authReady && navigator.onLine !== false) await synchronize(id);
        } else if (authReady && navigator.onLine !== false) await loadHistory(id);
      });
    }
    return () => { disposed = true; historyRequest.current?.abort(); };
  }, [conversationId, snapshot?.me.id]);
  useEffect(() => {
    if (!authReady || !conversationId || navigator.onLine === false) return;
    if (openedHistory.current === conversationId) void synchronize(conversationId);
    else void loadHistory(conversationId);
  }, [authReady]);
  useEffect(() => {
    const scope = storageScope();
    if (!scope || !conversationId || openedHistory.current !== conversationId || cachedView) return;
    void saveHistory(scope, conversationId, { messages, hasMore, sequence: sequence.current[conversationId] || 0 }).catch(() => {});
  }, [messages, hasMore, cachedView, conversationId]);
  useEffect(() => { if (serverId && snapshot && !snapshot.servers.some(s => s.id === serverId)) { setServerId(null); setConversationId(null); } if (conversationId && snapshot && !snapshot.channels.some(c => c.conversationId === conversationId) && !snapshot.dms.some(d => d.id === conversationId)) setConversationId(null); }, [snapshot, serverId, conversationId]);
  async function refreshMemberState() {
    const generation = sessionGeneration.current;
    try { await refresh(); }
    finally { if (generation === sessionGeneration.current) setMemberRevision(value => value + 1); }
  }
  useEffect(() => { setMembers([]); setMembersServer(null); }, [serverId, userId]);
  useEffect(() => {
    if (!serverId || !userId) return;
    let cancelled = false;
    void request<ServerMember[]>(`/servers/${serverId}/members`).then(rows => {
      if (!cancelled) { setMembers(rows); setMembersServer(serverId); }
    }).catch(cause => {
      if (cancelled) return;
      if (cause.status === 403 || cause.status === 404) { setMembers([]); setMembersServer(null); }
      error(cause);
    });
    return () => { cancelled = true; };
  }, [serverId, userId, snapshot?.users, snapshot?.servers, memberRevision]);

  const [watchingShares, setWatchingShares] = useState<string[]>([]);
  const ownShare = room?.shares.find(s => s.userId === userId);
  const streamViewers = useStreamAudience(socket, connected, room?.channelId, ownShare?.id, watchingShares);
  const viewerNames = room?.members.filter(member => streamViewers.includes(member.user.id)).map(member => member.user.displayName) ?? [];
  const releasePlatform = android ? 'Android' : window.desktop ? 'Windows' : 'Web';
  const updateNotice = useUpdateNotice(Boolean(authReady && !loading && snapshot && !snapshot.me.mustChangePassword), releasePlatform);
  const [showUpdateHistory, setShowUpdateHistory] = useState(false);
  const features = useFeatureState(socket, userId);
  const soundboard = useSoundboard(socket, room, userId, deafened || audioTesting || !features.soundboard || Boolean(room?.members.find(member => member.user.id === userId)?.serverDeafened));
  const [soundboardOpen, setSoundboardOpen] = useState(false);
  useEffect(() => { setSoundboardOpen(false); }, [room?.channelId, userId]);
  const moderation = useMemberModeration({ me: snapshot?.me, serverId, servers: snapshot?.servers || [], channels: snapshot?.channels || [], members, presence: snapshot?.voicePresence || [], room, transport: media.current, volumes, setVolume: (id, value) => { setVolumes(old => ({ ...old, [id]: value })); saveVoiceLevel(userId!, id, value); media.current?.setVolume(id, value / 100); }, profile: setProfile, soundboard: features.soundboard ? soundboard : undefined, error, changed: refresh });
  useVoiceTts(socket, room, deafened || audioTesting || Boolean(room?.members.find(m => m.user.id === userId)?.serverDeafened), ttsEnabled, authReady ? userId : undefined, setToast);
  async function enterInvitedServer(result: { id: string; channelId?: string | null }) {
    const data = await request<Snapshot>('/bootstrap'); setSnapshot(data);
    const channels = data.channels.filter(channel => channel.serverId === result.id);
    const target = channels.find(channel => channel.id === result.channelId) || channels.find(channel => channel.kind === 'text');
    setServerId(result.id); setConversationId(target?.conversationId || channels.find(channel => channel.kind === 'text')?.conversationId || null); setMobileNav(false);
    setInvitedVoice(target?.kind === 'voice' ? target : null);
  }
  useEffect(() => { if (!userId) return; const guestLanding = takeInviteLanding(), code = new URLSearchParams(location.search).get('invite');
    if (guestLanding) void run(() => enterInvitedServer({ id: guestLanding.serverId, channelId: guestLanding.channelId }));
    else if (code) void run(async () => { const result = await request('/invites/join', { code }); await enterInvitedServer(result); history.replaceState(null, '', location.pathname); });
  }, [userId]);
  useEffect(() => { const visible = () => { if (current.current) { void synchronize(current.current); } }; document.addEventListener('visibilitychange', visible); return () => document.removeEventListener('visibilitychange', visible); }, []);
  async function navigateChannel(target: { serverId: string; channelId: string }) {
    const channel = await request(`/channels/${encodeURIComponent(target.channelId)}`);
    if (channel.server_id !== target.serverId) throw new Error('This channel link is invalid.');
    await refresh(); setServerId(target.serverId); setConversationId(channel.conversation_id || null); setMobileNav(false);
    if (channel.kind === 'voice') setToast(`Select ${channel.name} to join voice.`);
  }
  useEffect(() => { if (!userId) return; const params = new URLSearchParams(location.search), server = params.get('server'), channel = params.get('channel'); if (server && channel) { void run(() => navigateChannel({ serverId: server, channelId: channel })); history.replaceState(null, '', location.pathname); } }, [userId]);
  useEffect(() => { if (!android || !userId) return; const open = () => { void consumeAndroidLink().then(async value => { if (!value) return; const url = new URL(value); if (url.origin !== serverUrl()) return; const conversation = url.searchParams.get('conversation'); const server = url.searchParams.get('server'), channel = url.searchParams.get('channel'), invite = url.searchParams.get('invite'); if (invite) { const result = await request('/invites/join', { code: invite }); await enterInvitedServer(result); } else if (server && channel) await navigateChannel({ serverId: server, channelId: channel }); else if (conversation) { const snapshot = snapshotRef.current; const dm = snapshot?.dms.find(item => item.id === conversation), text = snapshot?.channels.find(item => item.conversationId === conversation); if (dm || text) { setServerId(text?.serverId || null); setConversationId(conversation); setMobileNav(false); } } }).catch(error); }; open(); window.addEventListener('dorham-open-link', open); return () => window.removeEventListener('dorham-open-link', open); }, [android, userId]);
  async function startDM(user: PublicUser) { const result = await request('/dms', { userId: user.id }); await refresh(); setServerId(null); setConversationId(result.id); setProfile(null); setModal(null); setMobileNav(false); }
  async function send(e?: Pick<FormEvent, 'preventDefault'>, retry = false) {
    e?.preventDefault(); const { text: draft, reply, editing, files: pendingFiles, pending: pendingSend } = readDraft(); if (!conversationId || !snapshot || sending || snapshot.dms.some(dm => dm.id === conversationId && dm.user.deleted) || (!retry && !draft.trim() && !pendingFiles.length)) return;
    const cv = conversationId, account = snapshot.me.id, key = draftStore().key(account, serverUrl() || location.origin, cv), original = draftStore().get(key);
    const same = pendingSend && pendingSend.content === draft.trim() && Boolean(pendingSend.tts) === Boolean(activeChannel && ttsSend && !editing) && pendingSend.replyTo === (reply?.id || null) && JSON.stringify(pendingSend.attachmentIds) === JSON.stringify(pendingFiles.map(f => f.id)) && pendingSend.editMessageId === editing?.id;
    const pending = (retry || same) && pendingSend ? pendingSend : { requestId: crypto.randomUUID(), content: draft.trim(), tts: Boolean(activeChannel && ttsSend && !editing), replyTo: reply?.id || null, attachmentIds: pendingFiles.map(f => f.id), createdAt: Date.now(), status: 'sending' as const, editMessageId: editing?.id };
    if (Date.now() - pending.createdAt >= 86400000) { error(new Error('Retry expired. Check the conversation before sending again.')); return; }
    if (!pending.editMessageId && !pendingSend && !retry && storageScope()) {
      setSending(true);
      try {
        await outbox.add({ conversationId: cv, requestId: pending.requestId, content: pending.content, tts: Boolean(pending.tts), replyTo: pending.replyTo, attachmentIds: pending.attachmentIds, createdAt: pending.createdAt });
        const latest = draftStore().get(key);
        if (latest === original || latest.text === original.text && latest.reply?.id === original.reply?.id && latest.editing?.id === original.editing?.id && latest.files === original.files) {
          setDraft(''); setReply(null); setPendingFiles([]); draftStore().flush();
        }
        setHistoryJump(n => n + 1);
      } catch (cause) { error(cause); }
      finally { setSending(false); }
      return;
    }
    setSending(true); setPendingSend({ ...pending, status: 'sending', error: undefined }); draftStore().flush();
    try {
      if (pending.editMessageId) await request(`/messages/${pending.editMessageId}`, { requestId: pending.requestId, content: pending.content }, 'PATCH');
      else {
        const body = { conversationId: cv, requestId: pending.requestId, content: pending.content, tts: pending.tts, replyTo: pending.replyTo, attachmentIds: pending.attachmentIds };
        const event = socket.current?.connected ? await ack<ConversationEvent>(socket.current, 'message:send', body) : await request<ConversationEvent>('/messages', body);
        if (snapshotRef.current?.me.id !== account) return;
        applyEvent(event); if (snapshotRef.current?.dms.some(dm => dm.id === cv)) playCue('sent', snapshotRef.current?.me.status === 'busy');
      }
      if (snapshotRef.current?.me.id !== account) return;
      const now = draftStore().get(key);
      const sentOriginal = original.text.trim() === pending.content && (original.reply?.id || null) === pending.replyTo && original.editing?.id === pending.editMessageId && JSON.stringify(original.files.map(f => f.id)) === JSON.stringify(pending.attachmentIds);
      if (sentOriginal && now.text === original.text && now.reply?.id === original.reply?.id && now.editing?.id === original.editing?.id && JSON.stringify(now.files.map(f => f.id)) === JSON.stringify(original.files.map(f => f.id))) { setDraft(''); setReply(null); setEditing(null); setPendingFiles([]); }
      setPendingSend(null); draftStore().flush();
      if (current.current === cv) setHistoryJump(n => n + 1);
      if (socket.current?.connected) void ack(socket.current, 'typing', { conversationId: cv, active: false });
    } catch (e: any) { if (snapshotRef.current?.me.id !== account) return; setPendingSend({ ...pending, status: 'failed', error: translatedError(e) }); draftStore().flush(); if (current.current === cv) error(e); }
    finally { setSending(false); }
  }
  useEffect(() => {
    if (!android) return;
    const back = (event: Event) => { if (event.defaultPrevented) return; if (moderation.menuOpen || membersOpen || voicePreview || mobileNav || modal || profile || soundboardOpen) { event.preventDefault(); if (moderation.menuOpen) moderation.closeMenu(); else if (soundboardOpen) setSoundboardOpen(false); else if (membersOpen) setMembersOpen(false); else if (voicePreview) setVoicePreview(null); else if (profile) setProfile(null); else if (modal) setModal(null); else setMobileNav(false); } };
    window.addEventListener('dorham-back', back); return () => window.removeEventListener('dorham-back', back);
  }, [android, moderation.menuOpen, membersOpen, voicePreview, mobileNav, modal, profile, soundboardOpen]);
  async function joinVoice(channel: Channel) { if (direct.call) { error('End the direct call before joining voice.'); return; } if (!media.current || joining.current || media.current.room?.channelId === channel.id) return; joining.current = true; setVoiceBusy(true); try { await voiceInput.prepare(); await media.current.join(channel.id); setMobileNav(false); } finally { joining.current = false; setVoiceBusy(false); } }
  if (loading) return <div className="loading"><img src="./icon.svg" alt=""/><span>{tr("Finding your people…")}</span></div>;
  const activeServer = snapshot?.servers.find(s => s.id === serverId), activeChannel = conversationId ? snapshot?.channels.find(c => c.conversationId === conversationId) : undefined, activeDM = snapshot?.dms.find(d => d.id === conversationId), voiceChannel = snapshot?.channels.find(c => c.id === room?.channelId), self = room?.members.find(m => m.user.id === userId);
  const recentDMs = orderedDirectChats(snapshot?.dms || []);
  const unread = (cv: string | null) => Boolean(cv && snapshot?.unread[cv] && snapshot.unread[cv].sequence > snapshot.unread[cv].readSequence);
  const toastView = toast && <div role={toast === missingBrowserShareAudio ? "status" : "alert"} className="toast"><Activity size={18}/><span>{tr(toast)}</span><IconButton title={tr("Dismiss notification")} onClick={() => setToast('')}><X/></IconButton></div>;
  if (!snapshot && restoringSession) return <div className="loading"><img src="./icon.svg" alt=""/><span role="status">{tr('Reconnecting to your account…')}</span></div>;
  if (!snapshot) return <><Auth onLogin={refresh} onError={error} compact={compactWeb}/>{toastView}</>;
  if (snapshot.me.mustChangePassword) return <><TemporaryPassword refresh={refresh} error={error}/>{toastView}</>;

  const roster = membersServer === serverId ? members : [];
  const onlineCount = serverId ? roster.filter(member => online.has(member.user.id)).length : online.size;

  const focusScreens = viewerOpen;
  const canModerateSoundboard = Boolean(voiceChannel?.permissions.moderate);
  const soundboardAvailable = features.soundboard && showSoundboard(features.catalog, voiceChannel?.serverId, canModerateSoundboard, features.grants.soundboardPlus !== undefined);
  const soundboardButton = soundboardAvailable && <button type="button" className="icon-button soundboard-button" title={tr("Soundboard")} aria-label={tr("Soundboard")} aria-haspopup="dialog" onClick={() => setSoundboardOpen(true)}><AudioLines size={17}/></button>;
  const shareLabel = tr(ownShare ? "Stop sharing" : "Share screen");
  function toggleShare() {
    if (!ownShare) { setShareSetup(true); return; }
    setSharingBusy(true);
    void run(() => media.current!.stopShare()).finally(() => setSharingBusy(false));
  }
  function toggleOwnPreview() { const next = !previewOwn; setPreviewOwn(next); try { localStorage.setItem('dorham-own-screen-preview', String(next)); } catch { /* session preference */ } }
  function toggleMembers() { if ((android && compact) || matchMedia('(max-width:1200px)').matches) { setMembersOpen(value => !value); return; } const next = !membersCollapsed; setMembersCollapsed(next); try { localStorage.setItem('dorham-members-collapsed', String(next)); } catch { /* session preference */ } }
  const pingFor = (user: PublicUser) => <ConnectionPing name={user.displayName} userId={user.id} online={online.has(user.id)}/>;
  const voiceMembers = (channelId: string) => (room?.channelId === channelId ? room.members : snapshot.voicePresence?.find(v => v.channelId === channelId)?.members) || [];
  return <FeatureContext.Provider value={features}><GamesProvider gameAudioSilenced={deafened || audioTesting || Boolean(self?.serverDeafened)} me={snapshot.me} room={room} serverId={voiceChannel?.serverId || null} socket={socket.current}><div className={`app ${android ? (mobileLayout === 'landscape' ? 'android-mobile android-landscape' : 'android-mobile') : compactWeb ? (mobileLayout === 'landscape' ? 'phone-web phone-web-landscape' : 'phone-web') : ''} ${mobileNav ? 'nav-open' : ''} ${membersCollapsed ? 'members-collapsed' : ''}`}><nav inert={compact && (android || compactWeb) && !mobileNav} className="server-rail" aria-label={tr("Servers")}><button className={`home-logo ${!serverId ? 'selected' : ''}`} aria-label={tr("Home")} onClick={() => { setServerId(null); setConversationId(null); setMobileNav(false); }}><img src="./icon.svg" alt="Dorham"/>{snapshot.dms.some(dm => unread(dm.id)) && <i className="home-unread" aria-label={tr("Unread direct messages")}/>}</button><div className="rail-divider"/>{snapshot.servers.map(server => <button key={server.id} title={server.name} aria-label={tr('Open {name}', { name: server.name })} className={`server-icon ${serverId === server.id ? 'selected' : ''}`} onClick={() => { setServerId(server.id); setConversationId(snapshot.channels.find(c => c.serverId === server.id && c.kind === 'text')?.conversationId || null); }}>{server.icon ? <img crossOrigin="anonymous" src={assetUrl(server.icon)} alt=""/> : server.name.split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase()}{snapshot.channels.some(c => c.serverId === server.id && unread(c.conversationId)) && <i/>}</button>)}<button className="server-icon add" title={tr("Create a server")} aria-label={tr("Create a server")} onClick={() => setModal('server')}><Plus/></button><button className="server-icon join" title={tr("Join a server")} aria-label={tr("Join a server")} onClick={() => setModal('join')}><Globe/></button><div className="rail-bottom"><span className="version-tag">{tr("BETA")}</span><span className={`connection-light ${connected ? 'connected' : ''}`} title={connected ? tr("Connected") : tr("Reconnecting")}/></div></nav>
    <aside className="sidebar" inert={compact && (android || compactWeb) && !mobileNav}><button className="space-heading" onClick={() => activeServer && openServerSettings()}><span>{activeServer?.name || tr("Your corner")}</span>{activeServer ? <ChevronDown size={17}/> : <MessageCircle size={19}/>}</button><div className="sidebar-scroll">{activeServer?.banner && <img className="community-banner" src={assetUrl(activeServer.banner)} alt="" loading="lazy"/>}{!serverId ? <><button className={`nav-item home-nav ${!conversationId ? 'selected' : ''}`} onClick={() => { setConversationId(null); setMobileNav(false); }}><Users size={19}/><span>{tr("People")}</span><span className="count">{formatNumber(online.size)}</span></button><div className="section-label">{tr("DIRECT MESSAGES")}<IconButton title={tr("New direct message")} onClick={() => setModal('people')}><Plus/></IconButton></div>{recentDMs.map(dm => <button className={`nav-item dm-item ${conversationId === dm.id ? 'selected' : ''}`} key={dm.id} onClick={() => { setConversationId(dm.id); setMobileNav(false); }}><Avatar user={dm.user} online={online.has(dm.user.id)} small/><span>{dm.user.displayName}</span>{unread(dm.id) && <i className="unread-dot"/>}</button>)}{recentDMs.length === 0 && <p className="dm-empty-hint">{tr("Click the")} <b>+</b> {tr("next to Direct messages to talk to someone.")}</p>}<div className="sidebar-card"><Sparkles size={21}/><h4>{tr("Make room for everyone.")}</h4><p>{tr("Create a server for your friends, your team, or your next big idea.")}</p><button onClick={() => setModal('server')}>{tr("Create a space")} <ArrowRight size={14}/></button></div></> : <>{(['text', 'voice'] as const).map(kind => <div key={kind}><div className="section-label">{tr(kind === 'text' ? 'TEXT CHANNELS' : 'VOICE LOUNGES')}{activeServer?.permissions?.manageChannels && <IconButton title={tr('Add {kind} channel', { kind: tr(kind === 'text' ? 'Text' : 'Voice') })} onClick={() => openServerSettings('channels', kind)}><Plus/></IconButton>}</div>{snapshot.channels.filter(c => c.serverId === serverId && c.kind === kind).map(channel => <div key={channel.id}><button {...moderation.drop(channel)} className={`nav-item channel-item ${kind === 'text' && conversationId === channel.conversationId ? 'selected' : ''} ${room?.channelId === channel.id ? 'voice-selected' : ''}`} onClick={() => { if (kind === 'voice') { if (android) setVoicePreview(channel); else void run(() => joinVoice(channel)); } else { setConversationId(channel.conversationId); setMobileNav(false); if (viewerOpen) setChatOpen(true); } }} disabled={kind === 'voice' && voiceBusy}>{kind === 'text' ? <Hash size={19}/> : <Volume2 size={19}/>}<span>{channel.name}</span>{unread(channel.conversationId) && <i className="unread-dot"/>}{room?.channelId === channel.id && <span className="live-dot"/>}</button>{kind === 'voice' && voiceMembers(channel.id).length > 0 && <div className="voice-mini-members" aria-label={tr('Participants in {name}', { name: channel.name })}>{voiceMembers(channel.id).map(m => m.user.id === MUSIC_ID ? <MusicBotRow key={MUSIC_ID} serverDeafened={m.serverDeafened} remove={room?.channelId === channel.id ? removeMusic : undefined} removing={removingMusic} title={room?.channelId === channel.id ? musicBot?.trackTitle : undefined} active={room?.channelId === channel.id && musicBot?.playbackStatus === "playing"} muted={!musicListening.level} toggle={room?.channelId === channel.id ? musicListening.toggle : undefined} open={() => { if (room?.channelId === channel.id) openMusic(); else if (android) setVoicePreview(channel); else void run(() => joinVoice(channel)); }}/> : <SpeakingButton {...moderation.bind(m.user, channel.id)} key={m.user.id} userId={m.user.id} onClick={() => setProfile(m.user)}><Avatar user={m.user} small/><span>{m.user.displayName}</span><VoiceMemberStatusIcon status={voiceMemberStatus(m)} size={13}/></SpeakingButton>)}</div>}{kind === 'voice' && <VoiceGames channelId={channel.id}/>}</div>)}</div>)}{activeServer?.permissions?.createInvites && <button className="secondary invite-people" onClick={() => openServerSettings('invites')}>{tr("Invite people")}</button>}<div className="server-note"><ShieldCheck size={16}/><span>{tr("A space for good company.")}</span></div></>}</div>
      {room && <div className="voice-panel"><div><span className="voice-signal"><Radio size={15}/>{tr(listenOnly ? 'Listening only' : voiceStatus || 'Connecting media…')}</span><IconButton title={tr("Disconnect voice")} danger onClick={() => { void run(() => media.current!.leave()); }}><PhoneOff/></IconButton></div><span className="voice-location">{voiceChannel?.name} / {snapshot.servers.find(s => s.id === voiceChannel?.serverId)?.name}</span>{serverId !== voiceChannel?.serverId && <VoiceGames channelId={room.channelId}/>}  <div className="voice-panel-actions">
        <button type="button" className={"icon-button share-screen-button " + (ownShare ? "active" : "")} aria-label={shareLabel} title={ownShare ? shareLabel + " · " + screenSummary(screenPreferences, snapshot.screenPolicy, ownShare) : shareLabel} disabled={sharingBusy || !connected} onClick={toggleShare}><MonitorUp size={17}/></button>
        {ownShare && <IconButton title={tr("Adjust sharing settings")} disabled={sharingBusy || !connected} onClick={() => setShareSetup(true)}><Settings/></IconButton>}
        <GamesButton/>{soundboardButton}
        {room.musicAvailable && <MusicVoiceButton open={openMusic}/>}
        <IconButton title={tr("Connection diagnostics")} onClick={() => setModal("diagnostics")}><Activity/></IconButton>
      </div></div>}
      <div className="account-bar"><button {...moderation.bind(snapshot.me)} className="account-info" onClick={() => setModal('settings')}><Avatar user={snapshot.me} online small/><span><strong>{snapshot.me.displayName}</strong><small>{tr(snapshot.me.status)}</small></span></button><IconButton title={listenOnly ? tr('Microphone unavailable. Rejoin to try again.') : voiceInput.preferences.mode === 'push' ? tr(voiceInput.locked ? "Enable push to talk" : muted ? "Push to talk ready" : "Mute microphone") : muted ? tr("Unmute microphone") : tr("Mute microphone")} active={muted} disabled={!room || audioTesting || listenOnly} onClick={voiceInput.toggle}>{muted ? <MicOff/> : <Mic/>}</IconButton><IconButton title={deafened || audioTesting ? tr("Undeafen") : tr("Deafen")} active={deafened || audioTesting} disabled={!room || audioTesting} onClick={() => { const next = !deafened; setDeafened(next); void run(() => media.current!.setDeafened(next)); }}>{deafened || audioTesting ? <HeadphoneOff/> : <Headphones/>}</IconButton><IconButton title={tr("Account settings")} onClick={() => setModal('settings')}><Settings/></IconButton></div>
    </aside>
    <main className={`main ${focusScreens ? 'stream-viewer-active' : ''} ${chatOpen ? 'chat-drawer-open' : ''}`}><header className="topbar"><button type="button" className="icon-button" title={tr("Toggle navigation")} aria-label={tr("Toggle navigation")} aria-expanded={mobileNav} onClick={() => setMobileNav(value => !value)}><Menu/></button><span className="topbar-symbol">{conversationId ? activeDM ? <MessageCircle/> : <Hash/> : <Users/>}</span><strong>{activeChannel?.name || activeDM?.user.displayName || tr("People")}</strong><span className="topbar-divider"/><span className="topbar-description">{activeDM ? tr("A conversation just for you two") : conversationId ? tr("A little conversation goes a long way.") : tr("Your people, all in one place.")}</span><div className="topbar-actions">{conversationId && <AndroidChatNotifications accountId={snapshot.me.id} conversationId={conversationId}/>}<ReleaseActions inCall={inCall}/>{activeDM && <>{snapshot.directCalls && !snapshot.me.guest && !activeDM.user.guest && !activeDM.user.deleted && !activeDM.blocked && <IconButton title={tr('Start voice call')} disabled={!connected || !online.has(activeDM.user.id) || inCall || voiceBusy || Boolean(direct.call)} onClick={() => { if (socket.current) void run(() => direct.start(socket.current!, activeDM.id)); }}><Phone/></IconButton>}<IconButton title={tr('Close chat')} onClick={() => { void run(async () => { await request(`/dms/${activeDM.id}/close`, {}); setMessageNotice(old => old?.conversationId === activeDM.id ? null : old); await refresh(); }); }}><X/></IconButton>{!activeDM.user.deleted && <button className="chat-block-button" onClick={() => { void run(async () => { await request(`/users/${activeDM.user.id}/block`, { blocked: !activeDM.blockedByMe }); await refresh(); }); }}>{tr(activeDM.blockedByMe ? 'Unblock person' : 'Block person')}</button>}</>}<span className={`connection-pill ${connected ? '' : 'disconnected'}`}><i/>{connected ? tr("All connected") : tr("Reconnecting")}{connected && pingFor(snapshot.me)}</span><IconButton title={tr(membersCollapsed ? 'Show members panel' : 'Minimize members panel')} onClick={toggleMembers}>{membersCollapsed ? <PanelRightOpen/> : <PanelRightClose/>}</IconButton></div></header>
      <FeatureAnnouncements/>
      <DirectCallBanner direct={direct} socket={socket.current} muted={voiceInput.muted} toggle={voiceInput.toggle} run={run}/>
      {activeDM?.blocked && <p className="blocked-chat-note" role="status">{tr('Direct messaging is blocked between these accounts. Existing history is kept.')}</p>}
      {invitedVoice && serverId === invitedVoice.serverId && room?.channelId !== invitedVoice.id && snapshot.channels.some(channel => channel.id === invitedVoice.id) && <div className="invite-voice-landing" role="status"><span>{tr('Invited to {name}', { name: invitedVoice.name })}</span><button className="primary" disabled={voiceBusy || !connected} onClick={() => { void run(async () => { await joinVoice(invitedVoice); setInvitedVoice(null); }); }}>{tr('Join voice')}</button><IconButton title={tr('Dismiss notification')} onClick={() => setInvitedVoice(null)}><X/></IconButton></div>}
      {messageNotice && <div className="message-notice" role="status"><button onClick={() => { setServerId(messageNotice.serverId || null); setConversationId(messageNotice.conversationId); setMessageNotice(null); setMobileNav(false); }}>{messageNotice.channel ? tr('{name} mentioned you in #{channel}', { name: messageNotice.author, channel: messageNotice.channel }) : tr('New message from {name}', { name: messageNotice.author })}</button><IconButton title={tr('Dismiss notification')} onClick={() => setMessageNotice(null)}><X/></IconButton></div>}
      {room && <GamingVoice room={room} userId={userId!} name={voiceChannel?.name || tr('Voice channel')} transport={media.current} navigation={serverId} screens={screens} localScreen={localScreen} previewOwn={previewOwn} toggleOwn={toggleOwnPreview} error={error} viewer={setViewerOpen} watching={setWatchingShares} audienceNames={viewerNames} chatOpen={chatOpen} toggleChat={() => setChatOpen(!chatOpen)} participants={() => setMembersOpen(true)} music={room.musicAvailable ? <MusicVoiceButton open={openMusic}/> : undefined} musicRow={musicBot ? <MusicBotRow {...musicBotActions} title={musicBot.trackTitle} active={musicBot.playbackStatus === "playing"} muted={!musicListening.level} toggle={musicListening.toggle} open={openMusic}/> : undefined} memberActions={(user, event) => moderation.bind(user, room.channelId).onContextMenu(event)}/>}
      {conversationId ? <><div className="message-scroll" ref={scroll}>{(!authReady || cachedView) && <p className="preview-status" role="status">{tr("Showing messages saved on this device")}</p>}{hasMore && <button className="load-more" disabled={historyBusy} onClick={() => { void loadHistory(conversationId, true); }}>{tr("Load earlier messages")}</button>}<div className="conversation-start"><span>{activeDM ? <MessageCircle size={32}/> : <Hash size={32}/>}</span><h1>{activeDM ? tr('Say hello to {name}', { name: activeDM.user.displayName }) : tr('Welcome to #{name}', { name: activeChannel?.name || '' })}</h1><p>{activeDM ? tr("This is the beginning of your direct conversation.") : tr("This is where your conversation begins. Make yourself at home.")}</p><div><i/><span>{tr("THE START OF SOMETHING GOOD")}</span><i/></div></div>{<MessageHistory key={conversationId} messages={messages} scroll={scroll} jump={historyJump} visible={visibleRead} renderMessage={(storedMessage, index) => { const message = { ...storedMessage, author: authors.get(storedMessage.author.id) || storedMessage.author }; const grouped = index > 0 && messages[index - 1].author.id === message.author.id && message.createdAt - messages[index - 1].createdAt < 300000 && !message.replyTo; return <>{!message.deleted && message.sequence > unreadStart.current.sequence && (index === 0 || messages[index - 1].sequence <= unreadStart.current.sequence) && <div className="unread-divider">{tr('New messages')}</div>}<article className={`message ${grouped ? 'grouped' : ''} ${message.deleted ? 'deleted' : ''} ${message.mentions?.some(m => m.userId === userId) ? 'mentioned' : ''}`} data-testid="message" key={message.id}>{!grouped ? <button {...(!message.author.deleted ? moderation.bind(message.author) : {})} className="message-avatar" disabled={message.author.deleted} onClick={() => setProfile(message.author)}><Avatar user={message.author}/></button> : <span className="mini-time">{formatMessageTime(message.createdAt, true)}</span>}<div className="message-body">{message.replyTo && <div className="reply-preview"><Reply size={13}/><span>{messages.find(m => m.id === message.replyTo)?.content.slice(0, 90) || tr("Earlier message")}</span></div>}{!grouped && <div className="message-byline"><button {...(!message.author.deleted ? moderation.bind(message.author) : {})} disabled={message.author.deleted} onClick={() => setProfile(message.author)}><bdi>{message.author.displayName}</bdi></button>{pingFor(message.author)}<time dateTime={new Date(message.createdAt).toISOString()}>{formatMessageTime(message.createdAt)}</time></div>}<p dir="auto" className={message.content.length > 1000 ? 'long-message' : undefined}>{message.deleted ? tr("Message deleted") : <MessageContent messageId={message.id} content={message.content} mentions={message.mentions} me={userId || undefined} origin={serverUrl() || location.origin} navigate={target => { void run(() => navigateChannel(target)); }}/>}{message.editedAt && !message.deleted && <small> {tr("(edited)")}</small>}</p>{!message.deleted && <MessageAttachments files={message.attachments} conversation={message.conversationId} error={error}/>} {message.reactions.length > 0 && <div className="reactions">{message.reactions.map(r => <button key={r.emoji} aria-pressed={r.userIds.includes(userId!)} disabled={activeDM?.user.deleted} className={r.userIds.includes(userId!) ? 'selected' : ''} onClick={() => { void run(() => request(`/messages/${message.id}`, { emoji: r.emoji, removeReaction: r.userIds.includes(userId!) }, 'PATCH')); }}><EmojiGlyph value={r.emoji}/><span>{r.userIds.length}</span></button>)}</div>}{!message.deleted && message.content && <CopyMessageButton text={message.content} touch error={error}/>}</div>{!message.deleted && !activeDM?.user.deleted && <div className="message-actions">{message.content && <CopyMessageButton text={message.content} error={error}/>}<EmojiPicker reaction serverId={conversationServer} disabled={false} selected={message.reactions.filter(r => r.userIds.includes(userId!)).map(r => reactionEmojiId(r.emoji) || (r.emoji.startsWith(':dx-') ? r.emoji.slice(1, -1) : ''))} pick={async emoji => { try { const value = emoji.id.startsWith('dx-') ? `:${emoji.id}:` : reactionValue(emoji.id); const changed = await request(`/messages/${message.id}`, { emoji: value, removeReaction: message.reactions.some(r => r.emoji === value && r.userIds.includes(userId!)) }, 'PATCH'); applyEvent(changed); return true; } catch (e) { error(e); return false; } }}/><IconButton title={tr("Reply to message")} onClick={() => { setReply(message); setEditing(null); }}><Reply/></IconButton>{message.author.id === userId && <IconButton title={tr("Edit message")} onClick={() => { setEditing(message); setDraft(message.content); setReply(null); }}><Pencil/></IconButton>}{(message.author.id === userId || activeChannel?.permissions.moderate) && <IconButton title={tr("Delete message")} danger onClick={() => { void run(() => request(`/messages/${message.id}`, { delete: true }, 'PATCH')); }}><Trash2/></IconButton>}</div>}</article></>; }}/>}{unread(conversationId) && <button className="jump-latest" onClick={() => { void loadHistory(conversationId); }}>{tr('New messages · Jump to latest')}</button>}<div ref={bottom}/></div><QueuedMessages rows={outbox.rows.filter(row => row.conversationId === conversationId)} sending={outbox.sending} cancel={id => { void outbox.remove(id).catch(error); }} retry={id => { void outbox.retry(id).catch(error); }}/><MessageComposer key={conversationId} me={snapshot.me} conversationId={conversationId} activeChannel={activeChannel} activeDM={activeDM} members={members} membersServer={membersServer} serverId={serverId} blockedUsers={snapshot.blockedUsers} channels={snapshot.channels} users={snapshot.users} room={room} typing={typing} sending={sending} ttsSend={ttsSend} setTtsSend={setTtsSend} ttsEnabled={ttsEnabled} setTtsEnabled={setTtsEnabled} error={error} send={retry => send(undefined, retry)} typingChanged={() => { if (socket.current?.connected && Date.now() - lastTyping.current > 2000) { lastTyping.current = Date.now(); void ack(socket.current, 'typing', { conversationId, active: true }).catch(() => {}); } }}/></> : <DirectMessagesHome me={snapshot.me} chats={recentDMs} open={id => { setServerId(null); setConversationId(id); setMobileNav(false); }} discover={() => setModal('people')}/>}

    </main>
    <aside className="members-sidebar"><button className="members-restore" aria-label={tr("Show members panel")} onClick={toggleMembers}><Users size={18}/></button><div className="members-heading"><Users size={16}/>{tr(serverId ? 'IN THIS SPACE' : 'YOUR LITTLE CORNER')}</div>{serverId ? <>{(['online', 'offline'] as const).map(status => { const list = roster.filter(member => online.has(member.user.id) === (status === 'online')); return <section key={status}>
      <h4>{tr(status)} — {formatNumber(list.length)}</h4>
      {list.map(member => {
        const openProfile = () => setProfile(member.user);
        return <MemberListRow key={member.user.id} member={member} online={online.has(member.user.id)}
          openProfile={openProfile} menuBindings={moderation.bindRoster(member.user, openProfile)} latency={pingFor(member.user)}/>;
      })}
    </section>; })}</> : <><div className="corner-illustration"><div><Headphones size={35}/></div><span className="tiny-spark">✦</span></div><h3>{tr("Always room")}<br/>{tr("for one more.")}</h3><p>{tr("Catch up in text, drop into voice, or show everyone what you’re working on.")}</p><div className="feature-line"><MessageCircle/><span><strong>{tr("Keep the conversation going")}</strong><small>{tr("Messages that stay with you.")}</small></span></div><div className="feature-line"><Volume2/><span><strong>{tr("Just drop in")}</strong><small>{tr("A familiar voice feels closer.")}</small></span></div><div className="feature-line"><MonitorUp/><span><strong>{tr("Show, don’t just tell")}</strong><small>{tr("Share a little of your screen.")}</small></span></div><button className="secondary" onClick={() => setModal('join')}>{tr("Got an invite?")} <ArrowRight size={15}/></button></>}<div className="members-footer"><span className="live-dot"/> {tr(onlineCount === 1 ? '{count} person online' : '{count} people online', { count: formatNumber(onlineCount) })}</div></aside>
    {android && <AndroidDownloadStatus/>}
    {android && room && <MobileCallBar music={room.musicAvailable ? <MusicVoiceButton open={openMusic}/> : undefined} musicMute={musicBot ? { muted: !musicListening.level, toggle: musicListening.toggle } : undefined} name={voiceChannel?.name || tr('Voice channel')} count={room.members.filter(m => m.user.id !== MUSIC_ID).length} muted={muted} deafened={deafened || audioTesting} listenOnly={listenOnly || audioTesting} sharing={Boolean(ownShare)} busy={sharingBusy || !connected} status={voiceStatus} participants={() => setMembersOpen(true)} mute={voiceInput.toggle} deafen={() => { const next = !deafened; setDeafened(next); void run(() => media.current!.setDeafened(next)); }} share={toggleShare} soundboard={soundboardButton} leave={() => { void run(() => media.current!.leave()); }}/>}
    {android && <MobileNavigation home={() => { setServerId(null); setConversationId(null); setMobileNav(false); }} channels={() => setMobileNav(value => !value)} members={() => setMembersOpen(true)}/>}
    {membersOpen && <MobileSheet title={tr('Members')} close={() => { moderation.closeMenu(); setMembersOpen(false); }}>{room && <><h3>{tr('In voice')} · <bdi>{voiceChannel?.name}</bdi></h3><ParticipantList musicRow={musicBot ? <MusicBotRow {...musicBotActions} title={musicBot.trackTitle} active={musicBot.playbackStatus === "playing"} muted={!musicListening.level} toggle={musicListening.toggle} open={() => { setMembersOpen(false); openMusic(); }}/> : undefined} members={room.members} actions={(user, event) => { setMembersOpen(false); moderation.bind(user, room.channelId).onContextMenu(event); }}/></>}{serverId && <><h3>{tr('Server members')}</h3>{roster.map(member => {
      const openProfile = () => { setMembersOpen(false); setProfile(member.user); };
      return <MemberListRow key={member.user.id} member={member} online={online.has(member.user.id)} compact
        openProfile={openProfile} menuBindings={moderation.bindRoster(member.user, openProfile)}/>;
    })}</>}{!room && !serverId && <p>{tr('Open a server to see its members.')}</p>}</MobileSheet>}
    {voicePreview && <MobileSheet title={voicePreview.name} close={() => setVoicePreview(null)}><ParticipantList members={voiceMembers(voicePreview.id)} actions={(user) => { setVoicePreview(null); setProfile(user); }}/><button className="primary" disabled={voiceBusy || !connected} onClick={() => { const channel = voicePreview; setVoicePreview(null); if (room?.channelId === channel.id) { setMobileNav(false); setMembersOpen(true); } else void run(() => joinVoice(channel)); }}>{tr(room?.channelId === voicePreview.id ? 'Show participants' : 'Join voice')}</button></MobileSheet>}
    {mobileNav && <button aria-label={tr("Close navigation")} className="mobile-scrim" onClick={() => setMobileNav(false)}/>}
    {modal === 'settings' && <AccountSettings notice={toastView} close={() => setModal(null)} transport={media.current} me={snapshot.me} blockedUsers={snapshot.blockedUsers || []} refresh={refresh} error={error} logout={async () => { const origin = serverUrl() || location.origin; sessionGeneration.current++; setAuthReady(false); draftStore().clear(snapshot.me.id, origin); await signOutStorage(origin, snapshot.me.id).catch(() => {}); void media.current?.leave(); try { await signOut(); } finally { setSnapshot(null); setMessages([]); setModal(null); setConversationId(null); setServerId(null); } }}/>}
    {modal === 'manage' && activeServer && <ServerSettings notice={toastView} key={activeServer.id} initial={serverSettings?.section} initialKind={serverSettings?.kind} close={() => setModal(null)} leave={async () => { await request(`/servers/${activeServer.id}/leave`, {}); setServerId(null); setConversationId(null); setModal(null); await refresh(); }} account={snapshot.me.id} instanceAdmin={snapshot.me.instanceAdmin} server={activeServer} channels={snapshot.channels.filter(c => c.serverId === serverId)} members={roster} refresh={refreshMemberState} error={error}/>}
    {modal && modal !== 'settings' && modal !== 'manage' && <Modal title={{ server: tr("A place to call yours."), join: tr("Your invite to good company."), people: tr("Start a conversation."), diagnostics: tr("Voice & connection") }[modal]} close={() => setModal(null)}>{modal === 'server' && <SimpleForm label={tr("Server name")} placeholder={tr("The usual crowd")} button={tr("Create space")} submit={async value => { const result = await request('/servers', { name: value }); await refresh(); setServerId(result.id); setConversationId(null); setModal(null); }} error={error}/>} {modal === 'join' && <SimpleForm label={tr("Invite link or code")} placeholder={tr("Paste your invite here")} button={tr("Join the conversation")} submit={async value => { let code = value.trim(); try { code = new URL(code).searchParams.get('invite') || code; } catch { /* raw code */ } const result = await request('/invites/join', { code }); await enterInvitedServer(result); setModal(null); }} error={error}/>} {modal === 'people' && <div className="modal-people"><label className="search-box"><Search size={17}/><input placeholder={tr("Search by name")} aria-label={tr("Search people")} value={search} onChange={e => setSearch(e.target.value)}/></label>{snapshot.users.filter(u => u.id !== userId && normalizePeopleSearch(`${u.displayName} ${u.username}`).includes(normalizePeopleSearch(search))).map(user => <button className="member-row" key={user.id} onClick={() => { void run(() => startDM(user)); }}><Avatar user={user} online={online.has(user.id)}/><span><strong>{user.displayName}</strong><small>@{user.username}</small></span>{snapshot.dms.some(dm => dm.user.id === user.id && (dm.lastMessageAt || 0) > 0) && <span className="existing-conversation">{tr("Already chatted")}</span>}<MessageCircle size={18}/></button>)}{snapshot.users.length === 1 && <p>{tr("No one else has registered yet. Share your instance address with a friend.")}</p>}</div>} {modal === 'diagnostics' && <div className="diagnostics"><p>{tr(voiceStatus || 'Join a voice channel to see media diagnostics.')}</p>{self?.serverMuted && <p className="warning">{tr("A moderator has muted your microphone.")}</p>}{room && <VoiceModeration room={room} channels={snapshot.channels} account={snapshot.me.id} open={(user, event) => moderation.bind(user, room.channelId).onContextMenu(event)}/>}<AudioSettings account={snapshot.me.id} transport={media.current} error={error}/><details className="connection-details"><summary>{tr("Connection details")}</summary><p>{tr("Open Share screen to choose a preset or advanced settings.")}</p>{room && Capacitor.getPlatform() === 'android' && <label>{tr("Audio output")}<select onChange={e => { void run(() => media.current!.setDevice(e.target.value)); }} defaultValue="speaker"><option value="speaker">{tr("Speaker")}</option><option value="earpiece">{tr("Earpiece")}</option><option value="bluetooth">{tr("Bluetooth")}</option></select></label>}<p>{ownShare && tr(ownShare.tier === 'fallback' ? '15fps · waiting for a 30fps slot' : '30fps available')}</p><p>{tr("Room coordinator:")} {room?.members.find(m => m.user.id === room.coordinatorId)?.user.displayName || 'none'} {tr("· epoch")} {room?.coordinatorEpoch || 0}</p><button className="secondary" onClick={() => { void run(async () => { const value = await media.current?.getStats() || {}; setStats(value); const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'dorham-media-diagnostics.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }); }}><Download size={16}/> {tr("Save connection diagnostics")}</button><pre>{JSON.stringify(stats, null, 2)}</pre></details></div>}</Modal>}
    {soundboardOpen && soundboardAvailable && room && <Modal title={tr("Soundboard")} close={() => setSoundboardOpen(false)}>
      <Soundboard key={room.channelId} socket={socket} channelId={room.channelId} serverId={voiceChannel?.serverId} moderate={canModerateSoundboard} canSpeak={Boolean(connected && self && !self.serverMuted && !deafened)} volume={soundboard.volume} change={soundboard.change} error={error}/>
    </Modal>}
    {shareSetup && room && <Modal title={tr('Screen sharing')} wide close={() => { if (!sharingBusy) setShareSetup(false); }}><ScreenShareSetup value={screenPreferences} policy={snapshot.screenPolicy} share={ownShare} soundSupported={Boolean(media.current?.getCapabilities().sharedAudio)} busy={sharingBusy || !connected} submit={async (next, sound) => {
      if (sharingBusy || !connected) return; setSharingBusy(true);
      try { if (ownShare) await media.current!.setShareQuality(next.quality, next.bandwidth); else await media.current!.startShare(next.quality, { includeAudio: sound, bandwidth: next.bandwidth }); setScreenPreferences(next); saveScreenPreferences(next); setShareSetup(false); } catch (e) { error(e); } finally { setSharingBusy(false); }
    }}/></Modal>}
    {room?.musicAvailable && musicChannel === room.channelId && userId && <Suspense fallback={<div role="status" className="toast">{tr("Loading music…")}</div>}><MusicPanel key={musicChannel} account={userId} channel={musicChannel} name={voiceChannel?.name || tr('Voice channel')} socket={socket.current} listening={musicListening} close={() => setMusicChannel(undefined)}/></Suspense>}
    {profile && !profile.deleted && <Modal title={profile.displayName} close={() => setProfile(null)}><div className="profile-detail" style={profile.profileAccent ? { borderColor: profile.profileAccent } : undefined}>{profile.profileBanner && <img className="profile-banner-image" src={assetUrl(profile.profileBanner)} alt=""/>}<Avatar user={profile} online={online.has(profile.id)}/><span dir="ltr">@{profile.username}</span><RankBadge user={profile} label/>{pingFor(profile)}<p dir="auto">{profile.bio || tr("A little mystery is a good thing.")}</p><Tags tags={profile.tags}/>{features.soundboard && profile.id !== userId && <button className="secondary" aria-pressed={soundboard.mutedSenders.has(profile.id)} onClick={() => soundboard.toggleSender(profile.id)}>{tr(soundboard.mutedSenders.has(profile.id) ? "Unmute their soundboard" : "Mute their soundboard")}</button>}{profile.id !== userId && <button className="chat-block-button" onClick={() => { void run(async () => { await request(`/users/${profile.id}/block`, { blocked: !snapshot.blockedUsers?.some(u => u.id === profile.id) }); await refresh(); }); }}>{tr(snapshot.blockedUsers?.some(u => u.id === profile.id) ? 'Unblock person' : 'Block person')}</button>}{profile.id !== userId && <button className="primary" onClick={() => { void run(() => startDM(profile)); }}><MessageCircle size={17}/> {tr("Send a message")}</button>}</div></Modal>}{updateNotice.open && <Modal title={tr('What’s new') + ' · ' + updateNotice.version} close={updateNotice.close}>{showUpdateHistory ? <WhatsNew initial={releasePlatform}/> : <><ul>{updateNotice.notes.map(note => <li key={note}>{tr(note)}</li>)}</ul><div className="update-notice-actions"><button className="secondary" onClick={() => setShowUpdateHistory(true)}>{tr('View update history')}</button><button className="primary" onClick={updateNotice.close}>{tr('Continue')}</button></div></>}</Modal>}{moderation.menu}{window.desktop && <WindowsOverlayBridge streamViewers={ownShare ? streamViewers : undefined} musicMuted={!musicListening.level} room={userId ? room : null} name={voiceChannel?.name || tr('Voice channel')} language={language}/>}{toastView}
    {!snapshot.me.guest && <RecoverySetup key={snapshot.me.id} account={snapshot.me.id} username={snapshot.me.username} error={error}/>}
  </div></GamesProvider></FeatureContext.Provider>;
}

function SimpleForm({ label, placeholder, button, submit, error }: { label: string; placeholder: string; button: string; submit: (value: string) => Promise<unknown>; error: (e: unknown) => void }) { const [value, setValue] = useState(''), [busy, setBusy] = useState(false); return <form className="simple-form" onSubmit={e => { e.preventDefault(); setBusy(true); void submit(value).catch(error).finally(() => setBusy(false)); }}><label>{label}<input required value={value} placeholder={placeholder} onChange={e => setValue(e.target.value)} maxLength={500}/></label><button className="primary" disabled={busy}>{busy ? tr("Working…") : button}<ArrowRight size={17}/></button></form>; }
