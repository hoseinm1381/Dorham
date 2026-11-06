package com.dorham.chat
import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.getcapacitor.*
import com.getcapacitor.annotation.*
import java.util.UUID
import org.json.JSONArray

@CapacitorPlugin(name = "DorhamNotifications", permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])])
class DorhamNotificationsPlugin : Plugin() {
    companion object { var pendingUrl: String? = null }
    private fun store() = NotificationStore(context)
    @PluginMethod fun info(call: PluginCall) {
        val store = store(); var id = store.prefs.getString("deviceId", null)
        if (id == null) { id = UUID.randomUUID().toString(); store.prefs.edit().putString("deviceId", id).commit() }
        call.resolve(JSObject().put("enabled", store.prefs.getBoolean("enabled", false)).put("configured", store.credential() != null).put("deviceId", id).put("accountId", store.prefs.getString("accountId", null)).put("sessionGeneration", store.prefs.getLong("sessionGeneration", 0)).put("permission", DorhamNotificationService.permitted(context)).put("batteryExempt", context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)).put("connection", DorhamNotificationService.status))
    }
    @PluginMethod fun configure(call: PluginCall) {
        try {
            if (call.getBoolean("enabled") != true) { DorhamNotificationService.reset(context); info(call); return }
            val origin = NotificationPolicy.origin(call.getString("origin") ?: "")
            val credential = call.getString("credential") ?: throw IllegalArgumentException()
            store().save(credential, origin, call.getString("accountId") ?: "", call.getString("language") ?: "en-US", NotificationPolicy.sessionGeneration(call.data.opt("sessionGeneration")))
            DorhamNotificationService.stop(context)
            if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) requestPermissionForAlias("notifications", call, "permissionResult")
            else { DorhamNotificationService.resume(context); info(call) }
        } catch (error: Exception) { call.reject("Notification connection could not be configured.", error) }
    }
    @PermissionCallback private fun permissionResult(call: PluginCall) { DorhamNotificationService.resume(context); info(call) }
    @PluginMethod fun batterySettings(call: PluginCall) {
        try { activity.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))); call.resolve() }
        catch (error: Exception) { call.reject("Battery settings could not be opened.", error) }
    }
    @PluginMethod fun connectionNoticeSettings(call: PluginCall) {
        try { activity.startActivity(Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).putExtra(Settings.EXTRA_CHANNEL_ID, "dorham.connection")); call.resolve() }
        catch (error: Exception) { call.reject("Connection notice settings could not be opened.", error) }
    }
    @PluginMethod fun getChatMutes(call: PluginCall) {
        try { call.resolve(JSObject().put("mutedConversationIds", JSONArray(store().mutedChats(call.getString("origin") ?: "", call.getString("accountId") ?: "").toList()))) }
        catch (error: Exception) { call.reject("Chat notification settings are unavailable.", error) }
    }
    @PluginMethod fun setChatMuted(call: PluginCall) {
        try {
            val origin = NotificationPolicy.origin(call.getString("origin") ?: ""); val account = call.getString("accountId") ?: ""
            val conversation = call.getString("conversationId") ?: ""; val muted = call.getBoolean("muted") ?: throw IllegalArgumentException()
            store().setChatMuted(origin, account, conversation, muted)
            if (muted && store().prefs.getString("origin", "") == origin && store().prefs.getString("accountId", "") == account) context.getSystemService(android.app.NotificationManager::class.java).cancel("conversation:$conversation", 0)
            getChatMutes(call)
        } catch (error: Exception) { call.reject("Chat notification settings could not be saved.", error) }
    }
    @PluginMethod fun consumeLink(call: PluginCall) { val value = pendingUrl; pendingUrl = null; call.resolve(JSObject().put("url", value)) }
    // Compatibility with older assets; only the native receiver creates OS alerts.
    @PluginMethod fun notify(call: PluginCall) { call.resolve() }
}
