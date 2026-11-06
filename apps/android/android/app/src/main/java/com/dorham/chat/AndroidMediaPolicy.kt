package com.dorham.chat

import java.nio.ByteBuffer

internal object AndroidMediaPolicy {
    fun shouldSubscribe(source: String, lease: String?, watched: Set<String>, audio: Boolean): Boolean = source == "MICROPHONE" || (lease != null && lease in watched && (source == "SCREEN_SHARE" || (source == "SCREEN_SHARE_AUDIO" && audio)))
    fun eraseInput(buffer: ByteBuffer, bytes: Int) { require(bytes >= 0 && bytes <= buffer.capacity()); for (index in 0 until bytes) buffer.put(index, 0.toByte()); buffer.position(0) }
    fun captureSize(longEdge: Int, displayWidth: Int, displayHeight: Int): Pair<Int, Int> {
        require(displayWidth > 0 && displayHeight > 0)
        val bound = minOf(longEdge.coerceIn(160, 1920), maxOf(displayWidth, displayHeight)) / 2 * 2
        val short = maxOf(2, (bound.toDouble() * minOf(displayWidth, displayHeight) / maxOf(displayWidth, displayHeight)).toInt() / 2 * 2)
        return if (displayWidth <= displayHeight) short to bound else bound to short
    }
}
