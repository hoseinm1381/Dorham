package com.dorham.chat

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.util.Base64
import com.getcapacitor.PluginCall
import java.io.File
import java.util.UUID

internal class NativeSpeechPlayer(private val context: Context) {
    private var player: MediaPlayer? = null
    private var pending: PluginCall? = null
    private var file: File? = null
    fun play(call: PluginCall) {
        stop()
        val encoded = requireNotNull(call.getString("wav")); require(encoded.length <= 6 * 1024 * 1024)
        val bytes = Base64.decode(encoded, Base64.DEFAULT); require(bytes.size in 44..4 * 1024 * 1024 && String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF" && String(bytes, 8, 4, Charsets.US_ASCII) == "WAVE") { "Unsupported speech audio" }
        val temporary = File(context.cacheDir, "speech-" + UUID.randomUUID() + ".wav"); temporary.writeBytes(bytes); file = temporary
        val media = MediaPlayer(); player = media; pending = call
        media.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        media.setDataSource(temporary.absolutePath)
        val gain = (call.getDouble("volume") ?: 1.0).coerceIn(0.0, 1.0).toFloat(); media.setVolume(gain, gain)
        media.setOnCompletionListener { if (player === media) stop() }
        media.setOnErrorListener { _, _, _ -> if (player === media) stop(); true }
        media.setOnPreparedListener { if (player === media) media.start() }
        media.prepareAsync()
    }
    fun stop() { val previous = pending; pending = null; player?.release(); player = null; file?.delete(); file = null; previous?.resolve() }
}
