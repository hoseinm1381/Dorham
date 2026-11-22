package com.dorham.chat

import android.content.ContentValues
import android.os.Environment
import android.provider.MediaStore
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.JSObject
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.Executors

@CapacitorPlugin(name = "DorhamFiles")
class DorhamFilesPlugin : Plugin() {
    private val worker = Executors.newSingleThreadExecutor()
    private var busy = false
    @Volatile private var cancelled = false
    @Volatile private var activeConnection: HttpURLConnection? = null
    @PluginMethod fun cancel(call: PluginCall) { cancelled = true; activeConnection?.disconnect(); call.resolve() }
    private fun progress(value: Int, active: Boolean = true) { notifyListeners("download", JSObject().put("progress", value).put("active", active)) }
    private fun digest(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun cache(scope: String) = File(File(context.cacheDir, "dorham-transfers"), digest(scope))
    private fun trim(cache: File, maximum: Long, keep: File? = null) {
        val ordered = cache.listFiles { file -> file.extension == "part" || file.extension == "ready" }.orEmpty().sortedByDescending { it.lastModified() }
        var total = ordered.sumOf { it.length() }
        for (file in ordered.asReversed()) {
            if (total <= maximum) break
            if (file == keep) continue
            val size = file.length()
            if (file.delete()) { total -= size; File(cache, file.nameWithoutExtension + ".etag").delete() }
        }
    }
    @PluginMethod fun localSize(call: PluginCall) {
        val directory = cache(call.getString("scope").orEmpty())
        call.resolve(JSObject().put("bytes", directory.listFiles { file -> file.extension == "part" || file.extension == "ready" }.orEmpty().sumOf { it.length() }))
    }
    @PluginMethod fun clearLocal(call: PluginCall) {
        val directory = cache(call.getString("scope").orEmpty())
        worker.execute { directory.listFiles().orEmpty().forEach { it.delete() }; call.resolve() }
    }
    @PluginMethod fun trimLocal(call: PluginCall) {
        val directory = cache(call.getString("scope").orEmpty())
        val maximum = call.getDouble("limit")?.toLong()?.coerceIn(0, 524288000) ?: 104857600
        worker.execute { trim(directory, maximum); call.resolve() }
    }
    @PluginMethod fun download(call: PluginCall) {
        synchronized(this) { if (busy) { call.reject("A download is already active"); return }; busy = true }
        cancelled = false; progress(0)
        worker.execute {
            var connection: HttpURLConnection? = null
            var destination: android.net.Uri? = null
            try {
                val url = URI(requireNotNull(call.getString("url"))).toURL()
                require(url.protocol == "https" || (url.protocol == "http" && url.host in listOf("localhost", "127.0.0.1", "10.0.2.2"))) { "HTTPS is required" }
                require(url.userInfo == null && url.path.matches(Regex("/api/v1/attachments/[0-9a-fA-F-]{36}/download")) && url.query == null) { "Invalid download address" }
                val name = requireNotNull(call.getString("name")); require(name.length in 1..180 && name.none { it.code < 32 || it == '/' || it == '\\' }) { "Invalid download name" }
                val scope = requireNotNull(call.getString("scope")); require(scope.isNotBlank() && scope.length <= 512)
                val directory = cache(scope); directory.mkdirs()
                val key = digest(url.toExternalForm())
                val part = File(directory, "$key.part"); val ready = File(directory, "$key.ready"); val validator = File(directory, "$key.etag")
                val maximum = call.getDouble("limit")?.toLong()?.coerceIn(0, 524288000) ?: 104857600
                if (!ready.isFile) {
                    connection = url.openConnection() as HttpURLConnection
                    activeConnection = connection
                    connection.instanceFollowRedirects = false; connection.connectTimeout = 15000; connection.readTimeout = 30000
                    connection.setRequestProperty("Authorization", "Bearer ${requireNotNull(call.getString("accessToken"))}")
                    val tag = if (validator.isFile) validator.readText() else ""
                    val offset = if (tag.isBlank()) 0L else part.length()
                    if (offset > 0) { connection.setRequestProperty("Range", "bytes=$offset-"); connection.setRequestProperty("If-Range", tag) }
                    val code = connection.responseCode
                    if (code in listOf(403, 404, 410, 416)) { part.delete(); validator.delete() }
                    require(code == 200 || code == 206 && offset > 0 && connection.getHeaderField("Content-Range")?.startsWith("bytes $offset-") == true && connection.getHeaderField("ETag") == tag) { "File is unavailable or access was denied" }
                    val resume = code == 206
                    var received = if (resume) offset else 0L
                    val length = received + connection.contentLengthLong
                    require(length in 1..104857600 && connection.contentLengthLong > 0) { "Invalid file size" }
                    if (!resume) { part.delete(); validator.writeText(connection.getHeaderField("ETag").orEmpty()) }
                    part.setLastModified(System.currentTimeMillis())
                    trim(directory, (maximum - connection.contentLengthLong).coerceAtLeast(0L) + part.length(), part)
                    java.io.FileOutputStream(part, resume).use { output -> connection.inputStream.use { input ->
                        val buffer = ByteArray(65536); var last = -1
                        while (true) { check(!cancelled); val n = input.read(buffer); if (n < 0) break; received += n; require(received <= length) { "File exceeded declared size" }; output.write(buffer, 0, n); val percent = (received * 100 / length).toInt(); if (percent != last) { last = percent; progress(percent) } }
                        require(received == length) { "File download was interrupted" }
                    } }
                    require(part.renameTo(ready)) { "Could not save downloaded file" }
                    validator.delete()
                }
                ready.setLastModified(System.currentTimeMillis())
                val values = ContentValues().apply { put(MediaStore.Downloads.DISPLAY_NAME, name); put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream"); put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Dorham"); put(MediaStore.Downloads.IS_PENDING, 1) }
                val resolver = context.contentResolver
                destination = requireNotNull(resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values))
                resolver.openOutputStream(destination)?.use { output -> ready.inputStream().use { input -> input.copyTo(output) } } ?: throw IllegalStateException("Could not create download")
                resolver.update(destination, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
                trim(directory, maximum)
                call.resolve(JSObject().put("saved", true))
            } catch (_: Exception) {
                destination?.let { context.contentResolver.delete(it, null, null) }
                call.reject("Download paused. Select Download to resume.")
            } finally { progress(100, false); activeConnection = null; connection?.disconnect(); synchronized(this) { busy = false } }
        }
    }
    override fun handleOnDestroy() { cancelled = true; activeConnection?.disconnect(); worker.shutdownNow(); super.handleOnDestroy() }
}
