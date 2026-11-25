package com.dorham.chat

import android.content.ActivityNotFoundException
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebView
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia
import androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeWebChromeClient

internal class DorhamWebChromeClient(bridge: Bridge) : BridgeWebChromeClient(bridge) {
    private var pendingGallery: ValueCallback<Array<Uri>>? = null
    private val gallery = bridge.activity.registerForActivityResult(PickMultipleVisualMedia(4)) { uris ->
        val callback = pendingGallery
        pendingGallery = null
        callback?.onReceiveValue(uris.filter { it.scheme == "content" }.take(4).toTypedArray().takeIf { it.isNotEmpty() })
    }

    override fun onShowFileChooser(
        webView: WebView,
        callback: ValueCallback<Array<Uri>>,
        params: FileChooserParams,
    ): Boolean {
        val types = params.acceptTypes.flatMap { it.split(',') }.map { it.trim() }.toSet()
        if (params.isCaptureEnabled || params.mode != FileChooserParams.MODE_OPEN_MULTIPLE ||
            types != setOf("image/*", "video/*")) return super.onShowFileChooser(webView, callback, params)

        pendingGallery?.onReceiveValue(null)
        pendingGallery = callback
        return try {
            gallery.launch(PickVisualMediaRequest(PickVisualMedia.ImageAndVideo))
            true
        } catch (_: ActivityNotFoundException) {
            pendingGallery = null
            super.onShowFileChooser(webView, callback, params)
        }
    }
}
