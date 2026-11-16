package com.dorham.chat

import android.os.SystemClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI

internal class NativeVoiceKeepalive(private val scope: CoroutineScope) {
    private var job: Job? = null
    private var lastSuccess: Long? = null

    fun alive(): Boolean = job?.isActive == true &&
        lastSuccess?.let { SystemClock.elapsedRealtime() - it < 25_000 } == true

    fun stop() {
        job?.cancel()
        job = null
        lastSuccess = null
    }

    fun start(origin: String, user: String, channel: String, epoch: String, token: String, sharing: () -> Boolean, ended: () -> Unit) {
        stop()
        val server = try { URI(origin) } catch (_: Exception) { return }
        val local = server.host in setOf("localhost", "127.0.0.1", "10.0.2.2")
        if (server.host == null || server.userInfo != null || server.query != null ||
            server.fragment != null || server.path !in listOf("", "/") ||
            (server.scheme != "https" && !(server.scheme == "http" && local))) return
        val endpoint = server.resolve("/api/v1/voice/native-heartbeat").toURL()
        val membership = JSONObject().put("userId", user).put("channelId", channel)
            .put("epoch", epoch).put("token", token)
        job = scope.launch {
            while (isActive) {
                val body = membership.put("sharing", sharing()).toString().toByteArray(Charsets.UTF_8)
                val code = withContext(Dispatchers.IO) {
                    try {
                        val connection = endpoint.openConnection() as HttpURLConnection
                        try {
                            connection.requestMethod = "POST"
                            connection.instanceFollowRedirects = false
                            connection.connectTimeout = 4000
                            connection.readTimeout = 4000
                            connection.doOutput = true
                            connection.setRequestProperty("Content-Type", "application/json")
                            connection.setFixedLengthStreamingMode(body.size)
                            connection.outputStream.use { it.write(body) }
                            connection.responseCode
                        } finally {
                            connection.disconnect()
                        }
                    } catch (_: IOException) {
                        0
                    }
                }
                when (code) {
                    200 -> lastSuccess = SystemClock.elapsedRealtime()
                    401, 403, 409 -> {
                        lastSuccess = null
                        ended()
                        return@launch
                    }
                }
                delay(8000)
            }
        }
    }
}
