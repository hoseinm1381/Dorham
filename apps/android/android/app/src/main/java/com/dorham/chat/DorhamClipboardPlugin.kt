package com.dorham.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "DorhamClipboard")
class DorhamClipboardPlugin : Plugin() {
 @PluginMethod fun write(call: PluginCall) {
  val text = call.getString("text")
  if (text == null || text.length > 16000) { call.reject("Invalid message text."); return }
  activity.runOnUiThread {
   try {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("Dorham message", text))
    call.resolve()
   } catch (_: Exception) { call.reject("Could not copy this message.") }
  }
 }
}
