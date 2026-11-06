package com.dorham.chat
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.os.SystemClock
import android.net.ConnectivityManager
import androidx.core.content.FileProvider
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@CapacitorPlugin(name = "DorhamUpdates")
class DorhamUpdatesPlugin : Plugin() {
 private val origin = "https://dorhamapp.ir"
 private val worker = Executors.newSingleThreadExecutor()
 private val busy = AtomicBoolean(false)
 private val cancelled = AtomicBoolean(false)
 @Volatile private var activeConnection: HttpURLConnection? = null
 @Volatile private var state = "idle"
 @Volatile private var percentage = 0
 private fun installed() = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
 private fun status(next: String, progress: Int = percentage) { state = next; percentage = progress.coerceIn(0, 100); notifyListeners("progress", JSObject().put("state", state).put("progress", percentage)) }
 private fun connection(address: String): HttpURLConnection {
  require(address.startsWith("$origin/downloads/"))
  return (URL(address).openConnection() as HttpURLConnection).apply { instanceFollowRedirects = false; connectTimeout = 15000; readTimeout = 15000; setRequestProperty("Cache-Control", "no-cache"); setRequestProperty("Accept-Encoding", "identity") }
 }
 private fun latest(): JSONObject {
  val conn = connection("$origin/downloads/android.json")
  try {
   require(conn.responseCode == 200)
   val bytes = java.io.ByteArrayOutputStream()
   conn.inputStream.use { input -> val buffer = ByteArray(4096); while (true) { val n = input.read(buffer); if (n < 0) break; require(bytes.size() + n <= 16384); bytes.write(buffer, 0, n) } }
   val manifest = JSONObject(bytes.toString("UTF-8")); val version = manifest.getString("version")
   require(manifest.getInt("schema") == 1 && version.matches(Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")))
   val file = manifest.getJSONObject("android")
   require(file.getString("version") == version && file.getString("appId") == context.packageName)
   require(file.getString("url") == "$origin/downloads/$version/Dorham-$version-Android.apk")
   require(file.getString("sha256").matches(Regex("[a-f0-9]{64}")) && file.getLong("size") in 1024..157286400)
   require(file.getLong("versionCode") in 1..2100000000)
   return file
  } finally { conn.disconnect() }
 }
 private fun folder() = File(context.cacheDir, "updates").apply { mkdirs() }
 private fun candidate(file: JSONObject) = File(folder(), file.getString("sha256") + ".apk")
 private fun verified(apk: File, file: JSONObject): Boolean {
  if (!apk.isFile || apk.length() != file.getLong("size")) return false
  val digest = MessageDigest.getInstance("SHA-256")
  apk.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) } }
  if (digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) } != file.getString("sha256")) return false
  val info = context.packageManager.getPackageArchiveInfo(apk.absolutePath, PackageManager.GET_SIGNING_CERTIFICATES) ?: return false
  val current = installed()
  if (info.packageName != context.packageName || info.longVersionCode != file.getLong("versionCode") || info.versionName != file.getString("version") || info.longVersionCode <= current.longVersionCode) return false
  val previous = current.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet() ?: return false
  return previous.isNotEmpty() && previous == info.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet()
 }
 @PluginMethod fun info(call: PluginCall) { val current = installed(); call.resolve(JSObject().put("version", current.versionName).put("versionCode", current.longVersionCode)) }
 @PluginMethod fun getStatus(call: PluginCall) { call.resolve(JSObject().put("state", state).put("progress", percentage)) }
 @PluginMethod fun check(call: PluginCall) { worker.execute {
  try { val file = latest(); val current = installed(); call.resolve(JSObject().put("current", current.versionName).put("latest", file.getString("version")).put("available", file.getLong("versionCode") > current.longVersionCode)) }
  catch (_: Exception) { call.reject("Update check unavailable. Try again later.") }
 } }
 private fun download(file: JSONObject): File {
  val apk = candidate(file); if (verified(apk, file)) { status("ready", 100); return apk }
  check(DorhamMediaPlugin.active == null) { "Disconnect voice before downloading an update." }
  val partial = File(folder(), file.getString("sha256") + ".partial"); if (partial.length() > file.getLong("size")) partial.delete()
  var offset = partial.length(); val total = file.getLong("size")
  if (offset == total && total > 0) { if (verified(partial, file)) { require(partial.renameTo(apk)); status("ready", 100); return apk }; partial.delete(); offset = 0 }
  val conn = connection(file.getString("url")); activeConnection = conn
  val deadline = SystemClock.elapsedRealtime() + 300000
  try {
   if (offset > 0) conn.setRequestProperty("Range", "bytes=$offset-")
   val code = conn.responseCode
   if (code == 200) { offset = 0; require(conn.contentLengthLong == total) }
   else require(code == 206 && offset > 0 && conn.getHeaderField("Content-Range") == "bytes $offset-${total - 1}/$total" && conn.contentLengthLong == total - offset)
   var received = offset; status("downloading", (received * 100 / total).toInt())
   java.io.FileOutputStream(partial, offset > 0).use { output -> conn.inputStream.use { input ->
    val buffer = ByteArray(65536)
    while (true) {
     check(!cancelled.get() && DorhamMediaPlugin.active == null && SystemClock.elapsedRealtime() < deadline) { "Download paused" }
     val n = input.read(buffer); if (n < 0) break; received += n; require(received <= total); output.write(buffer, 0, n)
     val next = (received * 100 / total).toInt(); if (next != percentage) status("downloading", next)
    }
   } }
   require(received == total); status("verifying", 100)
   if (!verified(partial, file)) { partial.delete(); throw IllegalStateException("Update verification failed") }
   apk.delete(); require(partial.renameTo(apk)); status("ready", 100); return apk
  } finally { conn.disconnect(); activeConnection = null }
 }
 @PluginMethod fun prepare(call: PluginCall) {
  if (call.getBoolean("automatic") == true && context.getSystemService(ConnectivityManager::class.java).isActiveNetworkMetered) { status("waiting-wifi", 0); call.resolve(JSObject().put("state", state)); return }
  if (!busy.compareAndSet(false, true)) { call.resolve(JSObject().put("state", state)); return }
  cancelled.set(false)
  worker.execute { try { val file = latest(); require(file.getLong("versionCode") > installed().longVersionCode); download(file); call.resolve(JSObject().put("state", state)) }
   catch (_: Exception) { status(if (cancelled.get() || DorhamMediaPlugin.active != null) "paused" else "error"); call.reject("The update could not be downloaded. Retry when the connection is ready.") }
   finally { busy.set(false) } }
 }
 @PluginMethod fun cancel(call: PluginCall) { cancelled.set(true); activeConnection?.disconnect(); status("paused"); call.resolve() }
 @PluginMethod fun install(call: PluginCall) {
  if (DorhamMediaPlugin.active != null) { call.reject("Disconnect voice before installing an update."); return }
  if (!context.packageManager.canRequestPackageInstalls()) { activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))); call.reject("Allow Dorham to install updates, then tap Update again."); return }
  if (!busy.compareAndSet(false, true)) { call.reject("An update is already downloading"); return }
  cancelled.set(false)
  worker.execute { try {
   val file = latest(); val apk = download(file)
   require(verified(apk, file)); check(DorhamMediaPlugin.active == null)
   val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
   activity.runOnUiThread { try { check(DorhamMediaPlugin.active == null); activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)); call.resolve(JSObject().put("started", true)) } catch (_: Exception) { call.reject("Could not open the Android installer.") } }
  } catch (_: Exception) { status("error"); call.reject("The update could not be verified or downloaded. Try again later.") } finally { busy.set(false) } }
 }
 override fun handleOnDestroy() { cancelled.set(true); activeConnection?.disconnect(); worker.shutdownNow(); super.handleOnDestroy() }
}
