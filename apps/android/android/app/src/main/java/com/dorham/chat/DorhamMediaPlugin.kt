package com.dorham.chat

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioManager
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
    private var screenLease: String? = null
    private var screenBitrate = 1200000
    private var screenFps = 15
    private var screenWidth = 1280
    private var screenHeight = 720
    private var nextAdaptation = 0L
    private var micStream = UUID.randomUUID().toString()
    private var screenStream = UUID.randomUUID().toString()
    private var sfu: Room? = null
    private var viewer: FrameLayout? = null
    private val renderers = mutableListOf<Pair<SurfaceViewRenderer, () -> Unit>>()
    private val volumes = mutableMapOf<String, Double>()
    private val peers = mutableMapOf<String, Peer>()
    private val sfuVideos = mutableMapOf<String, LiveVideoTrack>()
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private data class Peer(val id: String, val epoch: String, val pc: PeerConnection, var makingOffer: Boolean = false, var ignoreOffer: Boolean = false, var metadata: JSONArray = JSONArray(), val pendingIce: MutableList<IceCandidate> = mutableListOf(), var audio: AudioTrack? = null, var video: VideoTrack? = null, var screenSender: RtpSender? = null, var subscribed: Boolean = true)
    private fun emit(name: String, value: JSONObject) = notifyListeners(name, JSObject.fromJSONObject(value))
    private fun error(message: String) = emit("error", JSONObject().put("message", message))
    private fun ui(call: PluginCall, work: () -> Unit) { main.post { try { work() } catch (e: Exception) { call.reject(e.message ?: "Native media failed", e) } } }
    @PluginMethod fun prepare(call: PluginCall) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) requestPermissionForAlias("microphone", call, "microphoneResult") else prepareNotifications(call)
    }
    @PermissionCallback private fun microphoneResult(call: PluginCall) { if (getPermissionState("microphone") == PermissionState.GRANTED) prepareNotifications(call) else call.reject("Microphone permission was denied") }
    private fun prepareNotifications(call: PluginCall) { if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) requestPermissionForAlias("notifications", call, "notificationsResult") else call.resolve() }
    @PermissionCallback private fun notificationsResult(call: PluginCall) { if (getPermissionState("notifications") != PermissionState.GRANTED) error("Notifications were denied. Android may show the active voice service only in its active-app controls."); call.resolve() }
    @PermissionCallback private fun bluetoothResult(call: PluginCall) { if (getPermissionState("bluetooth") == PermissionState.GRANTED) setDevice(call) else call.reject("Bluetooth permission was denied. Select the speaker or earpiece instead.") }
    @PluginMethod fun join(call: PluginCall) = ui(call) {
        release(); active = this; selfId = call.getString("selfId") ?: error("Missing identity").let { "" }; room = call.getObject("room") ?: JSONObject()
        context.startForegroundService(Intent(context, VoiceService::class.java))
        val audioManager = context.getSystemService(AudioManager::class.java); audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        val servers = call.getArray("iceServers") ?: JSArray(); ice = (0 until servers.length()).map { n -> val item = servers.getJSONObject(n); val urls = item.optJSONArray("urls") ?: JSONArray().put(item.optString("urls")); PeerConnection.IceServer.builder((0 until urls.length()).map { urls.getString(it) }).setUsername(item.optString("username")).setPassword(item.optString("credential")).createIceServer() }
        val credentials = call.getObject("credentials")
        if (credentials != null) {
            val live = LiveKit.create(context); sfu = live
            scope.launch {
                try {
                    launch { live.events.collect { event ->
                        when (event) {
                            is RoomEvent.TrackSubscribed -> { val id = event.participant.identity?.value?.substringBefore(":") ?: ""; when (val track = event.track) { is LiveVideoTrack -> { sfuVideos[id] = track; emit("video", JSONObject().put("userId", id)) }; is RemoteAudioTrack -> track.setVolume(if (deafened || selfDeafened()) 0.0 else volumes[id] ?: 1.0) } }
                            is RoomEvent.TrackUnsubscribed -> { val id = event.participant.identity?.value?.substringBefore(":") ?: ""; if (event.track is LiveVideoTrack) sfuVideos.remove(id) }
                            else -> {}
                        }
                    } }
                    live.connect(requireNotNull(credentials.getString("url")), requireNotNull(credentials.getString("token"))); live.localParticipant.setMicrophoneEnabled(!muted && !deafened && !selfMuted() && !selfDeafened()); call.resolve()
                } catch (e: Exception) { release(); call.reject("SFU connection failed: ${e.message}") }
            }
        } else {
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions())
            val shared = EglBase.create(); egl = shared
            val adm = JavaAudioDeviceModule.builder(context).setUseHardwareAcousticEchoCanceler(true).setUseHardwareNoiseSuppressor(true).createAudioDeviceModule()
            factory = PeerConnectionFactory.builder().setAudioDeviceModule(adm).setVideoEncoderFactory(DefaultVideoEncoderFactory(shared.eglBaseContext, true, true)).setVideoDecoderFactory(DefaultVideoDecoderFactory(shared.eglBaseContext)).createPeerConnectionFactory(); adm.release()
            val constraints = MediaConstraints().apply { optional.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true")); optional.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true")); optional.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true")) }
            audioSource = factory!!.createAudioSource(constraints); microphone = factory!!.createAudioTrack(UUID.randomUUID().toString(), audioSource)
            updatePeers(); main.postDelayed(meter, 1000); call.resolve()
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
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) { main.post { val p = peers[peerId] ?: return@post; when (val track = receiver.track()) { is AudioTrack -> { p.audio = track; applyVolume(p) }; is VideoTrack -> { p.video = track; emit("video", JSONObject().put("userId", peerId)) } } } }
    }
    private fun newPeer(userId: String, epoch: String): Peer {
        val config = PeerConnection.RTCConfiguration(ice).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN; continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY }
        val pc = factory!!.createPeerConnection(config, observer(userId)) ?: throw IllegalStateException("Could not create media connection")
        val peer = Peer(userId, epoch, pc); peers[userId] = peer
        microphone?.let { pc.addTrack(it, listOf(micStream)) }; screenTrack?.let { peer.screenSender = pc.addTrack(it, listOf(screenStream)) }; return peer
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
        sfu?.let { live -> scope.launch { live.localParticipant.setMicrophoneEnabled(!muted && !deafened && !selfMuted() && !selfDeafened()); live.remoteParticipants.values.forEach { p -> p.trackPublications.values.forEach { pub -> (pub.track as? RemoteAudioTrack)?.setVolume(if (deafened || selfDeafened()) 0.0 else volumes[p.identity?.value?.substringBefore(":")] ?: 1.0) } } } }
    }
    private fun applyVolume(p: Peer) { val m = members().firstOrNull { it.getJSONObject("user").getString("id") == p.id }; p.audio?.setVolume(if (deafened || selfDeafened() || m?.optBoolean("serverMuted") == true || m?.optBoolean("muted") == true || m?.optBoolean("deafened") == true) 0.0 else volumes[p.id] ?: 1.0) }
    @PluginMethod fun setState(call: PluginCall) = ui(call) { muted = call.getBoolean("muted") ?: false; deafened = call.getBoolean("deafened") ?: false; updatePeers(); sfu?.remoteParticipants?.values?.forEach { p -> p.trackPublications.values.forEach { pub -> (pub.track as? RemoteAudioTrack)?.setVolume(if (deafened || selfDeafened()) 0.0 else volumes[p.identity?.value?.substringBefore(":")] ?: 1.0) } }; call.resolve() }
    @PluginMethod fun setVolume(call: PluginCall) = ui(call) { val id = call.getString("userId")!!; val volume = (call.getDouble("volume") ?: 1.0).coerceIn(0.0, 2.0); volumes[id] = volume; peers[id]?.let { applyVolume(it) }; sfu?.remoteParticipants?.values?.filter { it.identity?.value?.substringBefore(":") == id }?.forEach { p -> p.trackPublications.values.forEach { (it.track as? RemoteAudioTrack)?.setVolume(if (deafened || selfDeafened()) 0.0 else volume) } }; call.resolve() }
    @Suppress("DEPRECATION")
    @PluginMethod fun setDevice(call: PluginCall) = ui(call) {
        val audio = context.getSystemService(AudioManager::class.java); val name = call.getString("deviceId") ?: "speaker"
        if (name == "bluetooth" && Build.VERSION.SDK_INT >= 31 && getPermissionState("bluetooth") != PermissionState.GRANTED) { requestPermissionForAlias("bluetooth", call, "bluetoothResult"); return@ui }
        if (Build.VERSION.SDK_INT >= 31) { val types = when (name) { "bluetooth" -> listOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET); "earpiece" -> listOf(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE); else -> listOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) }; val target = audio.availableCommunicationDevices.firstOrNull { it.type in types } ?: throw IllegalStateException("Selected audio route is unavailable"); if (!audio.setCommunicationDevice(target)) throw IllegalStateException("Could not change audio route") }
        else { audio.isSpeakerphoneOn = name == "speaker"; if (name == "bluetooth") audio.startBluetoothSco() }; call.resolve()
    }
    private fun shareSettings(call: PluginCall) {
        val quality = call.getString("quality") ?: "720p15"
        require(quality in listOf("480p15", "480p30", "720p15", "720p30")) { "Unsupported screen quality" }
        screenWidth = (call.getInt("width") ?: if (quality.startsWith("480")) 854 else 1280).coerceIn(160, 1280)
        screenHeight = (call.getInt("height") ?: if (quality.startsWith("480")) 480 else 720).coerceIn(90, 720)
        screenFps = (call.getInt("fps") ?: if (quality.endsWith("15")) 15 else 30).coerceIn(1, 30)
        screenBitrate = (call.getInt("bitrate") ?: 800000).coerceIn(64000, 1200000)
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
    @PluginMethod fun startShare(call: PluginCall) = ui(call) { if (screenLease != null) { call.resolve(); return@ui }; val manager = context.getSystemService(MediaProjectionManager::class.java); startActivityForResult(call, manager.createScreenCaptureIntent(), "projectionResult") }
    @ActivityCallback private fun projectionResult(call: PluginCall, result: ActivityResult) = ui(call) {
        val data = result.data; if (result.resultCode != Activity.RESULT_OK || data == null) { call.reject("Screen capture was cancelled"); return@ui }
        shareSettings(call); screenLease = call.getString("leaseId"); screenStream = UUID.randomUUID().toString(); VoiceService.instance?.projection(true)
        val live = sfu
        if (live != null) { scope.launch { try { live.localParticipant.setScreenShareEnabled(true, ScreenCaptureParams(data, onStop = { main.post { stopCapture(); emit("captureStopped", JSONObject()) } })); call.resolve() } catch (e: Exception) { stopCapture(); call.reject(e.message) } }; return@ui }
        val shared = egl ?: throw IllegalStateException("Join voice first"); val fac = factory ?: throw IllegalStateException("Join voice first")
        val videoSource = fac.createVideoSource(true); screenSource = videoSource
        val capture = ScreenCapturerAndroid(data, object : MediaProjection.Callback() { override fun onStop() { main.post { stopCapture(); emit("captureStopped", JSONObject()) } } }); capturer = capture
        val helper = SurfaceTextureHelper.create("DorhamScreen", shared.eglBaseContext); texture = helper; capture.initialize(helper, context, videoSource.capturerObserver)
        capture.startCapture(screenWidth, screenHeight, screenFps)
        val track = fac.createVideoTrack(UUID.randomUUID().toString(), videoSource); screenTrack = track
        peers.values.forEach { p -> p.subscribed = true; if (p.screenSender == null) p.screenSender = p.pc.addTrack(track, listOf(screenStream)) else { p.screenSender!!.setStreams(listOf(screenStream)); p.screenSender!!.setTrack(track, false) }; val params = p.screenSender!!.parameters; params.encodings.forEach { it.maxBitrateBps = screenBitrate; it.maxFramerate = screenFps }; p.screenSender!!.parameters = params; signal(p.id, JSONObject()) }
        call.resolve()
    }
    @PluginMethod fun stopShare(call: PluginCall) = ui(call) { stopCapture(); call.resolve() }
    private fun stopCapture() {
        if (screenLease == null && capturer == null) return
        screenLease = null; peers.values.forEach { it.screenSender?.setTrack(null, false) }; screenTrack?.dispose(); screenTrack = null
        val old = capturer; capturer = null; try { old?.stopCapture(); old?.dispose() } catch (_: Exception) {}; screenSource?.dispose(); screenSource = null; texture?.dispose(); texture = null
        sfu?.let { scope.launch { it.localParticipant.setScreenShareEnabled(false) } }; VoiceService.instance?.projection(false)
    }
    @PluginMethod fun subscribe(call: PluginCall) = ui(call) {
        val id = call.getString("userId")!!; val enabled = call.getBoolean("enabled") ?: true; val lease = call.getString("leaseId")!!
        peers[id]?.video?.setEnabled(enabled); signal(id, JSONObject().put("subscription", JSONObject().put("leaseId", lease).put("enabled", enabled)))
        sfu?.remoteParticipants?.values?.filter { it.identity?.value?.substringBefore(":") == id }?.forEach { p -> p.trackPublications.values.filterIsInstance<RemoteTrackPublication>().filter { it.track is LiveVideoTrack }.forEach { it.setSubscribed(enabled) } }; call.resolve()
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
                    emit("speaking", JSONObject().put("userId", p.id).put("speaking", speaking && !deafened))
                    if (adapt) p.screenSender?.let { sender ->
                        val params = sender.parameters
                        params.encodings.forEach { it.maxBitrateBps = if (congested) minOf(450000, screenBitrate) else screenBitrate; it.maxFramerate = if (congested) minOf(10, screenFps) else screenFps }
                        sender.parameters = params
                    }
                }
            } }
            main.postDelayed(this, 250)
        }
    }
    @PluginMethod fun getStats(call: PluginCall) = ui(call) { val out = JSONObject(); val remaining = peers.size; if (remaining == 0) { call.resolve(JSObject().put("transport", if (sfu != null) "livekit" else "mesh")); return@ui }; var received = 0; peers.values.forEach { p -> p.pc.getStats { reports -> main.post { val list = JSONArray(); reports.statsMap.values.forEach { s -> list.put(JSONObject().put("type", s.type).put("timestampUs", s.timestampUs).put("values", JSONObject(s.members))) }; out.put(p.id, list); if (++received == remaining) call.resolve(JSObject.fromJSONObject(out)) } } } }
    @PluginMethod fun leave(call: PluginCall) = ui(call) { release(); call.resolve() }
    fun pulse() { bridge.webView.evaluateJavascript("window.dispatchEvent(new Event('dorham-native-pulse'))", null) }
    fun stopFromSystem() { main.post { release(); emit("error", JSONObject().put("message", "Android stopped the voice service. Rejoin to reconnect.")); emit("voiceStopped", JSONObject()) } }
    private fun release() {
        closeViewer(); main.removeCallbacks(meter); stopCapture(); peers.values.forEach { it.pc.close(); it.pc.dispose() }; peers.clear(); microphone?.dispose(); microphone = null; audioSource?.dispose(); audioSource = null; factory?.dispose(); factory = null; egl?.release(); egl = null; sfu?.disconnect(); sfu?.release(); sfu = null; sfuVideos.clear()
        networkCallback?.let { try { context.getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } catch (_: Exception) {} }; networkCallback = null
        val audio = context.getSystemService(AudioManager::class.java); if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice(); audio.mode = AudioManager.MODE_NORMAL
        context.stopService(Intent(context, VoiceService::class.java)); if (active === this) active = null
    }
    override fun handleOnDestroy() { release(); scope.cancel(); super.handleOnDestroy() }
}
