import type { Signal, VoiceRoom, Share } from '@dorham/contracts';
import { ack } from './signaling';
import type { MediaTransport, MediaOptions } from './index';
import { defaultAudioProcessing, browserAudioProcessing, processingMismatch, type AudioProcessing } from './audio-processing';
import { MicrophoneGain, clampMicrophoneGain } from './microphone-gain';
import { AudioActivityMeter } from './audio-activity';
import { clampScreenBandwidth, screenSettings, type ScreenQuality } from './screen-quality';
type Peer = { pc: RTCPeerConnection; epoch: string; makingOffer: boolean; ignoreOffer: boolean; settingAnswer: boolean; pendingIce: RTCIceCandidateInit[]; streams: NonNullable<Signal['streams']>; received: Map<string, MediaStream>; audio?: { source: MediaStreamAudioSourceNode; element: HTMLAudioElement; gain: GainNode; analyser: AnalyserNode; meterSource: MediaStreamAudioSourceNode; meter: AudioActivityMeter }; screenSender?: RTCRtpSender; screenSubscribed: boolean; restarts: number; connectionTimer?: ReturnType<typeof setTimeout>; timedOut: boolean; iceErrors: number[] };
export class MeshTransport implements MediaTransport {
  private screenBandwidth?:number;
  room: VoiceRoom | null = null;
  getCapabilities() { return { audio: typeof navigator.mediaDevices?.getUserMedia === 'function', screenCapture: typeof navigator.mediaDevices?.getDisplayMedia === 'function', nativeVideo: false, amplification: true, microphoneGain: true, sharedAudio: false, outputSelection: typeof (AudioContext.prototype as any).setSinkId === 'function' }; }
  async reconnect() { if (this.channelId && !this.joining) await this.rejoin(); }
  protected peers = new Map<string, Peer>(); protected mic: MediaStream | null = null; protected screen: MediaStream | null = null;
  protected context: AudioContext | null = null; protected lease: Share | null = null; protected channelId: string | null = null;
  protected epoch = ''; protected iceServers: RTCIceServer[] = []; protected muted = false; protected deafened = false;
  private audioProcessing: AudioProcessing = { ...defaultAudioProcessing };
  private captureProcessing: AudioProcessing = { ...defaultAudioProcessing };
  private inputGain = new MicrophoneGain(); private gainValue = 1; private outgoing: MediaStream | null = null;
  private microphoneChange: Promise<void> = Promise.resolve();
  private heartbeat?: ReturnType<typeof setInterval>; private meter?: ReturnType<typeof setInterval>; private volumes = new Map<string, number>();
  private joining = false; private destroyed = false; private signalQueue: Promise<unknown> = Promise.resolve();
  private earlySignals: Signal[] = []; private generation = 0;
  private hiddenShares = new Set<string>();
  private watchedShares = new Set<string>();
  private screenTarget = { bitrate: 1200000, fps: 15 };
  private micAnalyser: AnalyserNode | null = null; private micSource: MediaStreamAudioSourceNode | null = null;
  private micMeter: AudioActivityMeter | null = null;
  private onRoom = (room: VoiceRoom) => { void this.updateRoom(room).catch(e => this.error(e)); };
  private onSignal = (signal: Signal) => {
    // Room broadcasts precede the join acknowledgement. Preserve offers and
    // trickled ICE until the acknowledgement establishes our local epoch.
    if (signal.channelId === this.channelId && !this.epoch) { if (this.earlySignals.length < 128) this.earlySignals.push(signal); return; }
    this.signalQueue = this.signalQueue.then(() => this.receive(signal)).catch(e => this.error(e));
  };
  private onMoved = (move: { channelId: string }) => { void this.leave().then(() => this.join(move.channelId)).catch(e => this.options.emit('error', e.message)); };
  private onRemoved = () => { void this.leave(); this.options.emit('error', 'You were disconnected from the voice channel.'); };
  private onConnect = () => { if (this.channelId && !this.joining) void this.rejoin().catch(e => this.error(e)); };
  private onDisconnect = () => { this.options.emit('status', 'Reconnecting voice…'); };
  constructor(protected options: MediaOptions) {
    this.audioProcessing = { ...defaultAudioProcessing, ...options.audioProcessing };
    this.gainValue = clampMicrophoneGain(options.microphoneGain ?? 1); this.inputGain.setGain(this.gainValue);
    const s = options.socket; s.on('voice:move', this.onMoved); s.on('voice:room', this.onRoom); s.on('voice:signal', this.onSignal); s.on('voice:removed', this.onRemoved); s.on('connect', this.onConnect); s.on('disconnect', this.onDisconnect);
  }
  protected error(e: any) { if (!this.destroyed) this.options.emit('error', e.message || String(e)); }
  async join(channelId: string) {
    if (this.channelId) await this.leave();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires HTTPS or localhost.');
    const generation = ++this.generation; let acquired: MediaStream | undefined, context: AudioContext | undefined;
    const current = () => { if (this.destroyed || this.generation !== generation) throw new Error('Voice connection was cancelled.'); };
    this.joining = true;
    try {
      const processing = { ...this.audioProcessing };
      acquired = await navigator.mediaDevices.getUserMedia({ audio: { ...processing }, video: false }); current(); this.mic = acquired;
      for (const track of this.mic.getAudioTracks()) track.enabled = !this.muted && !this.deafened;
      this.captureProcessing = processing;
      context = new AudioContext(); this.context = context; await context.resume(); current(); await this.prepareMicrophone(this.mic); current(); this.channelId = channelId;
      await this.rejoin(); current();
      this.heartbeat = setInterval(() => { if (this.options.socket.connected && this.room) void ack(this.options.socket, 'voice:heartbeat', { eligible: this.peers.size === 0 || [...this.peers.values()].some(p => p.pc.connectionState === 'connected') }).catch(e => this.error(e)); }, 5000);
      this.attachMicMeter();
      this.meter = setInterval(() => {
        this.options.emit('speaking', { userId: this.options.userId, speaking: this.micMeter?.speaking(!this.muted && !this.deafened && !this.room?.members.find(m => m.user.id === this.options.userId)?.serverMuted && !this.room?.members.find(m => m.user.id === this.options.userId)?.serverDeafened) ?? false });
        for (const [userId, p] of this.peers) if (p.audio) {
          const member = this.room?.members.find(m => m.user.id === userId);
          this.options.emit('speaking', { userId, speaking: p.audio.meter.speaking(Boolean(member && !member.muted && !member.serverMuted && !member.serverDeafened && !member.deafened)) });
        }
      }, 150);
    } catch (e) { if (generation === this.generation) await this.leave(); else { acquired?.getTracks().forEach(t => t.stop()); await context?.close().catch(() => {}); } throw e; } finally { if (generation === this.generation) this.joining = false; }
  }
  private async rejoin() {
    if (!this.channelId || !this.mic) return;
    const generation = this.generation; this.epoch = ''; this.earlySignals = [];
    for (const userId of [...this.peers.keys()]) this.removePeer(userId);
    if (this.screen) await this.stopShare();
    const result = await ack(this.options.socket, 'voice:join', { channelId: this.channelId, eligible: Boolean(this.context && this.mic.active && navigator.onLine) });
    if (this.destroyed || generation !== this.generation) throw new Error('Voice connection was cancelled.');
    this.epoch = result.epoch; this.iceServers = result.iceServers; await this.updateRoom(result.room);
    for (const signal of this.earlySignals.splice(0)) this.onSignal(signal);
    await this.publishState(); this.connectionStatus();
  }
  private connectionStatus() {
    const states = [...this.peers.values()].map(p => p.pc.connectionState);
    this.options.emit('status', !states.length ? 'Waiting for another participant' : states.every(s => s === 'connected') ? 'Voice connected' : states.some(s => s === 'failed') ? 'Media connection failed' : [...this.peers.values()].some(p => p.timedOut) ? 'Media connection is taking too long' : 'Connecting media…');
  }
  private metadata(): NonNullable<Signal['streams']> {
    const streams: NonNullable<Signal['streams']> = [];
    if (this.outgoing) streams.push({ streamId: this.outgoing.id, kind: 'audio' });
    if (this.screen && this.lease) streams.push({ streamId: this.screen.id, kind: 'screen', leaseId: this.lease.id }); return streams;
  }
  private async signal(userId: string, payload: Partial<Signal>) {
    if (!this.channelId || !this.epoch) return;
    await ack(this.options.socket, 'voice:signal', { channelId: this.channelId, epoch: this.epoch, to: userId, streams: this.metadata(), ...payload });
  }
  private createPeer(userId: string, epoch: string) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    const p: Peer = { pc, epoch, makingOffer: false, ignoreOffer: false, settingAnswer: false, pendingIce: [], streams: [], received: new Map(), screenSubscribed: false, restarts: 0, timedOut: false, iceErrors: [] };
    this.peers.set(userId, p);
    this.connectionStatus();
    p.connectionTimer = setTimeout(() => {
      if (this.destroyed || pc.connectionState === 'connected' || pc.connectionState === 'closed') return;
      p.timedOut = true; this.connectionStatus();
      this.error(new Error('No media connection was established. Try another network or ask the server owner to enable a media relay.'));
    }, 25000);
    pc.onicecandidateerror = event => { p.iceErrors = [...p.iceErrors.slice(-4), event.errorCode]; };
    for (const track of this.outgoing?.getTracks() || []) pc.addTrack(track, this.outgoing!);
    if (this.screen) { const transceiver = pc.addTransceiver('video', { direction: 'sendrecv', streams: [this.screen] }); p.screenSender = transceiver.sender; }
    pc.onnegotiationneeded = async () => {
      // Elect one initial offerer. This avoids needless rollback/glare while
      // both peers are still gathering their first ICE candidates. Subsequent
      // changes retain the perfect-negotiation collision handling below.
      if (pc.signalingState !== 'stable' || (!pc.remoteDescription && this.options.userId.localeCompare(userId) > 0)) return;
      try { p.makingOffer = true; await pc.setLocalDescription(); await this.signal(userId, { description: pc.localDescription!.toJSON() }); } catch (e) { if (pc.connectionState !== 'closed') this.error(e); } finally { p.makingOffer = false; }
    };
    pc.onicecandidate = e => { if (e.candidate) void this.signal(userId, { candidate: e.candidate.toJSON() }).catch(err => this.error(err)); };
    pc.ontrack = e => {
      const stream = e.streams[0] || new MediaStream([e.track]); p.received.set(stream.id, stream); this.attachTracks(userId, p);
      e.track.onended = () => { if (e.track.kind === 'video') { const meta = p.streams.find(s => s.streamId === stream.id); if (meta?.leaseId) this.options.emit('screenRemoved', meta.leaseId); } };
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') { p.restarts = 0; p.timedOut = false; clearTimeout(p.connectionTimer); }
      this.connectionStatus();
      if (pc.connectionState === 'failed' && p.restarts++ < 3) { pc.restartIce(); this.options.emit('status', 'Repairing media connection…'); }
      else if (pc.connectionState === 'failed') this.error(new Error('Direct media connection failed. Configure TURN or select SFU mode.'));
      if (pc.connectionState === 'disconnected') setTimeout(() => { if (pc.connectionState === 'disconnected' && p.restarts++ < 3) pc.restartIce(); }, 3000);
    };
    return p;
  }
  private attachTracks(userId: string, p: Peer) {
    for (const [streamId, stream] of p.received) {
      const metadata = p.streams.find(s => s.streamId === streamId);
      if (!metadata) continue;
      if (metadata.kind === 'audio' && stream.getAudioTracks().length && !p.audio && this.context) {
        const element = document.createElement('audio'); element.autoplay = true; element.muted = true; element.volume = 0; element.srcObject = stream; element.style.display = 'none'; document.body.appendChild(element);
        const source = this.context.createMediaStreamSource(stream), gain = this.context.createGain(), analyser = this.context.createAnalyser();
        const meterSource = this.context.createMediaStreamSource(stream), meter = new AudioActivityMeter(analyser);
        meterSource.connect(analyser); source.connect(gain).connect(this.context.destination);
        p.audio = { source, element, gain, analyser, meterSource, meter }; this.applyVolume(userId);
        void element.play().catch(() => this.error(new Error('Audio playback was blocked. Rejoin voice to enable audio.')));
      }
      if (metadata.kind === 'screen' && metadata.leaseId && this.watchedShares.has(metadata.leaseId) && !this.hiddenShares.has(metadata.leaseId) && this.room?.shares.some(s => s.id === metadata.leaseId && s.userId === userId)) this.options.emit('screen', { userId, leaseId: metadata.leaseId, stream });
    }
  }
  private async receive(v: Signal) {
    if (v.channelId !== this.channelId || !v.from || !this.epoch) return;
    let member = this.room?.members.find(m => m.user.id === v.from);
    if (!member || member.epoch !== v.epoch) { const room = await ack(this.options.socket, 'voice:heartbeat', {}); if (room.room) await this.updateRoom(room.room); member = this.room?.members.find(m => m.user.id === v.from); }
    if (!member || member.epoch !== v.epoch) return;
    const p = this.peers.get(v.from) || this.createPeer(v.from, v.epoch), pc = p.pc;
    if (v.streams) { p.streams = v.streams; this.attachTracks(v.from, p); }
    if (v.subscription) {
      if (this.lease?.id === v.subscription.leaseId) { p.screenSubscribed = v.subscription.enabled; if (p.screenSender) await p.screenSender.replaceTrack(v.subscription.enabled ? this.screen?.getVideoTracks()[0] || null : null); }
      return;
    }
    if (v.description) {
      const ready = !p.makingOffer && (pc.signalingState === 'stable' || p.settingAnswer), collision = v.description.type === 'offer' && !ready;
      const polite = this.options.userId.localeCompare(v.from) > 0;
      p.ignoreOffer = !polite && collision;
      if (p.ignoreOffer) return;
      p.settingAnswer = v.description.type === 'answer';
      try { await pc.setRemoteDescription(v.description); } finally { p.settingAnswer = false; }
      for (const candidate of p.pendingIce.splice(0)) await pc.addIceCandidate(candidate).catch(e => { if (!p.ignoreOffer) throw e; });
      if (v.description.type === 'offer') { await pc.setLocalDescription(); await this.signal(v.from, { description: pc.localDescription!.toJSON() }); }
    } else if (v.candidate) {
      if (!pc.remoteDescription) p.pendingIce.push(v.candidate);
      else try { await pc.addIceCandidate(v.candidate); } catch (e) { if (!p.ignoreOffer) throw e; }
    }
  }
  private async updateRoom(room: VoiceRoom) {
    if (room.channelId !== this.channelId) return;
    this.room = room;
    const own = room.shares.find(s => s.userId === this.options.userId);
    if (this.lease && own) { if (this.lease.tier === 'fallback' && own.tier === 'standard') this.options.emit('notice', '30fps is now available for your screen.'); this.lease = own; }
    for (const [userId, p] of this.peers) if (!room.members.some(m => m.user.id === userId && m.epoch === p.epoch)) this.removePeer(userId);
    if (this.epoch) for (const m of room.members) if (m.user.id !== this.options.userId && !this.peers.has(m.user.id)) this.createPeer(m.user.id, m.epoch);
    for (const track of this.mic?.getAudioTracks() || []) track.enabled = !this.muted && !this.deafened && !room.members.find(m => m.user.id === this.options.userId)?.serverMuted && !this.room?.members.find(m => m.user.id === this.options.userId)?.serverDeafened;
    for (const [userId, p] of this.peers) { this.applyVolume(userId); this.attachTracks(userId, p); }
    if (this.lease && !room.shares.some(s => s.id === this.lease!.id)) await this.stopShare();
    this.connectionStatus();
    this.options.emit('room', room);
  }
  private applyVolume(userId: string) {
    const p = this.peers.get(userId); if (!p?.audio) return;
    const member = this.room?.members.find(m => m.user.id === userId);
    p.audio.gain.gain.value = this.deafened || this.room?.members.find(m => m.user.id === this.options.userId)?.serverDeafened || member?.serverMuted || member?.muted || member?.deafened ? 0 : (this.volumes.get(userId) ?? 1);
  }
  private attachMicMeter() { this.micSource?.disconnect(); if (!this.context || !this.mic) return; this.micSource = this.context.createMediaStreamSource(this.mic); this.micAnalyser = this.context.createAnalyser(); this.micAnalyser.fftSize = 512; this.micSource.connect(this.micAnalyser); this.micMeter = new AudioActivityMeter(this.micAnalyser); }
  private removePeer(userId: string) { const p = this.peers.get(userId); if (p) { clearTimeout(p.connectionTimer); p.pc.onconnectionstatechange = null; p.pc.onicecandidateerror = null; p.pc.onnegotiationneeded = null; p.pc.onicecandidate = null; p.pc.close(); p.audio?.source.disconnect(); p.audio?.gain.disconnect(); p.audio?.meterSource.disconnect(); p.audio?.analyser.disconnect(); this.options.emit('speaking', { userId, speaking: false }); if (p.audio) { p.audio.element.pause(); p.audio.element.srcObject = null; p.audio.element.remove(); } for (const s of p.streams) if (s.leaseId) this.options.emit('screenRemoved', s.leaseId); this.peers.delete(userId); } }
  private publishedState = ''; private stateTask: Promise<void> | null = null;
  private publishState(): Promise<void> {
    if (!this.room) { this.publishedState = ''; return Promise.resolve(); }
    if (!this.stateTask) this.stateTask = Promise.resolve().then(async () => {
      while (this.room) {
        const key = JSON.stringify([this.room.channelId, this.epoch, this.generation, this.muted, this.deafened]);
        if (key === this.publishedState) break;
        await ack(this.options.socket, 'voice:state', { muted: this.muted, deafened: this.deafened, requestId: crypto.randomUUID() }); this.publishedState = key;
      }
    }).finally(() => { this.stateTask = null; });
    return this.stateTask;
  }
  async setMuted(value: boolean) { this.muted = value; for (const t of this.mic?.getAudioTracks() || []) t.enabled = !value && !this.deafened && !this.room?.members.find(m => m.user.id === this.options.userId)?.serverMuted && !this.room?.members.find(m => m.user.id === this.options.userId)?.serverDeafened; await this.publishState(); }
  async setDeafened(value: boolean) { this.deafened = value; for (const userId of this.peers.keys()) this.applyVolume(userId); await this.setMuted(this.muted); }
  setVolume(userId: string, value: number) {
    this.volumes.set(userId, Math.max(0, Math.min(2, value))); this.applyVolume(userId);
    if (value > 0 && this.context?.state === 'suspended') void this.context.resume().catch(error => this.error(error));
  }
  async setDevice(deviceId: string) { await this.replaceMicrophone(deviceId, this.captureProcessing); }
  async setOutputDevice(deviceId: string) { if (!this.context || typeof (this.context as any).setSinkId !== 'function') throw new Error('Speaker selection is not supported in this browser.'); await (this.context as any).setSinkId(deviceId); }
  getLocalAudioStream() { return this.outgoing; }
  async setMicrophoneGain(value: number) {
    this.gainValue = clampMicrophoneGain(value); this.inputGain.setGain(this.gainValue); await this.inputGain.resume();
  }
  private async prepareMicrophone(stream: MediaStream) {
    await this.inputGain.restart({ track: stream.getAudioTracks()[0], audioContext: this.context! });
    const track = this.inputGain.processedTrack!;
    if (!this.outgoing) this.outgoing = new MediaStream();
    for (const old of this.outgoing.getTracks()) this.outgoing.removeTrack(old);
    this.outgoing.addTrack(track); return track;
  }
  private replaceMicrophone(deviceId: string, processing: AudioProcessing): Promise<void> {
    const epoch = this.epoch;
    const next = this.microphoneChange.catch(() => {}).then(async () => { if (this.channelId && epoch === this.epoch) await this.replaceMicrophoneNow(deviceId, processing); });
    this.microphoneChange = next; return next;
  }
  private async replaceMicrophoneNow(deviceId: string, processing: AudioProcessing) {
    const old = this.mic, epoch = this.epoch, previousDevice = old?.getAudioTracks()[0]?.getSettings().deviceId;
    const acquire = (device: string, settings: AudioProcessing) => navigator.mediaDevices.getUserMedia({ audio: { ...(device ? { deviceId: { exact: device } } : {}), ...settings } });
    const restorePrevious = async () => {
      try {
        const restored = await acquire(previousDevice || '', this.captureProcessing);
        restored.getAudioTracks()[0].enabled = false;
        if (epoch !== this.epoch || !this.channelId) restored.getTracks().forEach(t => t.stop());
        else { const output = await this.prepareMicrophone(restored); this.mic = restored; await Promise.allSettled([...this.peers.values()].map(async p => { const sender = p.pc.getSenders().find(s => s.track?.kind === 'audio'); if (sender) await sender.replaceTrack(output); })); this.attachMicMeter(); await this.setMuted(this.muted); }
      } catch { /* Original capture error is reported; no unmuted fallback. */ }
    };
    // Chromium shares preprocessing with a still-open capture of the same
    // device. Release it first, as the SFU SDK's restartTrack does as well.
    old?.getTracks().forEach(t => t.stop());
    let next: MediaStream;
    try { next = await acquire(deviceId, processing); }
    catch (error) {
      // Attempt to restore the previous device/settings if reacquisition fails.
      await restorePrevious();
      throw error;
    }
    if (epoch !== this.epoch || !this.channelId) { next.getTracks().forEach(t => t.stop()); return; }
    const track = next.getAudioTracks()[0];
    // A released talk key while replaceTrack awaits must not leak the new mic.
    // Enable only after installation, using the latest mute/deafen state.
    track.enabled = false;
    try {
      const output = await this.prepareMicrophone(next);
      for (const p of this.peers.values()) { const sender = p.pc.getSenders().find(s => s.track?.kind === 'audio'); if (sender) await sender.replaceTrack(output); }
    } catch (error) {
      next.getTracks().forEach(t => t.stop()); await restorePrevious(); throw error;
    }
    this.mic = next; old?.getTracks().forEach(t => t.stop()); this.attachMicMeter(); await this.setMuted(this.muted);
  }
  getAudioProcessing() { return browserAudioProcessing(this.audioProcessing, this.mic?.getAudioTracks()[0], this.captureProcessing); }
  async setAudioProcessing(settings: AudioProcessing) {
    const track = this.mic?.getAudioTracks()[0];
    if (track?.readyState === 'live') {
      await track.applyConstraints({ ...track.getConstraints(), ...settings });
      if (processingMismatch(track, settings)) await this.replaceMicrophone(track.getSettings().deviceId || '', settings);
    }
    this.audioProcessing = { ...settings };
    this.captureProcessing = { ...settings };
  }
  async startShare(quality: ScreenQuality = '720p15', options:{bandwidth?:number}={}) {
    if (!this.channelId) throw new Error('Join a voice channel first.');
    if (this.screen) return;
    const result = await ack(this.options.socket, 'share:start', { requestId: crypto.randomUUID(), protocolVersion: 2, includeAudio: false }); this.lease = result.lease;
    let screen: MediaStream | undefined;
    try {
    if(quality.endsWith('30')&&(this.lease!.maxFrameRate||15)>=30){const updated=await ack(this.options.socket,'share:update',{requestId:crypto.randomUUID(),leaseId:this.lease!.id,expectedRevision:this.lease!.policyRevision,frameRate:30});this.lease=updated.lease;}
    this.screenBandwidth=options.bandwidth===undefined?undefined:clampScreenBandwidth(options.bandwidth);
    const settings = screenSettings(quality, this.options.screenPolicy, this.lease!, options.bandwidth); this.screenTarget = { bitrate: settings.bitrate, fps: settings.fps };
    const constraints = { width: { ideal: settings.width }, height: { ideal: settings.height }, frameRate: { ideal: this.screenTarget.fps, max: this.screenTarget.fps } };
      screen = await navigator.mediaDevices.getDisplayMedia({ video: constraints, audio: false }); this.screen = screen;
      screen.getVideoTracks()[0].onended = () => { void this.stopShare(); };
      for (const [userId, p] of this.peers) {
        if (p.screenSender) { p.screenSender.setStreams(screen); await p.screenSender.replaceTrack(p.screenSubscribed ? screen.getVideoTracks()[0] : null); } else { p.screenSender = p.pc.addTransceiver('video', { direction: 'sendrecv', streams: [screen] }).sender; if (p.screenSubscribed) await p.screenSender.replaceTrack(screen.getVideoTracks()[0]); }
        const parameters = p.screenSender.getParameters(); if (!parameters.encodings?.length) parameters.encodings = [{}]; parameters.encodings[0].maxBitrate = this.screenTarget.bitrate; parameters.encodings[0].maxFramerate = this.screenTarget.fps;
        await p.screenSender.setParameters(parameters).catch(() => {}); await this.signal(userId, {});
      }
      this.options.emit('localScreen', { userId: this.options.userId, leaseId: this.lease!.id, stream: screen });
    } catch (e) { screen?.getTracks().forEach(t => t.stop()); await this.stopShare(); throw e; }
  }
  async setShareQuality(quality: ScreenQuality, bandwidth?:number) {
    if (!this.lease) return;
    const result = await ack(this.options.socket, 'share:update', { requestId: crypto.randomUUID(), leaseId: this.lease.id, expectedRevision: this.lease.policyRevision, frameRate: quality.endsWith('30') ? 30 : 15 }); this.lease = result.lease;
    try {
    const settings = screenSettings(quality, this.options.screenPolicy, this.lease!, bandwidth??this.screenBandwidth);
    const track = this.screen?.getVideoTracks()[0];
    if (track) await track.applyConstraints({ width: { ideal: settings.width, max: settings.width }, height: { ideal: settings.height, max: settings.height }, frameRate: { ideal: settings.fps, max: settings.fps } });
    for (const p of this.peers.values()) if (p.screenSender?.track) { const params = p.screenSender.getParameters(); if (!params.encodings?.length) params.encodings = [{}]; for (const e of params.encodings) { e.maxBitrate = settings.bitrate; e.maxFramerate = settings.fps; } await p.screenSender.setParameters(params); }
    this.screenTarget = { bitrate: settings.bitrate, fps: settings.fps }; this.screenBandwidth=bandwidth??this.screenBandwidth;
    }catch(e){await this.stopShare();throw e;}
  }
  async stopShare() {
    const screen = this.screen, lease = this.lease; this.screen = null; this.lease = null;
    this.options.emit('localScreen', null);
    screen?.getTracks().forEach(t => { t.onended = null; t.stop(); });
    for (const p of this.peers.values()) { p.screenSubscribed = false; if (p.screenSender) await p.screenSender.replaceTrack(null).catch(() => {}); }
    if (lease && this.options.socket.connected && this.channelId) await ack(this.options.socket, 'share:stop', { requestId: crypto.randomUUID() }).catch(() => {});
  }
  async subscribe(share: Share, enabled: boolean) {
    if (enabled) { this.hiddenShares.delete(share.id); this.watchedShares.add(share.id); } else { this.hiddenShares.add(share.id); this.watchedShares.delete(share.id); }
    const p = this.peers.get(share.userId);
    if (!p) throw new Error('Publisher is no longer connected.');
    for (const s of p.streams) if (s.leaseId === share.id) for (const t of p.received.get(s.streamId)?.getTracks() || []) t.enabled = enabled;
    await this.signal(share.userId, { subscription: { leaseId: share.id, enabled } });
    if (!enabled) this.options.emit('screenRemoved', share.id); else this.attachTracks(share.userId, p);
  }
  async getStats() {
    const result: Record<string, any> = { audioProcessing: this.getAudioProcessing(), connectivity: { relayConfigured: this.iceServers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/i.test(url))), microphoneState: this.mic?.getAudioTracks()[0]?.readyState || 'absent', captureState: this.screen?.getVideoTracks()[0]?.readyState || 'absent' } };
    for (const [userId, p] of this.peers) {
      const stats = await p.pc.getStats(); const rows: any[] = [];
      stats.forEach(r => { if (['inbound-rtp', 'outbound-rtp', 'remote-inbound-rtp', 'candidate-pair'].includes(r.type)) rows.push({ ...r }); });
      result[userId] = { state: p.pc.connectionState, iceState: p.pc.iceConnectionState, signalingState: p.pc.signalingState, iceGatheringState: p.pc.iceGatheringState, iceErrors: p.iceErrors, restartAttempts: p.restarts, audioContext: this.context?.state, audioAttached: Boolean(p.audio), receivedStreams: [...p.received.keys()], describedStreams: p.streams, reports: rows };
      const congested = rows.some(r => r.type === 'remote-inbound-rtp' && (r.roundTripTime > 0.4 || r.fractionLost > 0.08));
      if (p.screenSender?.track) { const params = p.screenSender.getParameters(); if (params.encodings?.[0]) { params.encodings[0].maxBitrate = congested ? Math.min(450000, this.screenTarget.bitrate) : this.screenTarget.bitrate; params.encodings[0].maxFramerate = congested ? Math.min(10, this.screenTarget.fps) : this.screenTarget.fps; await p.screenSender.setParameters(params).catch(() => {}); } }
    }
    this.options.emit('stats', result); return result;
  }
  async leave() {
    this.generation++; this.joining = false; this.earlySignals = [];
    const previous = this.channelId; this.channelId = null; clearInterval(this.heartbeat); clearInterval(this.meter);
    this.watchedShares.clear(); this.hiddenShares.clear();
    await this.stopShare(); for (const userId of [...this.peers.keys()]) this.removePeer(userId);
    await this.microphoneChange.catch(() => {});
    this.mic?.getTracks().forEach(t => t.stop()); this.mic = null; await this.inputGain.destroy(); this.outgoing = null; this.micSource?.disconnect(); this.micSource = null; this.micAnalyser = null; this.micMeter = null; await this.context?.close().catch(() => {}); this.context = null; this.room = null; this.epoch = '';
    if (previous && this.options.socket.connected) await ack(this.options.socket, 'voice:leave', { requestId: crypto.randomUUID() }).catch(() => {});
    this.options.emit('room', null); this.options.emit('status', '');
  }
  async destroy() {
    this.destroyed = true; this.options.socket.off('voice:move', this.onMoved); await this.leave(); const s = this.options.socket;
    s.off('voice:room', this.onRoom); s.off('voice:signal', this.onSignal); s.off('voice:removed', this.onRemoved); s.off('connect', this.onConnect); s.off('disconnect', this.onDisconnect);
  }
}
