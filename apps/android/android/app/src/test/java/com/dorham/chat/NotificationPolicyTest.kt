package com.dorham.chat
import org.junit.Assert.*
import org.junit.Test
class NotificationPolicyTest {
    @Test fun cooldownIsSeparateForEachChatAndEndsAtFifteenSeconds() {
        val previous = mapOf("chat-a" to 1000L)
        assertFalse(NotificationPolicy.shouldAlert("chat-a", emptySet(), previous, 15999L))
        assertTrue(NotificationPolicy.shouldAlert("chat-a", emptySet(), previous, 16000L))
        assertTrue(NotificationPolicy.shouldAlert("chat-b", emptySet(), previous, 1001L))
        assertTrue(NotificationPolicy.shouldAlert("chat-a", emptySet(), previous, 500L))
    }
    @Test fun muteIsPerChatAndDoesNotExpireUntilRemoved() {
        val muted = setOf("chat-a")
        assertFalse(NotificationPolicy.shouldAlert("chat-a", muted, emptyMap(), Long.MAX_VALUE))
        assertTrue(NotificationPolicy.shouldAlert("chat-b", muted, emptyMap(), 1000L))
        assertTrue(NotificationPolicy.shouldAlert("chat-a", emptySet(), emptyMap(), 1000L))
    }
    @Test fun sessionGuardAcceptsAndroidJsonIntegersWithoutLossOrMissingValues() {
        assertEquals(0L, NotificationPolicy.sessionGeneration(0))
        assertEquals(17L, NotificationPolicy.sessionGeneration(17))
        assertEquals(2147483648L, NotificationPolicy.sessionGeneration(2147483648L))
        assertEquals(9L, NotificationPolicy.sessionGeneration(9.0))
        for (invalid in listOf(null, "0", -1, 0.5, Double.NaN, Double.POSITIVE_INFINITY, 9007199254740992L)) {
            assertThrows(IllegalArgumentException::class.java) { NotificationPolicy.sessionGeneration(invalid) }
        }
    }
    @Test fun credentialsStayOnExactHttpsOrigin() {
        assertEquals("https://dorhamapp.ir", NotificationPolicy.origin("https://dorhamapp.ir/"))
        for (invalid in listOf("http://dorhamapp.ir", "https://user@dorhamapp.ir", "https://dorhamapp.ir/path", "https://dorhamapp.ir?token=x", "https://dorhamapp.ir#x", "https://dorhamapp.ir:99999")) {
            assertThrows(Exception::class.java) { NotificationPolicy.origin(invalid) }
        }
    }
    @Test fun replayLedgerIsBoundedAndKeepsRecentMessages() {
        var ledger = emptyList<String>()
        for (id in 0..299) ledger = NotificationPolicy.remember(ledger, id.toString())
        assertEquals(256, ledger.size); assertFalse("0" in ledger); assertTrue("299" in ledger)
        ledger = NotificationPolicy.remember(ledger, "299")
        assertEquals(256, ledger.size); assertEquals(1, ledger.count { it == "299" })
    }
    @Test fun offlineRetriesBackOffWithoutGrowingForever() {
        assertEquals(1000L, NotificationPolicy.retryMillis(0))
        assertEquals(8000L, NotificationPolicy.retryMillis(3))
        assertEquals(60000L, NotificationPolicy.retryMillis(Int.MAX_VALUE))
        assertFalse(NotificationPolicy.identifier("x/../../")); assertTrue(NotificationPolicy.identifier("valid_uuid-1"))
    }
}
