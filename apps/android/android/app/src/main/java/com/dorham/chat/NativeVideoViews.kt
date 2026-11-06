package com.dorham.chat

import android.app.Activity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.track.VideoTrack as LiveVideoTrack
import livekit.org.webrtc.VideoTrack
import livekit.org.webrtc.VideoSink
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/** Video pixels stay native. The WebView owns controls, accessibility and layout. */
internal class NativeVideoViews(
    private val activity: Activity, private val web: WebView,
    private val initialize: (TextureViewRenderer) -> Unit,
    private val resolve: (String, String, Boolean) -> Any?,
    private val ready: (String, Boolean) -> Unit
) {
    private data class Entry(val id: String, var value: JSONObject, val view: TextureViewRenderer, val holder: FrameLayout, var track: Any? = null, var detach: (() -> Unit)? = null)
    private val entries = mutableMapOf<String, Entry>()
    private var visible = true

    init {
        // Rotation can deliver new WebView bounds after the JavaScript resize.
        web.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            if (left != oldLeft || top != oldTop || right != oldRight || bottom != oldBottom) {
                entries.values.forEach(::place)
            }
        }
    }

    fun update(value: JSONObject) {
        val id = value.getString("id"); require(id.length in 1..80)
        val show = value.optBoolean("visible") && visible
        if (!show) { remove(id); return }
        require(entries.containsKey(id) || entries.size < 4) { "Too many video views" }
        val entry = entries[id] ?: run {
            val view = TextureViewRenderer(activity); initialize(view)
            view.setScalingType(livekit.org.webrtc.RendererCommon.ScalingType.SCALE_ASPECT_FIT)
            view.isClickable = false; view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            val holder = FrameLayout(activity).apply { clipChildren = true; clipToPadding = true; isClickable = false }
            holder.addView(view, FrameLayout.LayoutParams(1, 1))
            (activity.window.decorView as ViewGroup).addView(holder, FrameLayout.LayoutParams(1, 1))
            Entry(id, value, view, holder).also { entries[id] = it }
        }
        entry.value = value
        place(entry)
        bind(entry)
    }

    private fun place(entry: Entry) {
        val value = entry.value
        val density = activity.resources.displayMetrics.density
        val webPosition = IntArray(2); val rootPosition = IntArray(2)
        web.getLocationInWindow(webPosition); activity.window.decorView.getLocationInWindow(rootPosition)
        val fullLeft = (value.optDouble("x") * density).toInt()
        val fullTop = (value.optDouble("y") * density).toInt()
        val left = (value.optDouble("clipX") * density).toInt().coerceIn(0, web.width)
        val top = (value.optDouble("clipY") * density).toInt().coerceIn(0, web.height)
        val width = (value.optDouble("clipWidth") * density).toInt().coerceIn(0, web.width - left)
        val height = (value.optDouble("clipHeight") * density).toInt().coerceIn(0, web.height - top)
        entry.holder.layoutParams = FrameLayout.LayoutParams(width, height).apply { leftMargin = webPosition[0] - rootPosition[0] + left; topMargin = webPosition[1] - rootPosition[1] + top }
        entry.view.layoutParams = FrameLayout.LayoutParams((value.optDouble("width") * density).toInt().coerceIn(0, web.width * 2), (value.optDouble("height") * density).toInt().coerceIn(0, web.height * 2)).apply { leftMargin = fullLeft - left; topMargin = fullTop - top }
    }
    private fun bind(entry: Entry) {
        val track = resolve(entry.value.optString("userId"), entry.value.optString("leaseId"), entry.value.optBoolean("local"))
        if (track === entry.track) return
        entry.detach?.invoke(); entry.detach = null; entry.track = track; ready(entry.id, false)
        val first = AtomicBoolean(false)
        val sink = VideoSink { frame -> entry.view.onFrame(frame); if (first.compareAndSet(false, true)) activity.runOnUiThread { if (entries[entry.id] === entry) ready(entry.id, true) } }
        when (track) {
            is VideoTrack -> { track.addSink(sink); entry.detach = { track.removeSink(sink) } }
            is LiveVideoTrack -> { track.addRenderer(sink); entry.detach = { track.removeRenderer(sink) } }
        }
    }
    fun refresh() { entries.values.toList().forEach { bind(it) } }
    fun remove(id: String) { entries.remove(id)?.let { it.detach?.invoke(); (it.holder.parent as? ViewGroup)?.removeView(it.holder); it.view.release() } }
    fun clear() { entries.keys.toList().forEach { remove(it) } }
    fun visibility(value: Boolean) { visible = value; if (!value) clear() }
}
