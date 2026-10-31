package com.dorham.chat
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

@CapacitorPlugin(name = "DorhamUpdates")
class DorhamUpdatesPlugin : Plugin() {
 private val origin = "https://dorhamapp.ir"
 private val worker = Executors.newSingleThreadExecutor()
 @Volatile private var busy = false
 private fun installed() = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
 private fun connection(address: String): HttpURLConnection {
  require(address.startsWith("$origin/downloads/"))
  return (URL(address).openConnection() as HttpURLConnection).apply { instanceFollowRedirects = false; connectTimeout = 15000; readTimeout = 30000; setRequestProperty("Cache-Control", "no-cache") }
 }
 private fun latest(): JSONObject {
  val conn = connection("$origin/downloads/latest.json")
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
 @PluginMethod fun info(call: PluginCall) { val current = installed(); call.resolve(JSObject().put("version", current.versionName).put("versionCode", current.longVersionCode)) }
 @PluginMethod fun check(call: PluginCall) { worker.execute {
  try { val file = latest(); val current = installed(); call.resolve(JSObject().put("current", current.versionName).put("latest", file.getString("version")).put("available", file.getLong("versionCode") > current.longVersionCode)) }
  catch (_: Exception) { call.reject("Update check unavailable. Try again later.") }
 } }
 @PluginMethod fun install(call: PluginCall) {
  synchronized(this) { if (busy) { call.reject("An update is already downloading"); return }; busy = true }
  if (!context.packageManager.canRequestPackageInstalls()) {
   busy = false
   activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
   call.reject("Allow Dorham to install updates, then tap Update again."); return
  }
  worker.execute {
   var conn: HttpURLConnection? = null; var partial: File? = null
   try {
    val file = latest(); val current = installed(); require(file.getLong("versionCode") > current.longVersionCode)
    val folder = File(context.cacheDir, "updates").apply { mkdirs() }; val temporary = File(folder, "update.apk.download"); partial = temporary; temporary.delete()
    val apk = File(folder, "update.apk"); val download = connection(file.getString("url")); conn = download
    require(download.responseCode == 200 && download.contentLengthLong == file.getLong("size"))
    val digest = MessageDigest.getInstance("SHA-256"); var received = 0L
    temporary.outputStream().use { output -> download.inputStream.use { input -> val buffer = ByteArray(65536)
     while (true) { val n = input.read(buffer); if (n < 0) break; received += n; require(received <= file.getLong("size")); digest.update(buffer, 0, n); output.write(buffer, 0, n) }
    } }
    require(received == file.getLong("size") && digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) } == file.getString("sha256"))
    val candidate = requireNotNull(context.packageManager.getPackageArchiveInfo(temporary.absolutePath, PackageManager.GET_SIGNING_CERTIFICATES))
    require(candidate.packageName == context.packageName && candidate.longVersionCode == file.getLong("versionCode") && candidate.versionName == file.getString("version"))
    val previous = requireNotNull(current.signingInfo).apkContentsSigners.map { it.toCharsString() }.toSet()
    require(previous.isNotEmpty() && previous == requireNotNull(candidate.signingInfo).apkContentsSigners.map { it.toCharsString() }.toSet())
    apk.delete(); require(temporary.renameTo(apk))
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
    activity.runOnUiThread { try {
     activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
     call.resolve(JSObject().put("started", true))
    } catch (_: Exception) { call.reject("Could not open the Android installer.") } }
   } catch (_: Exception) { call.reject("The update could not be verified or downloaded. Try again later.") }
   finally { conn?.disconnect(); partial?.delete(); busy = false }
  }
 }
 override fun handleOnDestroy() { worker.shutdownNow(); super.handleOnDestroy() }
}
