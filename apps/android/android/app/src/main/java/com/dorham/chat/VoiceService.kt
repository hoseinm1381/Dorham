package com.dorham.chat

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock

class VoiceService : Service() {
    private var microphoneActive = false
    private var projectionActive = false
    private var appStopping = false
    private var muted = false
    private var language = "en-US"
    private var name = "Dorham"
    private val handler = Handler(Looper.getMainLooper())
    private val delayedStop = Runnable { if (appStopping) stopSelf() }
    private var wakeLock: PowerManager.WakeLock? = null
    private var nextWakeRenewal = 0L
    private fun renewCallWakeLock() { if (!appStopping && SystemClock.elapsedRealtime() >= nextWakeRenewal) { wakeLock?.acquire(120000); nextWakeRenewal = SystemClock.elapsedRealtime() + 60000 } }
    private val pulse = object : Runnable { override fun run() { renewCallWakeLock(); DorhamMediaPlugin.active?.pulse(); handler.postDelayed(this, 5000) } }
    companion object { var instance: VoiceService? = null; const val CHANNEL = "dorham.voice"; const val ID = 1001 }
    private fun text(en: String, fa: String) = if (language.startsWith("fa")) fa else en
    override fun onCreate() {
        super.onCreate(); instance = this
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "Dorham", NotificationManager.IMPORTANCE_LOW))
        startForeground(ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Dorham:VoiceCall").apply { setReferenceCounted(false) }
        renewCallWakeLock()
        handler.postDelayed(pulse, 5000)
    }
    private fun action(action: String, label: String): Notification.Action {
        val intent = PendingIntent.getService(this, action.hashCode(), Intent(this, VoiceService::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Action.Builder(null, label, intent).build()
    }
    fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val builder = Notification.Builder(this, CHANNEL).setContentTitle(name).setContentText(text(if (projectionActive) "Sharing your phone screen" else "Voice conversation is active", if (projectionActive) "صفحهٔ گوشی در حال اشتراک‌گذاری است" else "گفت‌وگوی صوتی فعال است")).setSmallIcon(android.R.drawable.ic_btn_speak_now).setOngoing(true).setContentIntent(open).setVisibility(Notification.VISIBILITY_PRIVATE)
        if (microphoneActive) builder.addAction(action("MUTE", text(if (muted) "Unmute" else "Mute", if (muted) "باز کردن میکروفن" else "بستن میکروفن")))
        if (projectionActive) builder.addAction(action("STOP_SHARE", text("Stop sharing", "توقف اشتراک‌گذاری")))
        builder.addAction(action("STOP", text("Disconnect", "قطع اتصال")))
        return builder.build()
    }
    fun details(locale: String, channel: String, silent: Boolean) { language = locale; name = channel; muted = silent; getSystemService(NotificationManager::class.java).notify(ID, notification()) }
    private fun refreshTypes() {
        val types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK or (if (microphoneActive) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0) or (if (projectionActive) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION else 0)
        startForeground(ID, notification(), types)
    }
    fun microphone(active: Boolean) { microphoneActive = active; refreshTypes() }
    fun projection(active: Boolean) { projectionActive = active; refreshTypes() }
    fun stopFromApp() { appStopping = true; handler.removeCallbacks(delayedStop); handler.postDelayed(delayedStop, 300) }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            "STOP" -> { DorhamMediaPlugin.active?.stopFromSystem(); stopSelf() }
            "STOP_SHARE" -> DorhamMediaPlugin.active?.stopShareFromSystem()
            "MUTE" -> DorhamMediaPlugin.active?.toggleMuteFromSystem()
            else -> { handler.removeCallbacks(delayedStop); appStopping = false; language = intent?.getStringExtra("language") ?: language; name = intent?.getStringExtra("channelName") ?: name; microphone(intent?.getBooleanExtra("microphone", false) == true) }
        }
        return START_NOT_STICKY
    }
    override fun onDestroy() { handler.removeCallbacks(pulse); handler.removeCallbacks(delayedStop); if (wakeLock?.isHeld == true) wakeLock?.release(); wakeLock = null; if (!appStopping) DorhamMediaPlugin.active?.stopFromSystem(); if (instance === this) instance = null; super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
}
