package com.dorham.chat

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.util.Base64
import java.util.Locale
import androidx.activity.result.ActivityResult
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.JSObject
import com.getcapacitor.annotation.ActivityCallback
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
    private val preferences get() = context.getSharedPreferences("dorham-downloads", 0)
    private fun folderUri() = preferences.getString("folder", null)?.let(Uri::parse)
    private fun result(folder: String?) = JSObject().put("folder", folder ?: org.json.JSONObject.NULL)
    private fun releasePermission(uri: Uri) {
        runCatching { context.contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
    }
    @PluginMethod fun getDownloadFolder(call: PluginCall) = call.resolve(result(preferences.getString("label", null)))
    @PluginMethod fun chooseDownloadFolder(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        startActivityForResult(call, intent, "downloadFolderPicked")
    }
    @ActivityCallback private fun downloadFolderPicked(call: PluginCall, outcome: ActivityResult) {
        val data = outcome.data
        val chosen = data?.data
        if (outcome.resultCode != Activity.RESULT_OK || chosen == null) { call.resolve(result(null)); return }
        try {
            val mask = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            require(data.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0)
            context.contentResolver.takePersistableUriPermission(chosen, data.flags and mask)
            val previous = folderUri()
            val document = DocumentsContract.buildDocumentUriUsingTree(chosen, DocumentsContract.getTreeDocumentId(chosen))
            val label = runCatching {
                context.contentResolver.query(document, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
                    ?.use { if (it.moveToFirst()) it.getString(0) else null }
            }.getOrNull() ?: DocumentsContract.getTreeDocumentId(chosen)
            preferences.edit().putString("folder", chosen.toString()).putString("label", label).apply()
            if (previous != null && previous != chosen) releasePermission(previous)
            call.resolve(result(label))
        } catch (_: Exception) { call.reject("Could not access the selected download folder.") }
    }
    @PluginMethod fun resetDownloadFolder(call: PluginCall) {
        val previous = folderUri()
        preferences.edit().clear().apply()
        if (previous != null) releasePermission(previous)
        call.resolve()
    }
    @PluginMethod fun cancel(call: PluginCall) { cancelled = true; activeConnection?.disconnect(); call.resolve() }
    private fun progress(value: Int, active: Boolean = true) { notifyListeners("download", JSObject().put("progress", value).put("active", active)) }
    private fun digest(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun cache(scope: String) = File(File(context.cacheDir, "dorham-transfers"), digest(scope))
    private fun mediaMimeType(name: String) = when (name.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "mp4" -> "video/mp4"
        "webm" -> "video/webm"
        else -> null
    }
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
        val gallery = call.getBoolean("gallery", false) == true
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
                val mediaType = mediaMimeType(name)
                require(!gallery || mediaType != null) { "Only photos and videos can be saved to the gallery" }
                val mimeType = mediaType ?: "application/octet-stream"
                val scope = requireNotNull(call.getString("scope")); require(scope.isNotBlank() && scope.length <= 512)
                val directory = cache(scope); directory.mkdirs()
                val key = digest(url.toExternalForm())
                val part = File(directory, "$key.part"); val ready = File(directory, "$key.ready"); val validator = File(directory, "$key.etag")
                val maximum = call.getDouble("limit")?.toLong()?.coerceIn(0, 524288000) ?: 104857600
                val cachedData = call.getString("cachedData")
                if (!ready.isFile && cachedData != null) {
                    val maxCachedBytes = 8 * 1024 * 1024
                    require(cachedData.length <= (maxCachedBytes + 2) / 3 * 4)
                    val bytes = Base64.decode(cachedData, Base64.NO_WRAP)
                    require(bytes.size in 1..maxCachedBytes)
                    check(!cancelled)
                    validator.delete()
                    part.writeBytes(bytes)
                    require(part.renameTo(ready)) { "Could not save cached file" }
                }
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
                check(!cancelled)
                ready.setLastModified(System.currentTimeMillis())
                val resolver = context.contentResolver
                val selected = if (gallery) null else folderUri()
                val target = if (selected != null) {
                    val parent = DocumentsContract.buildDocumentUriUsingTree(selected, DocumentsContract.getTreeDocumentId(selected))
                    DocumentsContract.createDocument(resolver, parent, mimeType, name)
                } else {
                    val (collection, folder) = when {
                        gallery && mimeType.startsWith("image/") -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI to Environment.DIRECTORY_PICTURES
                        gallery -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI to Environment.DIRECTORY_MOVIES
                        else -> MediaStore.Downloads.EXTERNAL_CONTENT_URI to Environment.DIRECTORY_DOWNLOADS
                    }
                    val values = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                        put(MediaStore.MediaColumns.MIME_TYPE, if (gallery) mimeType else "application/octet-stream")
                        put(MediaStore.MediaColumns.RELATIVE_PATH, "$folder/Dorham")
                        put(MediaStore.MediaColumns.IS_PENDING, 1)
                    }
                    resolver.insert(collection, values)
                } ?: throw IllegalStateException("Could not create download")
                destination = target
                resolver.openOutputStream(target)?.use { output ->
                    ready.inputStream().use { input ->
                        val buffer = ByteArray(65536)
                        while (true) {
                            check(!cancelled)
                            val count = input.read(buffer)
                            if (count < 0) break
                            output.write(buffer, 0, count)
                        }
                    }
                }
                    ?: throw IllegalStateException("Could not write download")
                check(!cancelled)
                if (selected == null) {
                    val published = resolver.update(target, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                    check(published == 1) { "Could not publish download" }
                }
                trim(directory, maximum)
                call.resolve(JSObject().put("saved", true))
            } catch (error: Exception) {
                destination?.let { uri -> runCatching {
                    if (DocumentsContract.isDocumentUri(context, uri)) DocumentsContract.deleteDocument(context.contentResolver, uri)
                    else context.contentResolver.delete(uri, null, null)
                } }
                call.reject(when {
                    gallery && !cancelled -> "Could not save to gallery. Try again."
                    error is SecurityException -> "Allow access to the saved download folder or change it in Storage & Downloads."
                    else -> "Download paused. Select Download to resume."
                })
            } finally { progress(100, false); activeConnection = null; connection?.disconnect(); synchronized(this) { busy = false } }
        }
    }
    override fun handleOnDestroy() { cancelled = true; activeConnection?.disconnect(); worker.shutdownNow(); super.handleOnDestroy() }
}
