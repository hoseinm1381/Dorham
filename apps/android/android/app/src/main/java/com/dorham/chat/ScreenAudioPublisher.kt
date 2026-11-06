package com.dorham.chat

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.os.Process
import io.livekit.android.AudioOptions
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.audio.AudioHandler
import io.livekit.android.room.Room
import io.livekit.android.room.participant.AudioTrackPublishOptions
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.Track
import livekit.org.webrtc.audio.JavaAudioDeviceModule
import org.json.JSONObject

/** A separate, publish-only audio engine preserves microphone and stream independence. */
internal class ScreenAudioPublisher(private val context: Context) {
    private var room: Room? = null
    private var recorder: AudioRecord? = null
    private var module: JavaAudioDeviceModule? = null
    @Volatile private var stopped = false
    @Volatile var bytes = 0L; private set
    @Volatile var peak = 0; private set
    suspend fun start(projection: MediaProjection, credentials: JSONObject, bitrate: Int) {
        check(!stopped)
        val config = AudioPlaybackCaptureConfiguration.Builder(projection).addMatchingUsage(AudioAttributes.USAGE_MEDIA).addMatchingUsage(AudioAttributes.USAGE_GAME).addMatchingUsage(AudioAttributes.USAGE_UNKNOWN).excludeUid(Process.myUid()).build()
        val format = AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build()
        val size = maxOf(AudioRecord.getMinBufferSize(48000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT) * 2, 19200)
        val record = AudioRecord.Builder().setAudioFormat(format).setBufferSizeInBytes(size).setAudioPlaybackCaptureConfig(config).build()
        recorder = record; record.startRecording(); check(record.recordingState == AudioRecord.RECORDSTATE_RECORDING)
        val adm = JavaAudioDeviceModule.builder(context).setSampleRate(48000).setUseHardwareAcousticEchoCanceler(false).setUseHardwareNoiseSuppressor(false).setAudioBufferCallback { buffer, encoding, channels, rate, count, _ ->
            val length = minOf(count, buffer.capacity())
            // Always erase the original input. A short read must publish silence, never old PCM or microphone input.
            AndroidMediaPolicy.eraseInput(buffer, length)
            if (!stopped && encoding == AudioFormat.ENCODING_PCM_16BIT && channels == 1 && rate == 48000) {
                buffer.position(0)
                val read = try { record.read(buffer, length, AudioRecord.READ_NON_BLOCKING) } catch (_: Exception) { -1 }
                if (read > 0) { bytes += read; var maximum = 0; for (index in 0 until read / 2) { val sample = (buffer.get(index * 2).toInt() and 255) or (buffer.get(index * 2 + 1).toInt() shl 8); maximum = maxOf(maximum, kotlin.math.abs(sample.toShort().toInt())) }; peak = maxOf(peak, maximum) }
            }
            buffer.position(0); 0L
        }.createAudioDeviceModule()
        module = adm
        // The auxiliary engine has no physical microphone input and never subscribes to call audio.
        adm.setAudioRecordEnabled(false)
        val live = LiveKit.create(context, overrides = LiveKitOverrides(audioOptions = AudioOptions(audioDeviceModule = adm, audioHandler = object : AudioHandler { override fun start() {}; override fun stop() {} }, disableCommunicationModeWorkaround = true, disableAudioPrewarming = true)))
        room = live
        live.connect(credentials.getString("url"), credentials.getString("token"), ConnectOptions(autoSubscribe = false))
        check(!stopped)
        val track = live.localParticipant.createAudioTrack("Phone sound", LocalAudioTrackOptions(noiseSuppression = false, echoCancellation = false, autoGainControl = false, highPassFilter = false))
        check(live.localParticipant.publishAudioTrack(track, AudioTrackPublishOptions(source = Track.Source.SCREEN_SHARE_AUDIO, audioBitrate = bitrate.coerceIn(16000, 48000), dtx = false))) { "Phone sound could not be published" }
        check(!stopped)
    }
    fun close() {
        if (stopped) return
        stopped = true
        room?.disconnect(); room?.release(); room = null
        try { recorder?.stop() } catch (_: Exception) {}; recorder?.release(); recorder = null
        module?.release(); module = null
    }
}
