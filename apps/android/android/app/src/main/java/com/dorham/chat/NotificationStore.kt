package com.dorham.chat
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import org.json.JSONObject
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
internal class NotificationStore(context: Context) {
    companion object { val guard = Any() }
    val prefs = context.getSharedPreferences("dorham.notifications", 0)
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("dorham.notifications.v1", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("dorham.notifications.v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized fun credential(): String? {
        val encoded = prefs.getString("protectedCredential", null) ?: return null
        return try {
            val bytes = Base64.decode(encoded, Base64.NO_WRAP); require(bytes.size > 28)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
            String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
        } catch (_: Exception) { prefs.edit().remove("protectedCredential").commit(); null }
    }
    fun save(credential: String, origin: String, account: String, language: String, generation: Long) = synchronized(guard) {
        require(generation == prefs.getLong("sessionGeneration", 0))
        require(credential.length in 32..128 && NotificationPolicy.identifier(account))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encoded = Base64.encodeToString(cipher.iv + cipher.doFinal(credential.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        require(prefs.edit().putString("protectedCredential", encoded).putString("origin", NotificationPolicy.origin(origin)).putString("accountId", account).putString("language", language).putBoolean("enabled", true).commit())
    }
    fun clear(disable: Boolean = true) = synchronized(guard) {
        val edit = prefs.edit().remove("protectedCredential").remove("accountId").remove("handled")
        if (disable) edit.putBoolean("enabled", false).putLong("sessionGeneration", prefs.getLong("sessionGeneration", 0) + 1)
        edit.commit()
    }
    fun handled(): List<String> = prefs.getString("handled", "")!!.split(',').filter { it.isNotEmpty() }
    fun remember(id: String) { require(prefs.edit().putString("handled", NotificationPolicy.remember(handled(), id).joinToString(",")).commit()) }
    private fun chatScope(origin: String, account: String): String {
        require(NotificationPolicy.identifier(account))
        return MessageDigest.getInstance("SHA-256").digest((NotificationPolicy.origin(origin) + "\u0000" + account).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
    }
    fun mutedChats(origin: String, account: String): Set<String> = prefs.getStringSet("mutedChats.${chatScope(origin, account)}", emptySet())!!.toSet()
    fun setChatMuted(origin: String, account: String, conversation: String, muted: Boolean) = synchronized(guard) {
        require(NotificationPolicy.identifier(conversation))
        val chats = mutedChats(origin, account).toMutableSet()
        if (muted) chats.add(conversation) else chats.remove(conversation)
        require(chats.size <= 4096)
        require(prefs.edit().putStringSet("mutedChats.${chatScope(origin, account)}", chats).commit())
    }
    fun reserveChatAlert(conversation: String, now: Long): Boolean = synchronized(guard) {
        val origin = prefs.getString("origin", "")!!; val account = prefs.getString("accountId", "")!!
        val key = "chatAlertTimes.${chatScope(origin, account)}"
        val times = try { JSONObject(prefs.getString(key, "{}")!!) } catch (_: Exception) { JSONObject() }
        val previous = times.keys().asSequence().associateWith { times.optLong(it) }
        if (!NotificationPolicy.shouldAlert(conversation, mutedChats(origin, account), previous, now)) return@synchronized false
        val recent = JSONObject()
        for (id in times.keys()) { val at = times.optLong(id); if (at <= now && now - at < NotificationPolicy.ALERT_GAP_MILLIS) recent.put(id, at) }
        if (recent.length() >= 4096) return@synchronized false
        recent.put(conversation, now)
        require(prefs.edit().putString(key, recent.toString()).commit())
        true
    }
}
