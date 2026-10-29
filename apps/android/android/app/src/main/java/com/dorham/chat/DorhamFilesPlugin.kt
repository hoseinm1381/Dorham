package com.dorham.chat

import android.content.ContentValues
import android.os.Environment
import android.provider.MediaStore
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.JSObject
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.HttpURLConnection
import java.net.URI
import java.util.concurrent.Executors

@CapacitorPlugin(name = "DorhamFiles")
class DorhamFilesPlugin : Plugin() {
    private val worker = Executors.newSingleThreadExecutor()
    private var busy = false
    @PluginMethod fun download(call: PluginCall) {
        synchronized(this) { if (busy) { call.reject("A download is already active"); return }; busy = true }
        worker.execute {
            var connection: HttpURLConnection? = null
            var destination: android.net.Uri? = null
            try {
                val url = URI(requireNotNull(call.getString("url"))).toURL()
                require(url.protocol == "https" || (url.protocol == "http" && url.host in listOf("localhost", "127.0.0.1", "10.0.2.2"))) { "HTTPS is required" }
                require(url.userInfo == null && url.path.matches(Regex("/api/v1/attachments/[0-9a-fA-F-]{36}/download")) && url.query == null) { "Invalid download address" }
                val name = requireNotNull(call.getString("name")); require(name.length in 1..180 && name.none { it.code < 32 || it == '/' || it == '\\' }) { "Invalid download name" }
                connection = url.openConnection() as HttpURLConnection
                connection.instanceFollowRedirects = false; connection.connectTimeout = 15000; connection.readTimeout = 30000
                connection.setRequestProperty("Authorization", "Bearer ${requireNotNull(call.getString("accessToken"))}")
                require(connection.responseCode == 200) { "File is unavailable or access was denied" }
                val length = connection.contentLengthLong
                require(length in 1..104857600) { "Invalid file size" }
                val values = ContentValues().apply { put(MediaStore.Downloads.DISPLAY_NAME, name); put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream"); put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Dorham"); put(MediaStore.Downloads.IS_PENDING, 1) }
                val resolver = context.contentResolver
                destination = requireNotNull(resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values))
                resolver.openOutputStream(destination)?.use { output -> connection.inputStream.use { input ->
                    val buffer = ByteArray(65536); var received = 0L
                    while (true) { val n = input.read(buffer); if (n < 0) break; received += n; require(received <= length) { "File exceeded declared size" }; output.write(buffer, 0, n) }
                    require(received == length) { "File download was interrupted" }
                } } ?: throw IllegalStateException("Could not create download")
                resolver.update(destination, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
                call.resolve(JSObject().put("saved", true))
            } catch (_: Exception) {
                destination?.let { context.contentResolver.delete(it, null, null) }
                call.reject("The file could not be downloaded. Check the connection and access permissions.")
            } finally { connection?.disconnect(); synchronized(this) { busy = false } }
        }
    }
    override fun handleOnDestroy() { worker.shutdownNow(); super.handleOnDestroy() }
}
