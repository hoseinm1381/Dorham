package com.dorham.chat

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.AudioDeviceCallback
import android.media.AudioFocusRequest
import android.media.AudioAttributes
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.activity.result.ActivityResult
import com.getcapacitor.*
import com.getcapacitor.annotation.*
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.participant.VideoTrackPublishOptions
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.LocalScreencastVideoTrack
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import io.livekit.android.room.Room
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.VideoTrack as LiveVideoTrack
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import livekit.org.webrtc.*
import livekit.org.webrtc.audio.JavaAudioDeviceModule
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

@CapacitorPlugin(name = "DorhamMedia", permissions = [Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO]), Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS]), Permission(alias = "bluetooth", strings = [Manifest.permission.BLUETOOTH_CONNECT])])
class DorhamMediaPlugin : Plugin() {
    companion object { var active: DorhamMediaPlugin? = null }
    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var egl: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var audioSource: AudioSource? = null
    private var microphone: AudioTrack? = null
    private var screenSource: VideoSource? = null
    private var screenTrack: VideoTrack? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var texture: SurfaceTextureHelper? = null
    private var selfId = ""
    private var room = JSONObject()
    private var ice = emptyList<PeerConnection.IceServer>()
    private var muted = false
    private var deafened = false
    private val speechPlayer by lazy { NativeSpeechPlayer(context) }
    private val soundboardPlayer by lazy { NativeSpeechPlayer(context) }
    private var screenAudio: ScreenAudioPublisher? = null
    private var pendingProjectionGeneration = -1L
    private var screenLease: String? = null
    private var screenBitrate = 1200000
    private var screenFps = 15
    private var screenWidth = 1280
    private var screenHeight = 720
    private var nextAdaptation = 0L
    private var micStream = UUID.randomUUID().toString()
    private var screenStream = UUID.randomUUID().toString()
    private var sfu: Room? = null
    private var sfuReady = false
    private var microphoneAvailable = false
    private val microphoneLock = Mutex()
    private var viewer: FrameLayout? = null
    private val renderers = mutableListOf<Pair<SurfaceViewRenderer, () -> Unit>>()
    private val volumes = mutableMapOf<String, Double>()
    private val peers = mutableMapOf<String, Peer>()
    private val sfuVideos = mutableMapOf<String, LiveVideoTrack>()
    private val watched = mutableSetOf<String>()
    private val streamVolumes = mutableMapOf<String, Double>()
    private val speakingStates = mutableMapOf<String, Boolean>()
    private var generation = 0L
    private var language = "en-US"
    private var callName = "Dorham"
    private var previousAudioMode = AudioManager.MODE_NORMAL
    private var previousSpeaker = false
    private var audioFocus: AudioFocusRequest? = null
    private val routesCallback = object : AudioDeviceCallback() { override fun onAudioDevicesAdded(devices: Array<out AudioDeviceInfo>) { emitRoutes() }; override fun onAudioDevicesRemoved(devices: Array<out AudioDeviceInfo>) { emitRoutes() } }
    private val videoViews by lazy { NativeVideoViews(activity, bridge.webView, { surface -> sfu?.initVideoRenderer(surface) ?: surface.init(requireNotNull(egl).eglBaseContext, null) }, { user, lease, local ->
        val shares = room.optJSONArray("shares") ?: JSONArray()
        val allowed = (0 until shares.length()).any { shares.getJSONObject(it).let { share -> share.optString("id") == lease && share.optString("userId") == user } }
        if (!allowed || (!local && lease !in watched)) null else if (local && user == selfId && lease == screenLease) sfu?.localParticipant?.trackPublications?.values?.mapNotNull { it.track as? LocalScreencastVideoTrack }?.firstOrNull() ?: screenTrack else sfuVideos[user] ?: peers[user]?.video
    }, { id, value -> emit("videoView", JSONObject().put("id", id).put("ready", value)) }) }
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private data class Peer(val id: String, val epoch: String, val pc: PeerConnection, var makingOffer: Boolean = false, var ignoreOffer: Boolean = false, var metadata: JSONArray = JSONArray(), val pendingIce: MutableList<IceCandidate> = mutableListOf(), var audio: AudioTrack? = null, val screenAudios: MutableMap<String, AudioTrack> = mutableMapOf(), var video: VideoTrack? = null, var screenSender: RtpSender? = null, var subscribed: Boolean = true)
    private fun emit(name: String, value: JSONObject) = notifyListeners(name, JSObject.fromJSONObject(value))
    private fun error(message: String) = emit("error", JSONObject().put("message", message))
    private fun ui(call: PluginCall, work: () -> Unit) { main.post { try { work() } catch (e: Exception) { call.reject(e.message ?: "Native media failed", e) } } }
    private fun canUseMicrophone() = getPermissionState("microphone") == PermissionState.GRANTED && context.getSystemService(AudioManager::class.java).getDevices(AudioManager.GET_DEVICES_INPUTS).isNotEmpty()
    private fun prepared(call: PluginCall) { call.resolve(JSObject().put("microphoneAvailable", canUseMicrophone()).put("sharedAudio", canUseMicrophone() && Build.VERSION.SDK_INT >= 29)) }
    private suspend fun applySfuMicrophone(live: Room) = microphoneLock.withLock {
        if (sfu !== live || !sfuReady) return@withLock
        val enabled = microphoneAvailable && !muted && !deafened && !selfMuted() && !selfDeafened()
        try { live.localParticipant.setMicrophoneEnabled(enabled) }
        catch (e: Exception) {
            if (!enabled) throw e
            microphoneAvailable = false
            try { live.localParticipant.setMicrophoneEnabled(false) } catch (_: Exception) {}
            VoiceService.instance?.microphone(false)
            emit("listenOnly", JSONObject())
        }
    }
    @PluginMethod fun prepare(call: PluginCall) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) requestPermissionForAlias("microphone", call, "microphoneResult") else prepareNotifications(call)
    }
    @PermissionCallback private fun microphoneResult(call: PluginCall) { prepareNotifications(call) }
    private fun prepareNotifications(call: PluginCall) { if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) requestPermissionForAlias("notifications", call, "notificationsResult") else prepared(call) }
    @PermissionCallback private fun notificationsResult(call: PluginCall) { prepared(call) }
    @PermissionCallback private fun bluetoothResult(call: PluginCall) { if (getPermissionState("bluetooth") == PermissionState.GRANTED) setDevice(call) else call.reject("Bluetooth permission was denied. Select the speaker or earpiece instead.") }
    @PluginMethod fun join(call: PluginCall) = ui(call) {
        val recovering = call.getBoolean("recovering") == true
        val runningService = if (recovering) VoiceService.instance else null
        release(stopService = runningService == null); generation++; active = this; language = call.getString("language") ?: "en-US"; callName = call.getString("channelName") ?: "Dorham"; selfId = call.getString("selfId") ?: error("Missing identity").let { "" }; room = call.getObject("room") ?: JSONObject()
        microphoneAvailable = canUseMicrophone(); muted = call.getBoolean("muted") ?: false; deafened = call.getBoolean("deafened") ?: false
        if (runningService == null) {
            context.startForegroundService(Intent(context, VoiceService::class.java).putExtra("microphone", microphoneAvailable).putExtra("language", language).putExtra("channelName", callName))
        } else {
            runningService.microphone(microphoneAvailable)
        }
        val audioManager = context.getSystemService(AudioManager::class.java); previousAudioMode = audioManager.mode; previousSpeaker = audioManager.isSpeakerphoneOn; audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        audioManager.registerAudioDeviceCallback(routesCallback, main)
        VoiceService.instance?.details(language, callName, muted)
        if (call.getObject("credentials") == null) {
            val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()).setOnAudioFocusChangeListener { change -> if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) { muted = true; updatePeers(); emit("nativeMuted", JSONObject().put("muted", true)) } }.build()
            if (audioManager.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) throw IllegalStateException("Another call is using audio. Try again when it finishes.")
            audioFocus = focus
        }
        val servers = call.getArray("iceServers") ?: JSArray(); ice = (0 until servers.length()).map { n -> val item = servers.getJSONObject(n); val urls = item.optJSONArray("urls") ?: JSONArray().put(item.optString("urls")); PeerConnection.IceServer.builder((0 until urls.length()).map { urls.getString(it) }).setUsername(item.optString("username")).setPassword(item.optString("credential")).createIceServer() }
        val credentials = call.getObject("credentials")
        if (credentials != null) {
            val joinGeneration = generation; val live = LiveKit.create(context); sfu = live
            scope.launch {
                try {
                    launch { live.events.collect { event ->
                        if (sfu !== live || generation != joinGeneration) return@collect
                        when (event) {
                            is RoomEvent.TrackSubscribed -> { val id = event.participant.identity?.value?.substringBefore(":") ?: ""; when (val track = event.track) { is LiveVideoTrack -> { sfuVideos[id] = track; videoViews.refresh(); emit("video", JSONObject().put("userId", id)) }; is RemoteAudioTrack -> track.setVolume(sfuVolume(id, event.publication.source)) } }
                            is RoomEvent.TrackUnsubscribed -> { val id = event.participant.identity?.value?.substringBefore(":") ?: ""; if (event.track is LiveVideoTrack) { sfuVideos.remove(id); videoViews.refresh() } }
                            is RoomEvent.ActiveSpeakersChanged -> members().forEach { member -> val id = member.getJSONObject("user").getString("id"); speaking(id, event.speakers.any { it.identity?.value?.substringBefore(":") == id && !it.identity!!.value.contains(":screen:") }) }
                            is RoomEvent.Reconnecting -> emit("status", JSONObject().put("message", "Reconnecting voice…"))
                            is RoomEvent.Reconnected -> { emit("status", JSONObject().put("message", "Voice connected")); updateSubscriptions(); emitRoutes() }
                            is RoomEvent.Disconnected -> {
                                sfuReady = false
                                val terminal = event.reason.name in setOf("PARTICIPANT_REMOVED", "DUPLICATE_IDENTITY", "CLIENT_INITIATED")
                                emit("voiceMediaDisconnected", JSONObject().put("terminal", terminal))
                            }
                            is RoomEvent.TrackPublished -> updateSubscriptions()
                            else -> {}
                        }
                    } }
                    live.connect(requireNotNull(credentials.getString("url")), requireNotNull(credentials.getString("token")), io.livekit.android.ConnectOptions(autoSubscribe = false)); require(sfu === live && generation == joinGeneration) { "Voice session changed" }; sfuReady = true; applySfuMicrophone(live); updateSubscriptions(); emitRoutes(); call.resolve(JSObject().put("listenOnly", !microphoneAvailable))
                } catch (e: Exception) { if (sfu === live && generation == joinGeneration) release(stopService = !recovering); call.reject("SFU connection failed: ${e.message}") }
            }
        } else {
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions())
            val shared = EglBase.create(); egl = shared
            val adm = JavaAudioDeviceModule.builder(context).setUseHardwareAcousticEchoCanceler(true).setUseHardwareNoiseSuppressor(true).createAudioDeviceModule()
            factory = PeerConnectionFactory.builder().setAudioDeviceModule(adm).setVideoEncoderFactory(DefaultVideoEncoderFactory(shared.eglBaseContext, true, true)).setVideoDecoderFactory(DefaultVideoDecoderFactory(shared.eglBaseContext)).createPeerConnectionFactory(); adm.release()
            val constraints = MediaConstraints().apply { optional.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true")); optional.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true")); optional.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true")) }
            if (microphoneAvailable) { audioSource = factory!!.createAudioSource(constraints); microphone = factory!!.createAudioTrack(UUID.randomUUID().toString(), audioSource) }
            updatePeers(); main.postDelayed(meter, 1000); call.resolve(JSObject().put("listenOnly", !microphoneAvailable))
        }
        val callback = object : ConnectivityManager.NetworkCallback() { override fun onAvailable(network: Network) { main.post { peers.values.forEach { it.pc.restartIce() } } } }
        context.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(callback); networkCallback = callback
    }
    private fun members(): List<JSONObject> { val list = room.optJSONArray("members") ?: JSONArray(); return (0 until list.length()).map { list.getJSONObject(it) } }
    private fun selfDeafened() = members().firstOrNull { it.optJSONObject("user")?.optString("id") == selfId }?.optBoolean("serverDeafened") == true
    private fun selfMuted() = members().firstOrNull { it.optJSONObject("user")?.optString("id") == selfId }?.optBoolean("serverMuted") == true
    private fun descriptions(): JSONArray = JSONArray().apply { put(JSONObject().put("streamId", micStream).put("kind", "audio")); if (screenLease != null) put(JSONObject().put("streamId", screenStream).put("kind", "screen").put("leaseId", screenLease)) }
    private fun signal(peer: String, payload: JSONObject) { payload.put("to", peer).put("streams", descriptions()); emit("signal", payload) }
    private fun observer(peerId: String): PeerConnection.Observer = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) { if (state == PeerConnection.IceConnectionState.FAILED) main.post { peers[peerId]?.pc?.restartIce() } }
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
        override fun onIceCandidate(candidate: IceCandidate) { main.post { signal(peerId, JSONObject().put("candidate", JSONObject().put("candidate", candidate.sdp).put("sdpMid", candidate.sdpMid).put("sdpMLineIndex", candidate.sdpMLineIndex))) } }
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        override fun onAddStream(stream: MediaStream) {}
        override fun onRemoveStream(stream: MediaStream) {}
        override fun onDataChannel(channel: DataChannel) {}
        override fun onRenegotiationNeeded() { main.post { peers[peerId]?.let { offer(it) } } }
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) { main.post { val p = peers[peerId] ?: return@post; when (val track = receiver.track()) { is AudioTrack -> { val streamId = streams.firstOrNull()?.id; val metadata = (0 until p.metadata.length()).map { p.metadata.getJSONObject(it) }.firstOrNull { it.optString("streamId") == streamId }; if (metadata?.optString("kind") == "screen") p.screenAudios[metadata.optString("leaseId")] = track else p.audio = track; applyVolume(p) }; is VideoTrack -> { p.video = track; val share = shareFor(peerId); track.setEnabled(share != null && share.optString("id") in watched); videoViews.refresh(); emit("video", JSONObject().put("userId", peerId)) } } } }
    }
    private fun newPeer(userId: String, epoch: String): Peer {
        val config = PeerConnection.RTCConfiguration(ice).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN; continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY }
        val pc = factory!!.createPeerConnection(config, observer(userId)) ?: throw IllegalStateException("Could not create media connection")
        val peer = Peer(userId, epoch, pc); peers[userId] = peer
        if (microphone != null) pc.addTrack(microphone!!, listOf(micStream)) else pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY)); screenTrack?.let { peer.screenSender = pc.addTrack(it, listOf(screenStream)) }; return peer
    }
    private fun sdp(success: (SessionDescription?) -> Unit = {}, failure: (String) -> Unit = { error(it) }): SdpObserver = object : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) { main.post { success(description) } }
        override fun onSetSuccess() { main.post { success(null) } }
        override fun onCreateFailure(message: String) { main.post { failure(message) } }
        override fun onSetFailure(message: String) { main.post { failure(message) } }
    }
    private fun offer(p: Peer) {
        if (p.makingOffer || p.pc.signalingState() != PeerConnection.SignalingState.STABLE) return
        p.makingOffer = true
        p.pc.createOffer(sdp({ description -> if (description != null) p.pc.setLocalDescription(sdp({ p.makingOffer = false; signal(p.id, JSONObject().put("description", JSONObject().put("type", "offer").put("sdp", description.description))) }, { p.makingOffer = false; error(it) }), description) }, { p.makingOffer = false; error(it) }), MediaConstraints())
    }
    @PluginMethod fun signal(call: PluginCall) = ui(call) {
        val v = call.getObject("signal") ?: throw IllegalArgumentException("Signal required"); val from = v.getString("from") ?: throw IllegalArgumentException("Signal sender required"); val member = members().firstOrNull { it.optJSONObject("user")?.optString("id") == from && it.optString("epoch") == v.optString("epoch") }
        if (member == null || factory == null) { call.resolve(); return@ui }
        val p = peers[from] ?: newPeer(from, member.getString("epoch")); p.metadata = v.optJSONArray("streams") ?: p.metadata
        v.optJSONObject("subscription")?.let { sub -> if (sub.optString("leaseId") == screenLease) { p.subscribed = sub.getBoolean("enabled"); p.screenSender?.setTrack(if (p.subscribed) screenTrack else null, false) }; call.resolve(); return@ui }
        val description = v.optJSONObject("description")
        if (description != null) {
            val isOffer = description.getString("type") == "offer"; val collision = isOffer && (p.makingOffer || p.pc.signalingState() != PeerConnection.SignalingState.STABLE)
            p.ignoreOffer = collision && selfId < from
            if (!p.ignoreOffer) {
                val setRemote = {
                    p.pc.setRemoteDescription(sdp({
                        p.pendingIce.forEach { p.pc.addIceCandidate(it) }; p.pendingIce.clear()
                        if (isOffer) p.pc.createAnswer(sdp({ answer -> if (answer != null) p.pc.setLocalDescription(sdp({ signal(from, JSONObject().put("description", JSONObject().put("type", "answer").put("sdp", answer.description))) }), answer) }), MediaConstraints())
                    }), SessionDescription(SessionDescription.Type.fromCanonicalForm(description.getString("type")), description.optString("sdp")))
                }
                if (collision) p.pc.setLocalDescription(sdp({ p.makingOffer = false; setRemote() }), SessionDescription(SessionDescription.Type.ROLLBACK, "")) else setRemote()
            }
        } else v.optJSONObject("candidate")?.let { c -> if (!p.ignoreOffer) { val candidate = IceCandidate(c.optString("sdpMid"), c.optInt("sdpMLineIndex"), c.optString("candidate")); if (p.pc.remoteDescription == null) p.pendingIce.add(candidate) else p.pc.addIceCandidate(candidate) } }
        call.resolve()
    }
    @PluginMethod fun updateRoom(call: PluginCall) = ui(call) { room = call.getObject("room") ?: room; updatePeers(); call.resolve() }
    private fun updatePeers() {
        val ids = members().filter { it.getJSONObject("user").getString("id") != selfId }.associateBy { it.getJSONObject("user").getString("id") }
        peers.keys.toList().forEach { id -> val p = peers[id]!!; if (ids[id]?.optString("epoch") != p.epoch) { p.pc.close(); p.pc.dispose(); peers.remove(id) } }
        if (factory != null) ids.forEach { (id, member) -> if (!peers.containsKey(id)) newPeer(id, member.getString("epoch")) }
        microphone?.setEnabled(!muted && !deafened && !selfMuted() && !selfDeafened()); peers.values.forEach { applyVolume(it) }
        if (deafened || selfDeafened()) { speechPlayer.stop(); soundboardPlayer.stop() }
        updateSubscriptions(); VoiceService.instance?.details(language, callName, muted)
        sfu?.let { live -> scope.launch { try { applySfuMicrophone(live) } catch (e: Exception) { error(e.message ?: "Microphone state failed") }; live.remoteParticipants.values.forEach { p -> p.trackPublications.values.forEach { pub -> (pub.track as? RemoteAudioTrack)?.setVolume(sfuVolume(p.identity?.value?.substringBefore(":") ?: "", pub.source)) } } } }
    }
    private fun shareFor(user: String): JSONObject? { val shares = room.optJSONArray("shares") ?: JSONArray(); return (0 until shares.length()).map { shares.getJSONObject(it) }.firstOrNull { it.optString("userId") == user } }
    private fun sfuVolume(user: String, source: io.livekit.android.room.track.Track.Source): Double { if (deafened || selfDeafened()) return 0.0; if (source != io.livekit.android.room.track.Track.Source.SCREEN_SHARE_AUDIO) return volumes[user] ?: 1.0; val share = shareFor(user) ?: return 0.0; return if (share.optString("id") in watched && share.optBoolean("includeAudio")) streamVolumes[share.optString("id")] ?: 1.0 else 0.0 }
    private fun updateSubscriptions() { watched.removeAll { lease -> val shares = room.optJSONArray("shares") ?: JSONArray(); !(0 until shares.length()).any { shares.getJSONObject(it).optString("id") == lease } }; sfu?.remoteParticipants?.values?.forEach { participant -> val id = participant.identity?.value?.substringBefore(":") ?: ""; val share = shareFor(id); participant.trackPublications.values.filterIsInstance<RemoteTrackPublication>().forEach { pub -> val wanted = AndroidMediaPolicy.shouldSubscribe(pub.source.name, share?.optString("id"), watched, share?.optBoolean("includeAudio") == true); pub.setSubscribed(wanted); (pub.track as? RemoteAudioTrack)?.setVolume(sfuVolume(id, pub.source)) } }; videoViews.refresh() }
    private fun speaking(id: String, value: Boolean) { if (speakingStates[id] != value) { speakingStates[id] = value; emit("speaking", JSONObject().put("userId", id).put("speaking", value)) } }
    private fun applyVolume(p: Peer) { p.screenAudios.forEach { (lease, track) -> track.setVolume(if (deafened || selfDeafened() || lease !in watched || shareFor(p.id)?.optString("id") != lease) 0.0 else streamVolumes[lease] ?: 1.0) }; val m = members().firstOrNull { it.getJSONObject("user").getString("id") == p.id }; p.audio?.setVolume(if (deafened || selfDeafened() || m?.optBoolean("serverMuted") == true || m?.optBoolean("muted") == true || m?.optBoolean("deafened") == true) 0.0 else volumes[p.id] ?: 1.0) }
    @PluginMethod fun playSpeech(call: PluginCall) = ui(call) { require(active === this && !deafened && !selfDeafened()) { "Speech playback is unavailable" }; val self = members().firstOrNull { it.optJSONObject("user")?.optString("id") == selfId }; require(self?.optString("epoch") == call.getString("epoch") && room.optString("channelId") == call.getString("channelId")) { "Voice session changed" }; speechPlayer.play(call) }
    @PluginMethod fun playSoundboard(call: PluginCall) = ui(call) {
        require(active === this && !deafened && !selfDeafened()) { "Soundboard playback is unavailable" }
        val self = members().firstOrNull { it.optJSONObject("user")?.optString("id") == selfId }
        require(self?.optString("epoch") == call.getString("epoch") && room.optString("channelId") == call.getString("channelId")) { "Voice session changed" }
        require((call.getString("wav")?.length ?: 0) in 1..87400) { "Soundboard clip is too large" }
        soundboardPlayer.play(call)
    }
    @PluginMethod fun stopSoundboard(call: PluginCall) = ui(call) { soundboardPlayer.stop(); call.resolve() }
    @PluginMethod fun stopSpeech(call: PluginCall) = ui(call) { speechPlayer.stop(); call.resolve() }
    @PluginMethod fun setState(call: PluginCall) = ui(call) { muted = call.getBoolean("muted") ?: false; deafened = call.getBoolean("deafened") ?: false; updatePeers(); sfu?.remoteParticipants?.values?.forEach { p -> p.trackPublications.values.forEach { pub -> (pub.track as? RemoteAudioTrack)?.setVolume(sfuVolume(p.identity?.value?.substringBefore(":") ?: "", pub.source)) } }; call.resolve() }
    @PluginMethod fun setVolume(call: PluginCall) = ui(call) { val id = call.getString("userId")!!; val volume = (call.getDouble("volume") ?: 1.0).coerceIn(0.0, 2.0); volumes[id] = volume; peers[id]?.let { applyVolume(it) }; sfu?.remoteParticipants?.values?.filter { it.identity?.value?.substringBefore(":") == id }?.forEach { p -> p.trackPublications.values.forEach { pub -> (pub.track as? RemoteAudioTrack)?.setVolume(sfuVolume(id, pub.source)) } }; call.resolve() }
    private fun routeName(device: AudioDeviceInfo): String = when(device.type) { AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Speaker"; AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "Earpiece"; AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "Bluetooth"; AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Wired headset"; AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE -> "USB headset"; else -> device.productName.toString() }
    private fun routes(): JSObject { val audio = context.getSystemService(AudioManager::class.java); val list = if (Build.VERSION.SDK_INT >= 31) audio.availableCommunicationDevices else audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList(); val rows = JSArray(); list.filter { it.type in listOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE) }.forEach { rows.put(JSObject().put("id", "route:" + it.id).put("name", routeName(it))) }; return JSObject().put("devices", rows).put("selected", if (Build.VERSION.SDK_INT >= 31) audio.communicationDevice?.let { "route:" + it.id } ?: "system" else "system") }
    private fun emitRoutes() { try { emit("audioRoutes", routes()) } catch (_: Exception) {} }
    @PluginMethod fun getAudioRoutes(call: PluginCall) = ui(call) { call.resolve(routes()) }
    @Suppress("DEPRECATION")
    @PluginMethod fun setDevice(call: PluginCall) = ui(call) {
        val audio = context.getSystemService(AudioManager::class.java); val name = call.getString("deviceId") ?: "system"
        if (name == "system" || name == "") { if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice() else { audio.stopBluetoothSco(); audio.isBluetoothScoOn = false; audio.isSpeakerphoneOn = false }; emitRoutes(); call.resolve(); return@ui }
        val devices = if (Build.VERSION.SDK_INT >= 31) audio.availableCommunicationDevices else audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
        val target = devices.firstOrNull { "route:" + it.id == name || (name == "speaker" && it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) || (name == "earpiece" && it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) || (name == "bluetooth" && it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) } ?: throw IllegalArgumentException("Selected audio route is unavailable")
        val bluetooth = target.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || target.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        if (bluetooth && Build.VERSION.SDK_INT >= 31 && getPermissionState("bluetooth") != PermissionState.GRANTED) { requestPermissionForAlias("bluetooth", call, "bluetoothResult"); return@ui }
        if (Build.VERSION.SDK_INT >= 31) require(audio.setCommunicationDevice(target)) { "Could not change audio route" } else { audio.stopBluetoothSco(); audio.isBluetoothScoOn = bluetooth; audio.isSpeakerphoneOn = target.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER; if (bluetooth) audio.startBluetoothSco() }; emitRoutes(); call.resolve()
    }
    @PluginMethod fun setStreamVolume(call: PluginCall) = ui(call) { val lease = call.getString("leaseId") ?: ""; streamVolumes[lease] = (call.getDouble("volume") ?: 1.0).coerceIn(0.0, 2.0); updatePeers(); call.resolve() }
    @PluginMethod fun setVideoView(call: PluginCall) = ui(call) { require(active === this) { "Join voice first" }; videoViews.update(call.data); call.resolve() }
    @PluginMethod fun removeVideoView(call: PluginCall) = ui(call) { videoViews.remove(call.getString("id") ?: ""); call.resolve() }
    fun visibility(visible: Boolean) { main.post { videoViews.visibility(visible) } }
    fun toggleMuteFromSystem() { main.post { muted = !muted; updatePeers(); emit("nativeMuted", JSONObject().put("muted", muted)) } }
    fun stopShareFromSystem() { main.post { stopCapture(); emit("captureStopped", JSONObject()) } }
    private fun shareSettings(call: PluginCall) {
        val quality = call.getString("quality") ?: "720p15"
        require(quality in listOf("480p15", "480p30", "720p15", "720p30", "1080p15")) { "Unsupported screen quality" }
        val width = when (quality) { "1080p15" -> 1920; "480p15", "480p30" -> 854; else -> 1280 }
        val height = when (width) { 1920 -> 1080; 854 -> 480; else -> 720 }
        screenWidth = (call.getInt("width") ?: width).coerceIn(160, width)
        screenHeight = (call.getInt("height") ?: height).coerceIn(90, height)
        val display = activity.resources.displayMetrics
        val dimensions = AndroidMediaPolicy.captureSize(maxOf(screenWidth, screenHeight), display.widthPixels, display.heightPixels)
        screenWidth = dimensions.first; screenHeight = dimensions.second
        screenFps = (call.getInt("fps") ?: if (quality.endsWith("15")) 15 else 30).coerceIn(1, if (quality == "1080p15") 15 else 30)
        screenBitrate = (call.getInt("bitrate") ?: 800000).coerceIn(64000, 1500000)
        sfu?.localParticipant?.let { p -> p.screenShareTrackCaptureDefaults = LocalVideoTrackOptions(isScreencast = true, captureParams = VideoCaptureParameter(screenWidth, screenHeight, screenFps)); p.screenShareTrackPublishDefaults = p.screenShareTrackPublishDefaults.copy(videoEncoding = VideoEncoding(screenBitrate, screenFps), simulcast = false, videoCodec = "vp8") }
    }
    @PluginMethod fun setShareQuality(call: PluginCall) = ui(call) {
        shareSettings(call)
        val live = sfu
        if (live != null && screenLease != null) {
            val track = live.localParticipant.trackPublications.values.mapNotNull { it.track as? LocalScreencastVideoTrack }.firstOrNull()
            if (track == null) { call.reject("Screen capture is not active"); return@ui }
            scope.launch { try {
                track.options = track.options.copy(captureParams = VideoCaptureParameter(screenWidth, screenHeight, screenFps))
                track.capturer.changeCaptureFormat(screenWidth, screenHeight, screenFps)
                live.localParticipant.unpublishTrack(track, stopOnUnpublish = false)
                if (!live.localParticipant.publishVideoTrack(track, VideoTrackPublishOptions(videoEncoding = VideoEncoding(screenBitrate, screenFps), simulcast = false, videoCodec = "vp8", source = io.livekit.android.room.track.Track.Source.SCREEN_SHARE))) throw IllegalStateException("Screen quality change could not be published")
                call.resolve()
            } catch (e: Exception) { stopCapture(); emit("captureStopped", JSONObject()); call.reject(e.message) } }
        } else {
            capturer?.changeCaptureFormat(screenWidth, screenHeight, screenFps)
            peers.values.forEach { p -> p.screenSender?.let { sender -> val params = sender.parameters; params.encodings.forEach { it.maxBitrateBps = screenBitrate; it.maxFramerate = screenFps }; sender.parameters = params } }
            call.resolve()
        }
    }
    @PluginMethod fun startShare(call: PluginCall) = ui(call) { if (screenLease != null) { call.resolve(); return@ui }; require(pendingProjectionGeneration < 0) { "A screen capture request is already open" }; pendingProjectionGeneration = generation; val manager = context.getSystemService(MediaProjectionManager::class.java); startActivityForResult(call, manager.createScreenCaptureIntent(), "projectionResult") }
    @ActivityCallback private fun projectionResult(call: PluginCall, result: ActivityResult) = ui(call) {
        val expectedGeneration = pendingProjectionGeneration; pendingProjectionGeneration = -1; require(expectedGeneration == generation && active === this) { "Voice session changed. Retry sharing." }; val data = result.data; if (result.resultCode != Activity.RESULT_OK || data == null) { call.reject("Screen capture was cancelled"); return@ui }
        require(VoiceService.instance != null) { "Voice service is not ready. Retry sharing." }; require(active === this && (sfuReady || factory != null)) { "Voice session changed. Retry sharing." }; shareSettings(call); screenLease = call.getString("leaseId"); screenStream = UUID.randomUUID().toString(); val callbackLease = screenLease; VoiceService.instance?.projection(true)
        val live = sfu
        if (live != null) { scope.launch { try { live.localParticipant.setScreenShareEnabled(true, ScreenCaptureParams(data, onStop = { main.post { if (generation == expectedGeneration && screenLease == callbackLease) { stopCapture(); emit("captureStopped", JSONObject()) } } })); require(expectedGeneration == generation && sfu === live && screenLease == call.getString("leaseId")) { "Screen capture was cancelled" };
            if (call.getBoolean("includeAudio") == true) {
                val credentials = requireNotNull(call.getObject("audioCredentials")) { "Sound sharing requires the updated server" }
                val video = live.localParticipant.trackPublications.values.mapNotNull { it.track as? LocalScreencastVideoTrack }.firstOrNull() ?: throw IllegalStateException("Screen capture is not active")
                val projection = (video.capturer as? ScreenCapturerAndroid)?.mediaProjection ?: throw IllegalStateException("Screen permission is unavailable")
                val publisher = ScreenAudioPublisher(context); screenAudio = publisher
                publisher.start(projection, credentials, call.getInt("audioBitrate") ?: 48000)
                require(expectedGeneration == generation && screenAudio === publisher) { "Screen capture was cancelled" }
            }; videoViews.refresh(); call.resolve() } catch (e: Exception) { stopCapture(); call.reject(e.message) } }; return@ui }
        val shared = egl ?: throw IllegalStateException("Join voice first"); val fac = factory ?: throw IllegalStateException("Join voice first")
        val videoSource = fac.createVideoSource(true); screenSource = videoSource
        val capture = ScreenCapturerAndroid(data, object : MediaProjection.Callback() { override fun onStop() { main.post { if (generation == expectedGeneration && screenLease == callbackLease) { stopCapture(); emit("captureStopped", JSONObject()) } } } }); capturer = capture
        val helper = SurfaceTextureHelper.create("DorhamScreen", shared.eglBaseContext); texture = helper; capture.initialize(helper, context, videoSource.capturerObserver)
        capture.startCapture(screenWidth, screenHeight, screenFps)
        val track = fac.createVideoTrack(UUID.randomUUID().toString(), videoSource); screenTrack = track
        peers.values.forEach { p -> p.subscribed = true; if (p.screenSender == null) p.screenSender = p.pc.addTrack(track, listOf(screenStream)) else { p.screenSender!!.setStreams(listOf(screenStream)); p.screenSender!!.setTrack(track, false) }; val params = p.screenSender!!.parameters; params.encodings.forEach { it.maxBitrateBps = screenBitrate; it.maxFramerate = screenFps }; p.screenSender!!.parameters = params; signal(p.id, JSONObject()) }
        call.resolve()
    }
    @PluginMethod fun stopShare(call: PluginCall) = ui(call) { stopCapture(); call.resolve() }
    private fun stopCapture() {
        pendingProjectionGeneration = -1
        screenAudio?.close(); screenAudio = null
        if (screenLease == null && capturer == null) return
        screenLease = null; peers.values.forEach { it.screenSender?.setTrack(null, false) }; screenTrack?.dispose(); screenTrack = null
        val old = capturer; capturer = null; try { old?.stopCapture(); old?.dispose() } catch (_: Exception) {}; screenSource?.dispose(); screenSource = null; texture?.dispose(); texture = null
        sfu?.let { live -> live.localParticipant.getTrackPublication(io.livekit.android.room.track.Track.Source.SCREEN_SHARE)?.track?.let { live.localParticipant.unpublishTrack(it) } }; videoViews.refresh(); VoiceService.instance?.projection(false)
    }
    @PluginMethod fun subscribe(call: PluginCall) = ui(call) {
        val id = call.getString("userId")!!; val enabled = call.getBoolean("enabled") ?: true; val lease = call.getString("leaseId")!!; require(shareFor(id)?.optString("id") == lease) { "Stream has ended" }; if (enabled) watched.add(lease) else watched.remove(lease)
        peers[id]?.video?.setEnabled(enabled); signal(id, JSONObject().put("subscription", JSONObject().put("leaseId", lease).put("enabled", enabled)))
        sfu?.remoteParticipants?.values?.filter { it.identity?.value?.substringBefore(":") == id }?.forEach { p -> p.trackPublications.values.filterIsInstance<RemoteTrackPublication>().filter { it.track is LiveVideoTrack }.forEach { it.setSubscribed(enabled) } }; updateSubscriptions(); peers[id]?.let { applyVolume(it) }; call.resolve()
    }
    @PluginMethod fun showVideo(call: PluginCall) = ui(call) {
        closeViewer(); val selected = call.getString("userId")!!; val ids = (peers.filterValues { it.video != null }.keys + sfuVideos.keys).sortedBy { if (it == selected) 0 else 1 }
        if (ids.isEmpty()) throw IllegalStateException("The stream is still connecting. Try again shortly.")
        val overlay = FrameLayout(activity).apply { setBackgroundColor(0xff11151d.toInt()) }; val list = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }; overlay.addView(list, FrameLayout.LayoutParams(-1, -1).apply { topMargin = 120 })
        ids.take(2).forEach { id ->
            val holder = FrameLayout(activity); val surface = SurfaceViewRenderer(activity); sfu?.initVideoRenderer(surface) ?: surface.init(egl!!.eglBaseContext, null); surface.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
            holder.addView(surface, FrameLayout.LayoutParams(-1, -1)); val localTrack = peers[id]?.video; val remoteTrack = sfuVideos[id]; localTrack?.addSink(surface); remoteTrack?.addRenderer(surface)
            val detach = { localTrack?.removeSink(surface); remoteTrack?.removeRenderer(surface); Unit }; renderers.add(surface to detach)
            val close = Button(activity).apply { text = "Stop watching this stream"; setOnClickListener { detach(); surface.release(); renderers.removeAll { it.first == surface }; peers[id]?.video?.setEnabled(false); val shares = room.optJSONArray("shares") ?: JSONArray(); for (i in 0 until shares.length()) { val share = shares.getJSONObject(i); if (share.getString("userId") == id) signal(id, JSONObject().put("subscription", JSONObject().put("leaseId", share.getString("id")).put("enabled", false))) }; list.removeView(holder) } }
            holder.addView(close, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END)); list.addView(holder, LinearLayout.LayoutParams(-1, 0, 1f))
        }
        overlay.addView(Button(activity).apply { text = "Back to conversation"; setOnClickListener { closeViewer() } }, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.START)); (activity.window.decorView as ViewGroup).addView(overlay, ViewGroup.LayoutParams(-1, -1)); viewer = overlay; call.resolve()
    }
    private fun closeViewer() { renderers.forEach { (surface, detach) -> detach(); surface.release() }; renderers.clear(); viewer?.let { (it.parent as? ViewGroup)?.removeView(it) }; viewer = null }
    private val meter = object : Runnable {
        override fun run() {
            if (factory == null) return
            val now = android.os.SystemClock.elapsedRealtime(); val adapt = now >= nextAdaptation
            if (adapt) nextAdaptation = now + 5000
            peers.values.forEach { p -> p.pc.getStats { stats ->
                val reports = stats.statsMap.values
                val speaking = reports.any { it.type == "inbound-rtp" && it.members["kind"] == "audio" && ((it.members["audioLevel"] as? Number)?.toDouble() ?: 0.0) > 0.018 }
                val congested = reports.any { it.type == "remote-inbound-rtp" && (((it.members["roundTripTime"] as? Number)?.toDouble() ?: 0.0) > 0.4 || ((it.members["fractionLost"] as? Number)?.toDouble() ?: 0.0) > 0.08) }
                main.post {
                    if (peers[p.id] !== p) return@post
                    speaking(p.id, speaking && !deafened)
                    if (adapt) p.screenSender?.let { sender ->
                        val params = sender.parameters
                        params.encodings.forEach { it.maxBitrateBps = if (congested) minOf(450000, screenBitrate) else screenBitrate; it.maxFramerate = if (congested) minOf(10, screenFps) else screenFps }
                        sender.parameters = params
                    }
                }
            } }
            main.postDelayed(this, 1000)
        }
    }
    @PluginMethod fun getStats(call: PluginCall) = ui(call) { val out = JSONObject().put("screenAudioBytes", screenAudio?.bytes ?: 0L).put("screenAudioPeak", screenAudio?.peak ?: 0); val remaining = peers.size; if (remaining == 0) { call.resolve(JSObject.fromJSONObject(out.put("transport", if (sfu != null) "livekit" else "mesh"))); return@ui }; var received = 0; peers.values.forEach { p -> p.pc.getStats { reports -> main.post { val list = JSONArray(); reports.statsMap.values.forEach { s -> list.put(JSONObject().put("type", s.type).put("timestampUs", s.timestampUs).put("values", JSONObject(s.members))) }; out.put(p.id, list); if (++received == remaining) call.resolve(JSObject.fromJSONObject(out)) } } } }
    @PluginMethod fun leave(call: PluginCall) = ui(call) { release(); call.resolve() }
    fun pulse() { bridge.webView.evaluateJavascript("window.dispatchEvent(new Event('dorham-native-pulse'))", null) }
    fun stopFromSystem() { main.post { release(); emit("error", JSONObject().put("message", "Android stopped the voice service. Rejoin to reconnect.")); emit("voiceStopped", JSONObject()) } }
    private fun release(stopService: Boolean = true) {
        speechPlayer.stop(); soundboardPlayer.stop(); generation++; videoViews.clear(); watched.clear(); streamVolumes.clear(); speakingStates.clear(); closeViewer(); main.removeCallbacks(meter); stopCapture(); peers.values.forEach { it.pc.close(); it.pc.dispose() }; peers.clear(); microphone?.dispose(); microphone = null; audioSource?.dispose(); audioSource = null; factory?.dispose(); factory = null; egl?.release(); egl = null; sfuReady = false; sfu?.disconnect(); sfu?.release(); sfu = null; sfuVideos.clear()
        networkCallback?.let { try { context.getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } catch (_: Exception) {} }; networkCallback = null
        val audio = context.getSystemService(AudioManager::class.java); audio.unregisterAudioDeviceCallback(routesCallback); audioFocus?.let { audio.abandonAudioFocusRequest(it) }; audioFocus = null; if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice() else { audio.stopBluetoothSco(); audio.isBluetoothScoOn = false; audio.isSpeakerphoneOn = previousSpeaker }; if (active === this) audio.mode = previousAudioMode
        if (active === this && stopService) active = null
        if (stopService) VoiceService.instance?.stopFromApp()
    }
    override fun handleOnDestroy() { release(); scope.cancel(); super.handleOnDestroy() }
}
