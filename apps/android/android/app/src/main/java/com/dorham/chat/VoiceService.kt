package com.dorham.chat

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.Handler
import android.os.Looper

class VoiceService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val pulse = object : Runnable { override fun run() { DorhamMediaPlugin.active?.pulse(); handler.postDelayed(this, 5000) } }
    companion object { var instance: VoiceService? = null; const val CHANNEL = "dorham.voice"; const val ID = 1001 }
    override fun onCreate() {
        super.onCreate(); instance = this
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "Voice conversations", NotificationManager.IMPORTANCE_LOW))
        startForeground(ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        handler.postDelayed(pulse, 5000)
    }
    fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 2, Intent(this, VoiceService::class.java).setAction("STOP"), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL).setContentTitle("Dorham voice is active").setContentText("Tap to return to your conversation").setSmallIcon(android.R.drawable.ic_btn_speak_now).setOngoing(true).setContentIntent(open).addAction(Notification.Action.Builder(null, "Disconnect", stop).build()).build()
    }
    fun projection(active: Boolean) { startForeground(ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or if (active) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION else 0) }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "STOP") { DorhamMediaPlugin.active?.stopFromSystem(); stopSelf() }
        return START_NOT_STICKY
    }
    override fun onTaskRemoved(rootIntent: Intent?) { DorhamMediaPlugin.active?.stopFromSystem(); stopSelf() }
    override fun onDestroy() { handler.removeCallbacks(pulse); if (DorhamMediaPlugin.active != null) DorhamMediaPlugin.active?.stopFromSystem(); instance = null; super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
}
