package com.dorham.chat

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@CapacitorPlugin(name = "DorhamSecrets")
class DorhamSecretsPlugin : Plugin() {
    private val alias = "dorham.refresh.v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @PluginMethod fun get(call: PluginCall) {
        try {
            val prefs = context.getSharedPreferences("dorham.secrets", 0)
            val ciphertext = prefs.getString("value", null)
            if (ciphertext == null) { call.resolve(JSObject().put("value", org.json.JSONObject.NULL)); return }
            val bytes = Base64.decode(ciphertext, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
            call.resolve(JSObject().put("value", String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)))
        } catch (_: Exception) { context.getSharedPreferences("dorham.secrets", 0).edit().clear().apply(); call.resolve(JSObject().put("value", org.json.JSONObject.NULL)) }
    }
    @PluginMethod fun set(call: PluginCall) {
        try {
            val prefs = context.getSharedPreferences("dorham.secrets", 0)
            val value = call.getString("value")
            if (value == null) prefs.edit().remove("value").commit()
            else {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
                val bytes = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
                prefs.edit().putString("value", Base64.encodeToString(bytes, Base64.NO_WRAP)).commit()
            }
            call.resolve()
        } catch (e: Exception) { call.reject("Protected storage is unavailable", e) }
    }
}
