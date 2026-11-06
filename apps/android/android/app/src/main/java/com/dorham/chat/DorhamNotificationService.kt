package com.dorham.chat
import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

class DorhamNotificationService : Service() {
    companion object {
        @Volatile var appVisible = false
        @Volatile var status = "stopped"
        fun resume(context: Context) {
            val store = NotificationStore(context)
            if (!store.prefs.getBoolean("enabled", false) || store.credential() == null || !permitted(context)) return
            try { context.startForegroundService(Intent(context, DorhamNotificationService::class.java)) }
            catch (_: IllegalStateException) { status = "open-app" }
            catch (_: SecurityException) { status = "permission" }
        }
        fun permitted(context: Context) = context.getSystemService(NotificationManager::class.java).areNotificationsEnabled() && (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
        fun reset(context: Context) { NotificationStore(context).clear(); stop(context) }
        fun stop(context: Context) {
            context.stopService(Intent(context, DorhamNotificationService::class.java))
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.activeNotifications.filter { it.notification.channelId == "dorham.messages" }.forEach { manager.cancel(it.tag, it.id) }
        }
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val networkWake = Channel<Unit>(Channel.CONFLATED)
    private var job: Job? = null
    @Volatile private var connection: HttpURLConnection? = null
    private lateinit var store: NotificationStore
    private var registered = false
    private val network = object : ConnectivityManager.NetworkCallback() { override fun onAvailable(network: Network) { networkWake.trySend(Unit) } }
    private fun fa() = store.prefs.getString("language", "en-US")!!.startsWith("fa")
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() { super.onCreate(); store = NotificationStore(this); getSystemService(NotificationManager::class.java).activeNotifications.filter { it.tag?.startsWith("message:") == true }.forEach { getSystemService(NotificationManager::class.java).cancel(it.tag, it.id) } }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "stop-alerts") { reset(this); stopSelf(); return START_NOT_STICKY }
        if (intent?.action == "mute-chat") {
            val conversation = intent.getStringExtra("conversationId") ?: ""
            val origin = store.prefs.getString("origin", "")!!; val account = store.prefs.getString("accountId", "")!!
            if (NotificationPolicy.identifier(conversation) && account.isNotEmpty() && intent.getStringExtra("accountId") == account && intent.getStringExtra("origin") == origin) {
                store.setChatMuted(origin, account, conversation, true)
                getSystemService(NotificationManager::class.java).cancel("conversation:$conversation", 0)
            }
        }
        if (!store.prefs.getBoolean("enabled", false) || store.credential() == null || !permitted(this)) { stopSelf(); return START_NOT_STICKY }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("dorham.connection", if (fa()) "اتصال اعلان‌ها" else "Notification connection", NotificationManager.IMPORTANCE_LOW))
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(8042, connectionNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(8042, connectionNotification())
        } catch (_: Exception) { status = "permission"; stopSelf(); return START_NOT_STICKY }
        if (job?.isActive != true) {
            try { getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(network); registered = true } catch (_: Exception) { }
            job = scope.launch { receive() }
        }
        return START_STICKY
    }
    private fun connectionNotification(): Notification {
        val open = PendingIntent.getActivity(this, 8042, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 8043, Intent(this, DorhamNotificationService::class.java).setAction("stop-alerts"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val hide = PendingIntent.getActivity(this, 8044, Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName).putExtra(Settings.EXTRA_CHANNEL_ID, "dorham.connection"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val text = if (status == "connected") { if (fa()) "دریافت پیام‌ها و اشاره‌ها در پس‌زمینه" else "Listening for messages and mentions" } else { if (fa()) "در انتظار اتصال به سرور دورهم" else "Waiting for the Dorham server connection" }
        return Notification.Builder(this, "dorham.connection").setSmallIcon(android.R.drawable.ic_dialog_email).setContentTitle("Dorham").setContentText(text).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).addAction(Notification.Action.Builder(null, if (fa()) "پنهان کردن اعلان اتصال" else "Hide connection notice", hide).build()).addAction(Notification.Action.Builder(null, if (fa()) "توقف اعلان‌ها" else "Stop alerts", stop).build()).build()
    }
    private fun state(value: String) {
        if (status == value) return
        status = value
        if (store.prefs.getBoolean("enabled", false) && permitted(this)) getSystemService(NotificationManager::class.java).notify(8042, connectionNotification())
    }
    private fun exchange(origin: String, credential: String, body: JSONObject): JSONObject {
        val conn = URL(origin + "/api/v1/notifications/poll").openConnection() as HttpURLConnection
        connection = conn
        try {
            conn.instanceFollowRedirects = false; conn.connectTimeout = 15000; conn.readTimeout = 70000
            conn.requestMethod = "POST"; conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json"); conn.setRequestProperty("Authorization", "Bearer $credential")
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            if (conn.responseCode == 401 || conn.responseCode == 403) throw CredentialExpired()
            require(conn.responseCode == 200)
            val output = ByteArrayOutputStream()
            conn.inputStream.use { input -> val buffer = ByteArray(4096); while (true) { val size = input.read(buffer); if (size < 0) break; require(output.size() + size <= 65536); output.write(buffer, 0, size) } }
            return JSONObject(output.toString("UTF-8"))
        } finally { conn.disconnect(); if (connection === conn) connection = null }
    }
    private class CredentialExpired : Exception()
    private suspend fun receive() {
        val session = synchronized(NotificationStore.guard) {
            store.credential()?.let { it to store.prefs.getString("protectedCredential", null) }
        } ?: run { stopSelf(); return }
        val credential = session.first
        fun current() = store.prefs.getString("protectedCredential", null) == session.second
        val origin = try { NotificationPolicy.origin(store.prefs.getString("origin", "")!!) } catch (_: Exception) { stopSelf(); return }
        var failures = 0; var ack = emptyList<String>(); var connected = false
        while (currentCoroutineContext().isActive && store.prefs.getBoolean("enabled", false) && current()) {
            if (!permitted(this)) { status = "permission"; stopSelf(); return }
            try {
                state(if (connected) "connected" else "connecting")
                val response = exchange(origin, credential, JSONObject().put("ack", JSONArray(ack)).put("waitSeconds", if (connected) 55 else 0))
                currentCoroutineContext().ensureActive()
                if (!current()) return
                ack = emptyList(); connected = true; state("connected"); failures = 0
                val items = response.getJSONArray("items"); require(items.length() <= 64)
                val received = mutableListOf<String>()
                val wake = if (items.length() > 0) getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Dorham:notificationDelivery").apply { acquire(10000) } else null
                try {
                for (index in 0 until items.length()) {
                    currentCoroutineContext().ensureActive()
                    val item = items.getJSONObject(index); val id = item.getString("id"); val conversation = item.getString("conversationId")
                    require(NotificationPolicy.identifier(id) && NotificationPolicy.identifier(conversation))
                    if (!current() || !store.prefs.getBoolean("enabled", false)) return
                    if (id !in store.handled()) {
                        if (!appVisible && permitted(this)) synchronized(NotificationStore.guard) {
                            if (store.reserveChatAlert(conversation, System.currentTimeMillis())) showMessage(conversation, origin)
                        }
                        store.remember(id)
                    }
                    received.add(id)
                }
                } finally { if (wake?.isHeld == true) wake.release() }
                ack = received
            } catch (expired: CredentialExpired) {
                synchronized(NotificationStore.guard) {
                    if (current()) { store.clear(false); status = "sign-in"; stopSelf() }
                }
                return
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                currentCoroutineContext().ensureActive(); state("reconnecting")
                val pause = NotificationPolicy.retryMillis(failures++) + kotlin.random.Random.nextLong(0, 1000)
                withTimeoutOrNull(pause) { networkWake.receive() }
            }
        }
    }
    private fun showMessage(conversation: String, origin: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("dorham.messages", if (fa()) "پیام‌ها و اشاره‌ها" else "Messages and mentions", NotificationManager.IMPORTANCE_DEFAULT))
        val intent = Intent(this, MainActivity::class.java).setData(Uri.parse("$origin/?conversation=$conversation"))
        val open = PendingIntent.getActivity(this, conversation.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val account = store.prefs.getString("accountId", "")!!
        val mute = PendingIntent.getService(this, conversation.hashCode(), Intent(this, DorhamNotificationService::class.java).setAction("mute-chat").setData(Uri.parse("dorham://mute/$account/$conversation")).putExtra("conversationId", conversation).putExtra("origin", origin).putExtra("accountId", account), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        manager.notify("conversation:$conversation", 0, Notification.Builder(this, "dorham.messages").setSmallIcon(android.R.drawable.ic_dialog_email).setContentTitle("Dorham").setContentText(if (fa()) "پیام جدید در دورهم" else "New message in Dorham").setVisibility(Notification.VISIBILITY_PRIVATE).setContentIntent(open).setAutoCancel(true).addAction(Notification.Action.Builder(null, if (fa()) "بی‌صدا کردن این گفتگو" else "Mute this chat", mute).build()).build())
    }
    override fun onDestroy() {
        job?.cancel(); connection?.disconnect(); scope.cancel()
        if (registered) try { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(network) } catch (_: Exception) { }
        if (status !in listOf("sign-in", "permission", "open-app")) status = "stopped"
        stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
    }
}
class DorhamNotificationBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action in listOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)) DorhamNotificationService.resume(context)
    }
}
