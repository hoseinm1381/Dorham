package com.dorham.chat

import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test

class AndroidMediaPolicyTest {
    @Test fun onlySelectedLiveScreenSourcesAreSubscribed() {
        val selected = setOf("live")
        assertTrue(AndroidMediaPolicy.shouldSubscribe("MICROPHONE", null, selected, false))
        assertTrue(AndroidMediaPolicy.shouldSubscribe("SCREEN_SHARE", "live", selected, false))
        assertTrue(AndroidMediaPolicy.shouldSubscribe("SCREEN_SHARE_AUDIO", "live", selected, true))
        assertFalse(AndroidMediaPolicy.shouldSubscribe("SCREEN_SHARE_AUDIO", "live", selected, false))
        assertFalse(AndroidMediaPolicy.shouldSubscribe("SCREEN_SHARE_AUDIO", "ended", selected, true))
        assertFalse(AndroidMediaPolicy.shouldSubscribe("SCREEN_SHARE", "live", emptySet(), true))
        assertFalse(AndroidMediaPolicy.shouldSubscribe("CAMERA", "live", selected, true))
    }
    @Test fun shortCaptureReadsCannotLeakMicrophoneOrPreviousAudio() {
        val bytes = ByteBuffer.allocateDirect(960)
        for (index in 0 until bytes.capacity()) bytes.put(index, 91)
        AndroidMediaPolicy.eraseInput(bytes, 960)
        // Model a short playback read after the privacy boundary erased the microphone buffer.
        bytes.put(0, 12); bytes.put(1, 34)
        assertEquals(12, bytes.get(0).toInt()); assertEquals(34, bytes.get(1).toInt())
        for (index in 2 until bytes.capacity()) assertEquals(0, bytes.get(index).toInt())
        AndroidMediaPolicy.eraseInput(bytes, 960)
        for (index in 0 until bytes.capacity()) assertEquals(0, bytes.get(index).toInt())
    }
    @Test fun capturePreservesPocoAspectAndEvenBoundedDimensions() {
        assertEquals(576 to 1280, AndroidMediaPolicy.captureSize(1280,1080,2400))
        assertEquals(1280 to 576, AndroidMediaPolicy.captureSize(1280,2400,1080))
        assertEquals(720 to 1280, AndroidMediaPolicy.captureSize(1280,1080,1920))
        assertEquals(854 to 384, AndroidMediaPolicy.captureSize(854,2400,1080))
    }
}
